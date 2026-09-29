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
      getViewport: () => ({ x: 0, y: 0, zoom: 1 })
    });

    const points: CanvasPointerEvent['point'][] = [];
    engine.pointer.register('probe', { onPointerMove: (e) => points.push(e.point) });

    fire('pointerdown', { clientX: 10, clientY: 20 });
    for (let i = 0; i < 50; i++) fire('pointermove', { clientX: 10 + i, clientY: 20 });
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
      hitTest: () => {
        hitCalls++;
        return node;
      }
    });

    engine.pointer.register('ignores-target', { onPointerMove: () => {} });
    fire('pointermove', {});
    expect(hitCalls).toBe(0);

    const seen: (NodeEntity | undefined)[] = [];
    engine.pointer.register('reads-target', {
      onPointerMove: (e) => {
        seen.push(e.target, e.target);
      }
    });
    fire('pointermove', {});
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
      getViewport: () => ({ x: 0, y: 0, zoom: 1 })
    });
    expect(container.tabIndex).toBe(0);

    const keys: string[] = [];
    engine.inputScopes.pushScope({ id: 'probe', priority: 0, onKeyDown: (e) => { keys.push(e.key); } });

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

