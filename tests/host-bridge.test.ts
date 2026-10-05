import './setup';
import { describe, it, expect, vi } from 'vitest';
import { DETACHED_CANVAS_HOST, SkyNoteEngine } from '@skynote/core';
import type { CanvasPointerEvent, NodeEntity } from '@skynote/core';
import { TEXT_INPUT_ATTRIBUTE } from '../src/bridge/dom-text-input';
import { DOMHostBridge } from '../src/bridge/host-bridge';

/** 最小化容器替身：记录监听函数与 getBoundingClientRect 调用次数 */
class FakeContainer {
  rectCalls = 0;
  focusCalls = 0;
  tabIndex = -1;
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<string, (e: unknown) => void>();

  hasAttribute(): boolean {
    return false;
  }

  focus(): void {
    this.focusCalls++;
  }

  addEventListener(type: string, handler: (e: unknown) => void): void {
    this.listeners.set(type, handler);
  }

  getBoundingClientRect(): DOMRect {
    this.rectCalls++;
    return { left: 10, top: 20, width: 800, height: 600 } as DOMRect;
  }

  /** 以最小事件对象触发已注册的监听 */
  fire(type: string, init: Record<string, unknown>): void {
    this.listeners.get(type)!({
      clientX: 0,
      clientY: 0,
      pointerId: 1,
      button: 0,
      target: null,
      stopPropagation: () => {},
      preventDefault: () => {},
      ...init
    });
  }
}

