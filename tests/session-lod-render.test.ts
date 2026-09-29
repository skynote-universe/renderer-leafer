import './setup';
import { describe, it, expect, vi } from 'vitest';
import { Rect } from 'leafer';
import { SkyNoteEngine } from '@skynote/core';
import type { NodeEntity, ConnectorEntity } from '@skynote/core';
import { createLeaferRenderer, type LeaferRenderer } from '../src/leafer-renderer';
import type { LeaferRenderContext } from '../src/types';

function makeNode(id: string, x: number, nodeType = 'rect'): NodeEntity {
  return { id, type: 'node', nodeType, x, y: 0, width: 50, height: 50, rotation: 0, zIndex: 1, locked: false };
}

function mountRenderer(engine: SkyNoteEngine): LeaferRenderer {
  const renderer = createLeaferRenderer(engine);
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 1000 });
  Object.defineProperty(container, 'clientHeight', { value: 800 });
  renderer.mount(container);
  return renderer;
}

describe('LeaferRenderer 会话状态、选中态重绘与 LOD', () => {
  it('视口以引擎会话为唯一事实源：渲染器平移写入会话，会话变化立即驱动变换矩阵', () => {
    const engine = new SkyNoteEngine();
    const renderer = mountRenderer(engine);

    renderer.setViewport({ x: 120, zoom: 2 });
    expect(engine.session.viewport).toEqual({ x: 120, y: 0, zoom: 2 });

    engine.session.setViewport({ y: -40 });
    expect(renderer.getViewport()).toEqual({ x: 120, y: -40, zoom: 2 });
    const sceneGroup = renderer.getContentLayer()!.parent!;
    expect(sceneGroup.y).toBe(-40);
    expect(sceneGroup.scaleX).toBe(2);
    renderer.destroy();
  });

  it('选中态翻转只重建受影响节点的内容', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('a', 0, 'probe'));
    engine.documentStore.addNode(makeNode('b', 100, 'probe'));
    const renderer = mountRenderer(engine);

    const updates: string[] = [];
    renderer.nodeRenderers.register({
      nodeType: 'probe',
      create: (node) => [new Rect({ width: node.width, height: node.height })],
      update: (_shapes, node, context: LeaferRenderContext) => {
        updates.push(`${node.id}:${context.selectedNodeIds.has(node.id)}`);
      }
    });
    // 注册前已用兜底矩形渲染过，改数据触发一次原生渲染器接管
    engine.documentStore.updateNode('a', { locked: true });
    engine.documentStore.updateNode('b', { locked: true });
    renderer.renderFrame();
    updates.length = 0;

    engine.session.setSelection({ nodeIds: ['a'] });
    renderer.renderFrame();
    expect(updates).toEqual(['a:true']);

    renderer.renderFrame();
    expect(updates).toEqual(['a:true']);
    renderer.destroy();
  });

  it('缩放低于 30% 时节点降级为占位块、低于 12% 时不绘制连线，放大后恢复完整内容', async () => {
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
    const composeSpy = vi.fn((node: NodeEntity) => [
      { kind: 'rect' as const, x: 0, y: 0, width: node.width, height: node.height, fill: '#fff' }
    ]);
    engine.nodeTypes.register({ type: 'rect', compose: composeSpy } as never);
    engine.documentStore.updateNode('a', { locked: true });

    const renderer = mountRenderer(engine);
    const contentLayer = renderer.getContentLayer()!;
    expect(contentLayer.children.length).toBe(3);

    composeSpy.mockClear();
    renderer.setViewport({ zoom: 0.2 });
    renderer.renderFrame();
    expect(renderer.getLodLevel()).toBe('reduced');
    engine.documentStore.updateNode('a', { locked: false });
    renderer.renderFrame();
    // 占位档位跳过 compose
    expect(composeSpy).not.toHaveBeenCalled();
    expect(contentLayer.children.length).toBe(3);

    renderer.setViewport({ zoom: 0.05 });
    renderer.renderFrame();
    expect(renderer.getLodLevel()).toBe('minimal');
    expect(contentLayer.children.length).toBe(2);

    // 放大后经过回升迟滞自动补帧恢复完整内容，无需额外交互
    renderer.setViewport({ zoom: 1 });
    renderer.renderFrame();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(renderer.getLodLevel()).toBe('full');
    expect(composeSpy).toHaveBeenCalled();
    expect(contentLayer.children.length).toBe(3);
    renderer.destroy();
  });

  it('单个节点渲染抛错时局部降级为占位框，不影响其他节点，也不会每帧重复抛错', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode(makeNode('bad', 0, 'broken'));
    engine.documentStore.addNode(makeNode('good', 100));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    engine.nodeTypes.register({
      type: 'broken',
      compose: () => {
        throw new Error('compose 故障');
      }
    } as never);

    const renderer = mountRenderer(engine);
    expect(renderer.getContentLayer()!.children.length).toBe(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    engine.documentStore.moveNode('good', { x: 1 });
    renderer.renderFrame();
    renderer.renderFrame();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // 数据变化后重试
    engine.documentStore.updateNode('bad', { locked: true });
    renderer.renderFrame();
    expect(errorSpy).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    renderer.destroy();
  });
});
