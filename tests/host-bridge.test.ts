import './setup';
import { describe, it, expect, vi } from 'vitest';
import { DETACHED_CANVAS_HOST, SkyNoteEngine } from '@skynote/core';
import type { CanvasPointerEvent, NodeEntity } from '@skynote/core';
import { TEXT_INPUT_ATTRIBUTE } from '../src/bridge/dom-text-input';
import { DOMHostBridge } from '../src/bridge/host-bridge';

/** 最小化文档替身：记录剪贴板事件监听与当前焦点 */
class FakeDocument {
  activeElement: unknown = null;
  readonly listeners = new Map<string, (e: unknown) => void>();

  addEventListener(type: string, handler: (e: unknown) => void): void {
    this.listeners.set(type, handler);
  }
}

/** 最小化容器替身：记录监听函数与 getBoundingClientRect 调用次数 */
class FakeContainer {
  readonly ownerDocument = new FakeDocument();
  rectCalls = 0;
  focusCalls = 0;
  tabIndex = -1;
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<string, (e: unknown) => void>();

  hasAttribute(): boolean {
    return false;
  }

  contains(element: unknown): boolean {
    return element === this;
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

  it('setCursor: 光标全部取自注册表的自绘 SVG，带角度的按 5° 取整；未注册的名称当作 CSS 关键字', () => {
    const { container, bridge, engine } = setup();
    const svgOf = () => decodeURIComponent(container.style.cursor);

    // 挂载即为自绘的默认光标
    expect(container.style.cursor).toContain('data:image/svg+xml');
    expect(container.style.cursor).toContain('6 5, default');

    bridge.setCursor({ kind: 'rotate', angle: -134 });
    expect(svgOf()).toContain('rotate(225 16 16)');
    expect(container.style.cursor).toContain('16 16, crosshair');
    bridge.setCursor({ kind: 'resize', angle: 37 });
    expect(svgOf()).toContain('rotate(35 16 16)');

    bridge.setCursor('pointer');
    expect(container.style.cursor).toBe('pointer');

    // 统一配色与覆盖：注册表变化后当前光标立即刷新；恢复后回到内置
    bridge.setCursor('move');
    engine.cursors.setStyle({ ink: 'navy' });
    expect(svgOf()).toContain('fill="navy"');
    const restore = engine.cursors.register({
      id: 'move',
      svg: '<circle cx="16" cy="16" r="6" fill="{ink}"/>',
      hotspot: { x: 16, y: 16 },
      fallback: 'move'
    });
    expect(svgOf()).toContain('<circle');
    restore();
    expect(svgOf()).not.toContain('<circle');
    bridge.destroy();
  });

  it('保留同帧多次 pointermove 与 getCoalescedEvents 的完整采样序列、手写笔 0 压感，以及超限拐点抽稀', () => {
    const { engine, container, bridge } = setup();
    const received: CanvasPointerEvent[] = [];
    engine.pointer.register('brush-probe', {
      onPointerDown: (e) => received.push(e),
      onPointerMove: (e) => received.push(e),
      onPointerUp: (e) => received.push(e)
    });

    // 1. 手写笔轻触按下：pressure = 0 必须原样保留为 0 (不能被 || 0.5 吞掉)
    container.fire('pointerdown', { pointerId: 7, pointerType: 'pen', clientX: 10, clientY: 20, pressure: 0 });
    expect(received).toHaveLength(1);
    expect(received[0].pointerType).toBe('pen');
    expect(received[0].pressure).toBe(0);
    expect(received[0].samples).toEqual([{ point: { x: 0, y: 0 }, clientPoint: { x: 0, y: 0 }, pressure: 0 }]);

    // 2. 同帧内两次 pointermove，其中第一次含 2 个 coalesced 事件，第二次含 1 个事件
    container.fire('pointermove', {
      pointerId: 7,
      pointerType: 'pen',
      clientX: 30,
      clientY: 40,
      pressure: 0.4,
      getCoalescedEvents: () => [
        { clientX: 20, clientY: 30, pressure: 0.2 },
        { clientX: 30, clientY: 40, pressure: 0.4 }
      ]
    });
    container.fire('pointermove', {
      pointerId: 7,
      pointerType: 'pen',
      clientX: 50,
      clientY: 20,
      pressure: 0
    });

    // 抬起前自动先冲刷本帧累积的 3 个采样点
    container.fire('pointerup', { pointerId: 7, pointerType: 'pen', clientX: 50, clientY: 20, pressure: 0 });
    expect(received).toHaveLength(3);
    const moveEvent = received[1];
    expect(moveEvent.pointerType).toBe('pen');
    expect(moveEvent.point).toEqual({ x: 40, y: 0 });
    expect(moveEvent.pressure).toBe(0);
    expect(moveEvent.samples).toEqual([
      { point: { x: 10, y: 10 }, clientPoint: { x: 10, y: 10 }, pressure: 0.2 },
      { point: { x: 20, y: 20 }, clientPoint: { x: 20, y: 20 }, pressure: 0.4 },
      { point: { x: 40, y: 0 }, clientPoint: { x: 40, y: 0 }, pressure: 0 }
    ]);

    // 3. 单帧超过 256 个点时抽稀至 256 点，且保留首点、末点与尖角拐点
    received.length = 0;
    const sharpCornerIndex = 150;
    const hugeCoalesced = Array.from({ length: 320 }, (_, i) => ({
      clientX: 10 + i,
      clientY: i === sharpCornerIndex ? 500 : 20,
      pressure: 0.5
    }));
    container.fire('pointermove', {
      pointerId: 8,
      pointerType: 'pen',
      clientX: 10 + 319,
      clientY: 20,
      pressure: 0.5,
      getCoalescedEvents: () => hugeCoalesced
    });
    bridge.flushPendingInput();
    expect(received).toHaveLength(1);
    const compacted = received[0].samples;
    expect(compacted).toHaveLength(256);
    expect(compacted[0].point).toEqual({ x: 0, y: 0 });
    expect(compacted[compacted.length - 1].point).toEqual({ x: 319, y: 0 });
    expect(compacted.some((s) => s.point.x === sharpCornerIndex && s.point.y === 480)).toBe(true);

    // 4. 窗口失焦 (blur) 时清空尚未冲刷的移动队列，防止恢复焦点后补发陈旧轨迹
    received.length = 0;
    container.fire('pointermove', { pointerId: 8, clientX: 100, clientY: 100 });
    container.fire('blur', {});
    bridge.flushPendingInput();
    expect(received).toHaveLength(0);

    bridge.destroy();
  });
});

