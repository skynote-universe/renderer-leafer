import './setup';
import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';

function mount(engine: SkyNoteEngine) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 1000 });
  Object.defineProperty(container, 'clientHeight', { value: 800 });
  const renderer = new LeaferRenderer(engine, container);
  return renderer;
}

describe('旋转约定在渲染层的落地', () => {
  it('节点图元绕中心旋转，场景树包围盒与内核外接矩形一致', () => {
    const engine = new SkyNoteEngine();
    const node: NodeEntity = {
      id: 'n',
      type: 'node',
      nodeType: 'rect',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      rotation: 90,
      zIndex: 'a0',
      locked: false
    };
    engine.documentStore.addNode(node);
    const renderer = mount(engine);

    const group = renderer.contentLayer.children[0];
    const leaferBounds = group.getBounds('box', 'local');
    const coreBounds = engine.getNodeWorldBounds(node.id)!;
    expect(leaferBounds.x).toBeCloseTo(coreBounds.left);
    expect(leaferBounds.y).toBeCloseTo(coreBounds.top);
    expect(leaferBounds.width).toBeCloseTo(coreBounds.right - coreBounds.left);
    expect(leaferBounds.height).toBeCloseTo(coreBounds.bottom - coreBounds.top);
    renderer.destroy();
  });

  it('点选按旋转后的实际框精判：外接矩形的空角不命中', () => {
    const engine = new SkyNoteEngine();
    engine.documentStore.addNode({
      id: 'n',
      type: 'node',
      nodeType: 'rect',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      rotation: 45,
      zIndex: 'a0',
      locked: false
    });
    const renderer = mount(engine);
    const bounds = engine.spatialIndex.getBounds('n')!;

    expect(engine.hitTestNode({ x: bounds.left + 2, y: bounds.top + 2 })).toBeUndefined();
    expect(engine.hitTestNode({ x: 200, y: 150 })?.id).toBe('n');
    renderer.destroy();
  });
});
