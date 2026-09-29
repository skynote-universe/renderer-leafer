import './setup';
import { describe, it, expect, vi } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import { Rect, Line } from 'leafer';
import type { NodeEntity, ConnectorEntity } from '@skynote/core';
import { createLeaferRenderer, type LeaferRenderer } from '../src/leafer-renderer';

function makeNode(id: string, x: number, extra?: Partial<NodeEntity>): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x,
    y: 0,
    width: 50,
    height: 50,
    rotation: 0,
    zIndex: 1,
    locked: false,
    ...extra
  };
}

function mountRenderer(engine: SkyNoteEngine, options?: Parameters<typeof createLeaferRenderer>[1]): LeaferRenderer {
  const renderer = createLeaferRenderer(engine, options);
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 1000 });
  Object.defineProperty(container, 'clientHeight', { value: 800 });
  renderer.mount(container);
  return renderer;
}

describe('LeaferRenderer 增量渲染', () => {
  it('同一帧内的多次提交只触发一次渲染', async () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('a', 0));
    const renderer = mountRenderer(engine);
    const renderSpy = vi.spyOn(renderer, 'renderFrame');

    for (let i = 0; i < 10; i++) {
      engine.documentStore.moveNode('a', { x: 1 }, { groupId: 'drag' });
    }
    expect(renderSpy).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(renderSpy).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it('只挂载视锥内实体，平移后离屏图元摘除、新进入视野的图元挂载', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('near', 0));
    engine.documentStore.addNode(makeNode('far', 10000));
    const renderer = mountRenderer(engine);
    const contentLayer = renderer.getContentLayer()!;

    expect(contentLayer.children.length).toBe(1);
    const nearGroup = contentLayer.children[0];

    renderer.setViewport({ x: -9800 });
    renderer.renderFrame();
    expect(contentLayer.children.length).toBe(1);
    expect(contentLayer.children[0]).not.toBe(nearGroup);

    // 回到原位时复用缓存的图元，而不是重新创建
    renderer.setViewport({ x: 0 });
    renderer.renderFrame();
    expect(contentLayer.children).toEqual([nearGroup]);
    renderer.destroy();
  });

  it('删除节点后下一帧销毁图元，撤销后重新创建', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('a', 0));
    const renderer = mountRenderer(engine);
    const contentLayer = renderer.getContentLayer()!;
    const originalGroup = contentLayer.children[0];

    engine.documentStore.removeNode('a');
    renderer.renderFrame();
    expect(contentLayer.children.length).toBe(0);

    engine.documentStore.undo();
    renderer.renderFrame();
    expect(contentLayer.children.length).toBe(1);
    expect(contentLayer.children[0]).not.toBe(originalGroup);
    renderer.destroy();
  });

  it('重叠节点拾取按层级取最上层，而非空间索引返回顺序', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('top', 0, { zIndex: 5 }));
    engine.documentStore.addNode(makeNode('bottom', 0, { zIndex: 1 }));
    const renderer = mountRenderer(engine);

    expect(renderer.hitTest({ x: 10, y: 10 })?.id).toBe('top');

    engine.documentStore.updateNode('bottom', { zIndex: 9 });
    expect(renderer.hitTest({ x: 10, y: 10 })?.id).toBe('bottom');
    renderer.destroy();
  });

  it('连线经空间索引粗筛拾取，离屏连线不参与渲染', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('a', 0));
    engine.documentStore.addNode(makeNode('b', 300));
    const connector: ConnectorEntity = {
      id: 'c1',
      type: 'connector',
      connectorType: 'straight',
      from: { nodeId: 'a' },
      to: { nodeId: 'b' },
      zIndex: 0,
      locked: false
    };
    engine.documentStore.commit({ patches: [{ op: 'set', path: ['content', 'connectors', 'c1'], value: connector }] });
    const renderer = mountRenderer(engine);

    expect(renderer.hitTestConnector({ x: 175, y: 25 })?.id).toBe('c1');
    expect(renderer.hitTestConnector({ x: 175, y: 400 })).toBeUndefined();

    const contentLayer = renderer.getContentLayer()!;
    renderer.setViewport({ y: -5000 });
    renderer.renderFrame();
    expect(contentLayer.children.length).toBe(0);
    renderer.destroy();
  });

  it('离屏缓存按 LRU 限额淘汰：平移浏览时缓存规模有上限，最近离开的回到视野时复用，被淘汰的重建并成对 destroy', () => {
    const engine = new SkyNoteEngine();
    // 10 个节点横向排开，每屏 (1000px 宽 + 100px 缓冲) 只容纳 1 个
    for (let i = 0; i < 10; i++) {
      engine.documentStore.addNode(makeNode(`n${i}`, i * 2000, { nodeType: 'probe' }));
    }
    const renderer = mountRenderer(engine, { offscreenCacheLimit: 2 });
    const destroyed: string[] = [];
    renderer.nodeRenderers.register({
      nodeType: 'probe',
      create: (node) => [new Rect({ width: node.width, height: node.height })],
      update: () => {},
      destroy: (_shapes, node) => destroyed.push(node.id)
    });
    const cacheSize = () => (renderer as unknown as { nodeCaches: Map<string, unknown> }).nodeCaches.size;
    const contentLayer = renderer.getContentLayer()!;
    const panTo = (index: number) => {
      renderer.setViewport({ x: -index * 2000 });
      renderer.renderFrame();
    };

    // 已用兜底矩形渲染的 n0 在注册原生渲染器后不会被 destroy 记录，从 n1 起观察
    panTo(1);
    const n1Group = contentLayer.children[0];
    for (let i = 2; i < 10; i++) {
      panTo(i);
      expect(cacheSize()).toBeLessThanOrEqual(1 + 2);
    }
    expect(destroyed).toContain('n1');

    // n8 刚离开视野仍在缓存中：回到视野时复用同一图元
    panTo(8);
    const n8Group = contentLayer.children[0];
    panTo(9);
    panTo(8);
    expect(contentLayer.children[0]).toBe(n8Group);

    // n1 早已被淘汰：回到视野时重建
    panTo(1);
    expect(contentLayer.children[0]).not.toBe(n1Group);
    renderer.destroy();
  });

  it('连线按引擎路由绘制：路由器晚注册后下一帧重绘，仅绕行段进入视口的连线同样可见', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('a', 0));
    engine.documentStore.addNode(makeNode('b', 300));
    const connector: ConnectorEntity = {
      id: 'c1',
      type: 'connector',
      connectorType: 'detour',
      from: { nodeId: 'a' },
      to: { nodeId: 'b' },
      zIndex: 0,
      locked: false
    };
    engine.documentStore.commit({ patches: [{ op: 'set', path: ['content', 'connectors', 'c1'], value: connector }] });
    const renderer = mountRenderer(engine);
    const contentLayer = renderer.getContentLayer()!;
    const linePoints = (): number[] => {
      for (const child of contentLayer.children) {
        const line = (child as unknown as { children?: unknown[] }).children?.find((shape) => shape instanceof Line);
        if (line) return (line as InstanceType<typeof Line>).points as number[];
      }
      throw new Error('未找到连线图元');
    };

    // 未注册 detour 时回退直线：2 个点
    expect(linePoints()).toHaveLength(4);

    engine.routers.register({
      id: 'detour',
      label: '绕行',
      route: ({ startPoint, endPoint }) => ({
        points: [startPoint, { x: startPoint.x, y: 5000 }, { x: endPoint.x, y: 5000 }, endPoint]
      })
    });
    renderer.renderFrame();
    expect(linePoints()).toHaveLength(8);

    // 视口只覆盖绕行的水平段 (y≈5000)，两端节点均在视口外
    renderer.setViewport({ x: 0, y: -4800 });
    renderer.renderFrame();
    expect(contentLayer.children).toHaveLength(1);
    renderer.destroy();
  });
});