describe('DOMHostBridge 剪贴板', () => {
  function setup() {
    const engine = new SkyNoteEngine();
    const container = new FakeContainer();
    const bridge = new DOMHostBridge({
      container: container as unknown as HTMLElement,
      engine,
      overlay: DETACHED_CANVAS_HOST.overlay,
      onInteractionChange: () => {},
      requestFrame: () => {}
    });
    const doc = container.ownerDocument;
    /** 以系统剪贴板替身触发事件，返回写入的数据与是否阻止了默认行为 */
    const fire = (type: string, incoming: Record<string, string> = {}) => {
      const written: Record<string, string> = {};
      let prevented = false;
      doc.listeners.get(type)!({
        type,
        defaultPrevented: false,
        clipboardData: {
          types: Object.keys(incoming),
          getData: (format: string) => incoming[format] ?? '',
          setData: (format: string, value: string) => {
            written[format] = value;
          }
        },
        preventDefault: () => {
          prevented = true;
        }
      });
      return { written, prevented };
    };
    return { engine, container, doc, bridge, fire };
  }

  it('画布持有焦点时复制、粘贴交给内核并阻止默认行为；内核不处理或焦点不在画布时保留默认行为', () => {
    const { engine, container, doc, bridge, fire } = setup();
    const pasted: unknown[] = [];
    const writes = vi.fn();
    engine.clipboard.onWrite(writes);
    engine.clipboard.register({ copy: () => ({ 'text/plain': '节点文字' }), paste: (data) => pasted.push(data) > 0 });

    doc.activeElement = null;
    expect(fire('copy').prevented).toBe(false);

    doc.activeElement = container;
    expect(fire('copy')).toEqual({ written: { 'text/plain': '节点文字' }, prevented: true });
    expect(writes).toHaveBeenCalledExactlyOnceWith({
      operation: 'copy',
      status: 'completed',
      data: { 'text/plain': '节点文字' }
    });
    expect(fire('paste', { 'text/plain': '外部' }).prevented).toBe(true);
    expect(pasted).toEqual([{ 'text/plain': '外部' }]);
    // 剪切没有处理者响应：保留默认行为
    expect(fire('cut').prevented).toBe(false);
    expect(writes).toHaveBeenCalledOnce();
    bridge.destroy();
  });

  it('部分剪贴板写入后出错仍通知保守保护，完全未写入不通知', () => {
    const { engine, container, doc, bridge } = setup();
    doc.activeElement = container;
    engine.clipboard.register({ copy: () => ({ 'application/x-skynote-nodes': 'payload', 'text/plain': 'text' }) });
    const writes = vi.fn();
    engine.clipboard.onWrite(writes);
    let count = 0;
    const trigger = () =>
      doc.listeners.get('copy')!({
        type: 'copy',
        defaultPrevented: false,
        clipboardData: {
          setData: () => {
            if (++count === 2) throw new Error('write failed');
          }
        },
        preventDefault: vi.fn()
      });
    expect(trigger).toThrow('write failed');
    expect(writes).toHaveBeenCalledExactlyOnceWith({
      operation: 'copy',
      status: 'partial',
      data: { 'application/x-skynote-nodes': 'payload', 'text/plain': 'text' }
    });
    count = 1;
    writes.mockClear();
    expect(trigger).toThrow('write failed');
    expect(writes).not.toHaveBeenCalled();
    bridge.destroy();
  });

  it('指针离开画布时先冲刷待合并的移动，再分发离开事件', () => {
    const { engine, container, bridge } = setup();
    const events: string[] = [];
    engine.pointer.register('probe', {
      onPointerMove: () => events.push('move'),
      onPointerLeave: () => events.push('leave')
    });
    container.fire('pointermove', { clientX: 50, clientY: 50 });
    container.fire('pointerleave', { clientX: 60, clientY: 50 });
    expect(events).toEqual(['move', 'leave']);
    bridge.destroy();
  });
});
