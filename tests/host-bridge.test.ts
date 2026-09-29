import './setup';
import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import type { CanvasPointerEvent, NodeEntity } from '@skynote/core';
import { DOMHostBridge } from '../src/bridge/host-bridge';

/** 最小化容器替身：记录监听函数与 getBoundingClientRect 调用次数 */
function createFakeContainer() {
  const listeners = new Map<string, (e: unknown) => void>();
  const container = {
    rectCalls: 0,
    focusCalls: 0,
    tabIndex: -1,
    style: {} as Record<string, string>,
    hasAttribute: () => false,
    focus() {
      this.focusCalls++;
    },
    addEventListener: (type: string, handler: (e: unknown) => void) => listeners.set(type, handler),
    getBoundingClientRect() {
      this.rectCalls++;
      return { left: 10, top: 20, width: 800, height: 600 } as DOMRect;
    }
  };
  const fire = (type: string, init: Record<string, unknown>) =>
    listeners.get(type)!({
      clientX: 0,
      clientY: 0,
      pointerId: 1,
      button: 0,
      target: null,
      stopPropagation: () => {},
      preventDefault: () => {},
      ...init
    });
  return { container, fire };
}

describe('DOMHostBridge 高频指针事件', () => {
  it('pointermove 复用缓存的容器矩形，新手势开始时才刷新', () => {
    const engine = new SkyNoteEngine();
    const { container, fire } = createFakeContainer();
    const bridge = new DOMHostBridge({
      container: container as unknown as HTMLElement,
      engine,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      requestFrame: () => {}
    });

    const points: CanvasPointerEvent['point'][] = [];
    engine.pointer.register('probe', { onPointerMove: (e) => points.push(e.point) });

    fire('pointerdown', { clientX: 10, clientY: 20 });
    for (let i = 0; i < 50; i++) {
      fire('pointermove', { clientX: 10 + i, clientY: 20 });
      bridge.flushPendingInput();
    }
    expect(container.rectCalls).toBe(1);
    expect(points[49]).toEqual({ x: 49, y: 0 });

    fire('pointerdown', { clientX: 10, clientY: 20 });
    expect(container.rectCalls).toBe(2);
    bridge.destroy();
  });

  it('命中拾取延迟到首次读取 target 时计算，且同一事件只计算一次', () => {
    const engine = new SkyNoteEngine();
    const { container, fire } = createFakeContainer();
    let hitCalls = 0;
    const node = { id: 'a' } as NodeEntity;
    const bridge = new DOMHostBridge({
      container: container as unknown as HTMLElement,
      engine,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      requestFrame: () => {},
      hitTest: () => {
        hitCalls++;
        return node;
      }
    });

    engine.pointer.register('ignores-target', { onPointerMove: () => {} });
    fire('pointermove', {});
    bridge.flushPendingInput();
    expect(hitCalls).toBe(0);

    const seen: (NodeEntity | undefined)[] = [];
    engine.pointer.register('reads-target', {
      onPointerMove: (e) => {
        seen.push(e.target, e.target);
      }
    });
    fire('pointermove', {});
    bridge.flushPendingInput();
    expect(hitCalls).toBe(1);
    expect(seen).toEqual([node, node]);
    bridge.destroy();
  });

  it('键盘经容器焦点进入焦点栈：容器可聚焦、按下指针时获焦，来自可编辑元素的按键不转发', () => {
    const engine = new SkyNoteEngine();
    const { container, fire } = createFakeContainer();
    const bridge = new DOMHostBridge({
      container: container as unknown as HTMLElement,
      engine,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      requestFrame: () => {}
    });
    expect(container.tabIndex).toBe(0);

    const keys: string[] = [];
    engine.inputScopes.pushScope({
      id: 'probe',
      priority: 0,
      onKeyDown: (e) => {
        keys.push(e.key);
      }
    });

    fire('pointerdown', {});
    expect(container.focusCalls).toBe(1);
    fire('pointerdown', { target: { tagName: 'TEXTAREA', isContentEditable: false } });
    expect(container.focusCalls).toBe(1);

    fire('keydown', { key: 'Delete', code: 'Delete', isComposing: false });
    fire('keydown', { key: 'Backspace', code: 'Backspace', target: { tagName: 'INPUT', isContentEditable: false } });
    fire('keydown', { key: 'a', code: 'KeyA', target: { tagName: 'DIV', isContentEditable: true } });
    fire('keydown', { key: 'Process', code: 'KeyN', isComposing: true });
    expect(keys).toEqual(['Delete']);
    bridge.destroy();
  });
});

describe('DOMHostBridge 按帧合并输入', () => {
  function setup() {
    const engine = new SkyNoteEngine();
    const { container, fire } = createFakeContainer();
    let frameRequests = 0;
    const bridge = new DOMHostBridge({
      container: container as unknown as HTMLElement,
      engine,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      requestFrame: () => frameRequests++
    });
    return { engine, fire, bridge, frames: () => frameRequests };
  }

  it('一帧内多次 pointermove 只分发每个指针的最新一次，并申请渲染帧', () => {
    const { engine, fire, bridge, frames } = setup();
    const moves: string[] = [];
    engine.pointer.register('probe', { onPointerMove: (e) => moves.push(`${e.pointerId}@${e.point.x}`) });

    for (let i = 1; i <= 4; i++) fire('pointermove', { pointerId: 1, clientX: 10 + i * 10, clientY: 20 });
    fire('pointermove', { pointerId: 2, clientX: 110, clientY: 20 });
    expect(moves).toEqual([]);
    expect(frames()).toBeGreaterThan(0);

    bridge.flushPendingInput();
    expect(moves).toEqual(['1@40', '2@100']);
    bridge.flushPendingInput();
    expect(moves).toHaveLength(2);
    bridge.destroy();
  });

  it('按下、抬起、取消前先分发该指针待合并的移动，事件顺序与真实顺序一致', () => {
    const { engine, fire, bridge } = setup();
    const events: string[] = [];
    engine.pointer.register('probe', {
      onPointerMove: (e) => events.push(`move@${e.point.x}`),
      onPointerUp: (e) => events.push(`up@${e.point.x}`),
      onPointerCancel: () => events.push('cancel')
    });

    fire('pointermove', { clientX: 60, clientY: 20 });
    fire('pointerup', { clientX: 60, clientY: 20 });
    fire('pointermove', { clientX: 90, clientY: 20 });
    fire('pointercancel', { clientX: 90, clientY: 20 });
    expect(events).toEqual(['move@50', 'up@50', 'move@80', 'cancel']);
    bridge.destroy();
  });

  it('滚轮按手势累加：行单位换算为像素，缩放增量为对数刻度可直接相加', () => {
    const { engine, fire, bridge } = setup();
    const wheels: { pan: { x: number; y: number }; zoom: number }[] = [];
    engine.pointer.register('probe', { onWheel: (e) => wheels.push({ pan: e.deltaPan, zoom: e.deltaZoom }) });

    fire('wheel', { deltaX: 0, deltaY: 3, deltaMode: 1 });
    fire('wheel', { deltaX: 5, deltaY: 2, deltaMode: 0 });
    fire('wheel', { deltaX: 0, deltaY: -50, deltaMode: 0, ctrlKey: true });
    fire('wheel', { deltaX: 0, deltaY: -50, deltaMode: 0, ctrlKey: true });
    expect(wheels).toEqual([]);

    bridge.flushPendingInput();
    expect(wheels).toHaveLength(2);
    expect(wheels[0].pan).toEqual({ x: -5, y: -50 });
    expect(wheels[1].zoom).toBeCloseTo(0.2);
    bridge.destroy();
  });
});
