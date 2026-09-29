import './setup';
import { describe, it, expect, vi } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
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

function mountRenderer(engine: SkyNoteEngine): LeaferRenderer {
  const renderer = createLeaferRenderer(engine);
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
});
