import './setup';
import { describe, it, expect } from 'vitest';
import { SkyNoteEngine, createCanvasWheelEvent } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';
import { createLeaferRenderer } from '../src/leafer-renderer';

function mount(engine: SkyNoteEngine) {
  const renderer = createLeaferRenderer(engine, { enableFrameScheduler: false });
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 1000 });
  Object.defineProperty(container, 'clientHeight', { value: 800 });
  renderer.mount(container);
  return renderer;
}

function node(id: string, x: number, y: number, width: number, height: number): NodeEntity {
  return { id, type: 'node', nodeType: 'rect', x, y, width, height, rotation: 0, zIndex: 'a0', locked: false };
}

describe('视口控制', () => {
  it('zoomToFit 让全部内容居中容纳在视口内，内容很少时不超过原始尺寸，空画布回到原点', () => {
    const engine = new SkyNoteEngine();
    const renderer = mount(engine);

    engine.session.setViewport({ x: 300, y: -200, zoom: 3 });
    renderer.zoomToFit();
    expect(engine.session.viewport).toEqual({ x: 0, y: 0, zoom: 1 });

    engine.documentStore.addNode(node('a', 0, 0, 4000, 1000));
    engine.documentStore.addNode(node('b', 3000, 1500, 1000, 500));
    renderer.zoomToFit({ padding: 100 });
    const { x, y, zoom } = engine.session.viewport;
    // 内容 4000 x 2000，可用区域 800 x 600
    expect(zoom).toBeCloseTo(0.2);
    expect(x + 2000 * zoom).toBeCloseTo(500);
    expect(y + 1000 * zoom).toBeCloseTo(400);

    engine.documentStore.removeNodes(['a', 'b']);
    engine.documentStore.addNode(node('small', 0, 0, 10, 10));
    renderer.zoomToFit();
    expect(engine.session.viewport.zoom).toBe(1);
    renderer.destroy();
  });

  it('zoomBy 以视口中心为不动点；滚轮缩放受会话缩放范围约束', () => {
    const engine = new SkyNoteEngine({ zoomRange: { min: 0.5, max: 2 } });
    const renderer = mount(engine);

    renderer.zoomBy(2);
    const { x, y, zoom } = engine.session.viewport;
    expect(zoom).toBe(2);
    // 视口中心 (500, 400) 对应的世界点 (500, 400) 屏幕位置不变
    expect(500 * zoom + x).toBeCloseTo(500);
    expect(400 * zoom + y).toBeCloseTo(400);

    // 快速滚轮的巨大增量既不会得到负倍率，也不会越过范围
    engine.pointer.dispatchWheel(createCanvasWheelEvent({ centerPoint: { x: 0, y: 0 }, deltaZoom: -50 }));
    expect(engine.session.viewport.zoom).toBe(0.5);
    renderer.destroy();
  });
});
