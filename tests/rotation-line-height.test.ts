import './setup';
import { describe, it, expect } from 'vitest';
import type { Text } from 'leafer';
import { SkyNoteEngine } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';
import { createLeaferRenderer } from '../src/leafer-renderer';
import { createLeaferShapeFromPrimitive } from '../src/primitives/primitive-mapper';

function mount(engine: SkyNoteEngine) {
  const renderer = createLeaferRenderer(engine);
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 1000 });
  Object.defineProperty(container, 'clientHeight', { value: 800 });
  renderer.mount(container);
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

    const group = renderer.getContentLayer()!.children[0];
    const leaferBounds = group.getBounds('box', 'local');
    const coreBounds = engine.getNodeWorldBounds(node.id)!;
    expect(leaferBounds.x).toBeCloseTo(coreBounds.left);
    expect(leaferBounds.y).toBeCloseTo(coreBounds.top);
    expect(leaferBounds.width).toBeCloseTo(coreBounds.width);
    expect(leaferBounds.height).toBeCloseTo(coreBounds.height);
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

    expect(renderer.hitTest({ x: bounds.left + 2, y: bounds.top + 2 })).toBeUndefined();
    expect(renderer.hitTest({ x: 200, y: 150 })?.id).toBe('n');
    renderer.destroy();
  });
});

describe('行高单位映射', () => {
  it('数字按字号倍数、px 字符串按像素，两种写法等价时排版高度一致', () => {
    const base = { kind: 'text' as const, x: 0, y: 0, text: 'a b c d e f g h', width: 30, fontSize: 10 };
    const ratio = createLeaferShapeFromPrimitive({ ...base, lineHeight: 2 }) as Text;
    const pixels = createLeaferShapeFromPrimitive({ ...base, lineHeight: '20px' }) as Text;

    expect(ratio.lineHeight).toEqual({ type: 'percent', value: 2 });
    expect(pixels.lineHeight).toBe(20);
    expect(ratio.getBounds('box', 'inner').height).toBe(pixels.getBounds('box', 'inner').height);
  });
});