describe('DOMHostBridge 高频指针事件', () => {
  it('pointermove 复用缓存的容器矩形，新手势开始时才刷新', () => {
    const engine = new SkyNoteEngine();
    const container = new FakeContainer();
    const bridge = new DOMHostBridge({
      container: container as unknown as HTMLElement,
      engine,
      overlay: DETACHED_CANVAS_HOST.overlay,
      onInteractionChange: () => {},
      requestFrame: () => {}
    });

    const points: CanvasPointerEvent['point'][] = [];
    engine.pointer.register('probe', { onPointerMove: (e) => points.push(e.point) });

    container.fire('pointerdown', { clientX: 10, clientY: 20 });
    for (let i = 0; i < 50; i++) {
      container.fire('pointermove', { clientX: 10 + i, clientY: 20 });
      bridge.flushPendingInput();
    }
    expect(container.rectCalls).toBe(1);
    expect(points[49]).toEqual({ x: 49, y: 0 });

    container.fire('pointerdown', { clientX: 10, clientY: 20 });
    expect(container.rectCalls).toBe(2);
    bridge.destroy();
  });

  it('命中拾取延迟到首次读取 target 时计算，且同一事件只计算一次', () => {
    const engine = new SkyNoteEngine();
    const container = new FakeContainer();
    let hitCalls = 0;
    const node = { id: 'a' } as NodeEntity;
    const bridge = new DOMHostBridge({
      container: container as unknown as HTMLElement,
      engine,
      overlay: DETACHED_CANVAS_HOST.overlay,
      onInteractionChange: () => {},
      requestFrame: () => {}
    });
    vi.spyOn(engine, 'hitTestNode').mockImplementation(() => {
      hitCalls++;
      return node;
    });

    engine.pointer.register('ignores-target', { onPointerMove: () => {} });
    container.fire('pointermove', {});
    bridge.flushPendingInput();
    expect(hitCalls).toBe(0);

    const seen: (NodeEntity | undefined)[] = [];
    engine.pointer.register('reads-target', {
      onPointerMove: (e) => {
        seen.push(e.target, e.target);
      }
    });
    container.fire('pointermove', {});
    bridge.flushPendingInput();
    expect(hitCalls).toBe(1);
    expect(seen).toEqual([node, node]);
    bridge.destroy();
  });

  it('键盘经容器焦点进入焦点栈：容器可聚焦、按下指针时获焦，来自可编辑元素的按键不转发 (画布文字输入通道除外)', () => {
    const engine = new SkyNoteEngine();
    const container = new FakeContainer();
    const bridge = new DOMHostBridge({
      container: container as unknown as HTMLElement,
      engine,
      overlay: DETACHED_CANVAS_HOST.overlay,
      onInteractionChange: () => {},
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

    container.fire('pointerdown', {});
    expect(container.focusCalls).toBe(1);
    /** 替身元素：attribute 为画布文字输入通道的标记时视为该通道 */
    const element = (tagName: string, isContentEditable = false, attribute?: string) => ({
      tagName,
      isContentEditable,
      hasAttribute: (name: string) => name === attribute
    });
    container.fire('pointerdown', { target: element('TEXTAREA') });
    expect(container.focusCalls).toBe(1);

    container.fire('keydown', { key: 'Delete', code: 'Delete', isComposing: false });
    container.fire('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      target: element('INPUT')
    });
    container.fire('keydown', { key: 'a', code: 'KeyA', target: element('DIV', true) });
    container.fire('keydown', { key: 'Process', code: 'KeyN', isComposing: true });
    container.fire('keydown', {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      isComposing: false,
      target: element('TEXTAREA', false, TEXT_INPUT_ATTRIBUTE)
    });
    expect(keys).toEqual(['Delete', 'ArrowLeft']);
    bridge.destroy();
  });
});

describe('DOMHostBridge 按帧合并输入', () => {
  function setup() {
    const engine = new SkyNoteEngine();
    const container = new FakeContainer();
    let frameRequests = 0;
    const bridge = new DOMHostBridge({
      container: container as unknown as HTMLElement,
      engine,
      overlay: DETACHED_CANVAS_HOST.overlay,
      onInteractionChange: () => {},
      requestFrame: () => frameRequests++
    });
    return { engine, container, bridge, frames: () => frameRequests };
  }

  it('一帧内多次 pointermove 只分发每个指针的最新一次，并申请渲染帧', () => {
    const { engine, container, bridge, frames } = setup();
    const moves: string[] = [];
    engine.pointer.register('probe', { onPointerMove: (e) => moves.push(`${e.pointerId}@${e.point.x}`) });

    for (let i = 1; i <= 4; i++) container.fire('pointermove', { pointerId: 1, clientX: 10 + i * 10, clientY: 20 });
    container.fire('pointermove', { pointerId: 2, clientX: 110, clientY: 20 });
    expect(moves).toEqual([]);
    expect(frames()).toBeGreaterThan(0);

    bridge.flushPendingInput();
    expect(moves).toEqual(['1@40', '2@100']);
    bridge.flushPendingInput();
    expect(moves).toHaveLength(2);
    bridge.destroy();
  });

  it('按下、抬起、取消前先分发该指针待合并的移动，事件顺序与真实顺序一致', () => {
    const { engine, container, bridge } = setup();
    const events: string[] = [];
    engine.pointer.register('probe', {
      onPointerMove: (e) => events.push(`move@${e.point.x}`),
      onPointerUp: (e) => events.push(`up@${e.point.x}`),
      onPointerCancel: () => events.push('cancel')
    });

    container.fire('pointermove', { clientX: 60, clientY: 20 });
    container.fire('pointerup', { clientX: 60, clientY: 20 });
    container.fire('pointermove', { clientX: 90, clientY: 20 });
    container.fire('pointercancel', { clientX: 90, clientY: 20 });
    expect(events).toEqual(['move@50', 'up@50', 'move@80', 'cancel']);
    bridge.destroy();
  });

  it('滚轮按手势累加：行单位换算为像素，缩放增量为对数刻度可直接相加', () => {
    const { engine, container, bridge } = setup();
    const wheels: { pan: { x: number; y: number }; zoom: number }[] = [];
    engine.pointer.register('probe', { onWheel: (e) => wheels.push({ pan: e.deltaPan, zoom: e.deltaZoom }) });

    container.fire('wheel', { deltaX: 0, deltaY: 3, deltaMode: 1 });
    container.fire('wheel', { deltaX: 5, deltaY: 2, deltaMode: 0 });
    container.fire('wheel', { deltaX: 0, deltaY: -50, deltaMode: 0, ctrlKey: true });
    container.fire('wheel', { deltaX: 0, deltaY: -50, deltaMode: 0, ctrlKey: true });
    expect(wheels).toEqual([]);

    bridge.flushPendingInput();
    expect(wheels).toHaveLength(2);
    expect(wheels[0].pan).toEqual({ x: -5, y: -50 });
    expect(wheels[1].zoom).toBeCloseTo(0.2);
    bridge.destroy();
  });

  it('setCursor: rotate 与 rotate-xxx 会映射为 SVG Data URI 形式的单弧旋转光标', () => {
    const { container, bridge } = setup();
    bridge.setCursor('rotate');
    expect(container.style.cursor).toContain('data:image/svg+xml');
    expect(container.style.cursor).toContain('16 16, crosshair');

    bridge.setCursor('rotate-45');
    expect(decodeURIComponent(container.style.cursor)).toContain('rotate(45 16 16)');

    bridge.setCursor('default');
    expect(container.style.cursor).toBe('default');
    bridge.destroy();
  });
});
