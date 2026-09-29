/**
 * @file host-bridge.ts
 * @description 宿主网关与输入事件桥接实现 (DOMHostBridge)
 *
 * 遵守 AGENTS.md 准则：
 * 1. 平台中立边界：此文件为面向浏览器 DOM 容器的专用桥接器，Core 不感知具体 DOM；
 * 2. 坐标归一化：DOM 原生事件解算为视口与世界逻辑坐标，挂载 claimPointer 独占裁判；
 * 3. 资源成对销毁：destroy() 彻底卸载所有事件监听，无任何残留。
 * 4. 键盘经容器焦点进入 ADR-005 焦点栈：画布容器可聚焦、按下指针时获得焦点，只在画布持有焦点时响应快捷键；
 *    来自输入框与可编辑区域 (含 mountDOM 嵌入的编辑器) 的按键不转发，避免打字时误触删除等快捷键。
 * 5. 高频事件零强制布局：容器矩形缓存复用，仅在尺寸变化、页面滚动或新手势开始时刷新，
 *    避免 pointermove 每次调用 getBoundingClientRect 触发同步重排；命中拾取延迟到首次读取 target 时才计算。
 */

import type {
  IHostBridge,
  SystemCursor,
  CanvasPointerEvent,
  CanvasWheelEvent,
  CanvasKeyboardEvent,
  SkyNoteEngine,
  Point,
  NodeEntity
} from '@skynote/core';
import { screenToWorld, type ViewportState } from '../viewport/viewport-transform';

/** 事件是否来自原生可编辑元素 (这些按键属于文本输入，不是画布快捷键) */
function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  return (
    element.isContentEditable ||
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT'
  );
}

export interface HostBridgeOptions {
  container: HTMLElement;
  engine: SkyNoteEngine;
  getViewport: () => ViewportState;
  hitTest?: (point: Point) => NodeEntity | undefined;
  onInteractionChange?: (isInteracting: boolean) => void;
}

export class DOMHostBridge implements IHostBridge {
  private readonly container: HTMLElement;
  private readonly engine: SkyNoteEngine;
  private readonly getViewport: () => ViewportState;
  private readonly hitTest?: (point: Point) => NodeEntity | undefined;
  private readonly onInteractionChange?: (isInteracting: boolean) => void;
  private readonly abortController = new AbortController();
  private containerRect: DOMRect | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: HostBridgeOptions) {
    this.container = options.container;
    this.engine = options.engine;
    this.getViewport = options.getViewport;
    this.hitTest = options.hitTest;
    this.onInteractionChange = options.onInteractionChange;

    this.bindDomEvents();
  }

  getViewportRect(): { width: number; height: number } {
    const rect = this.getContainerRect();
    return { width: rect.width, height: rect.height };
  }

  setCursor(cursor: SystemCursor): void {
    this.container.style.cursor = cursor;
  }

  capturePointer(pointerId: number): void {
    try {
      this.container.setPointerCapture(pointerId);
    } catch {
      // 容错：在某些非标准事件或已释放时静默忽略
    }
  }

  releasePointer(pointerId: number): void {
    try {
      if (this.container.hasPointerCapture(pointerId)) {
        this.container.releasePointerCapture(pointerId);
      }
    } catch {
      // 静默容错
    }
  }

  destroy(): void {
    this.abortController.abort();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private getContainerRect(): DOMRect {
    if (!this.containerRect) {
      this.containerRect = this.container.getBoundingClientRect();
    }
    return this.containerRect;
  }

  private invalidateContainerRect = (): void => {
    this.containerRect = null;
  };

  private bindDomEvents(): void {
    const { signal } = this.abortController;

    this.container.addEventListener('pointerdown', this.handlePointerDown, { signal });
    this.container.addEventListener('pointermove', this.handlePointerMove, { signal });
    this.container.addEventListener('pointerup', this.handlePointerUp, { signal });
    this.container.addEventListener('pointercancel', this.handlePointerCancel, { signal });
    this.container.addEventListener('wheel', this.handleWheel, { signal, passive: false });
    this.container.addEventListener('keydown', this.handleKeyDown, { signal });
    this.container.addEventListener('keyup', this.handleKeyUp, { signal });
    // 容器默认不可聚焦，补齐 tabindex 才能接收键盘事件；宿主已显式设置时尊重其配置
    if (!this.container.hasAttribute('tabindex')) {
      this.container.tabIndex = 0;
    }

    // 任一祖先滚动或窗口尺寸变化都会让容器的视口位置失效
    window.addEventListener('scroll', this.invalidateContainerRect, { signal, capture: true, passive: true });
    window.addEventListener('resize', this.invalidateContainerRect, { signal, passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.invalidateContainerRect);
      this.resizeObserver.observe(this.container);
    }
  }

  private toCanvasPointerEvent(e: PointerEvent): CanvasPointerEvent {
    const rect = this.getContainerRect();
    const clientPoint: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };

    const worldPoint = screenToWorld(clientPoint, this.getViewport());
    const hitTest = this.hitTest;
    let target: NodeEntity | undefined;
    let isTargetResolved = false;
    let isClaimed = false;

    return {
      point: worldPoint,
      clientPoint,
      get target() {
        if (!isTargetResolved) {
          target = hitTest?.(worldPoint);
          isTargetResolved = true;
        }
        return target;
      },
      pointerId: e.pointerId,
      button: e.button,
      modifiers: {
        shift: e.shiftKey,
        alt: e.altKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey
      },
      pressure: e.pressure || 0.5,
      get isClaimed() {
        return isClaimed;
      },
      claimPointer: (_claimerId: string) => {
        isClaimed = true;
      },
      stopPropagation: () => {
        e.stopPropagation();
      }
    };
  }

  private handlePointerDown = (e: PointerEvent): void => {
    // 新手势开始时兜底刷新一次，覆盖 CSS transform 等观察器无法感知的位移
    this.containerRect = null;
    // 点在画布上即获得键盘焦点；点在嵌入的可编辑区域时让其保留焦点
    if (!isEditableTarget(e.target)) {
      this.container.focus({ preventScroll: true });
    }
    this.onInteractionChange?.(true);
    const canvasEvent = this.toCanvasPointerEvent(e);
    this.engine.pointer.dispatchPointerDown(canvasEvent);
  };

  private handlePointerMove = (e: PointerEvent): void => {
    const canvasEvent = this.toCanvasPointerEvent(e);
    this.engine.pointer.dispatchPointerMove(canvasEvent);
  };

  private handlePointerUp = (e: PointerEvent): void => {
    this.onInteractionChange?.(false);
    const canvasEvent = this.toCanvasPointerEvent(e);
    this.engine.pointer.dispatchPointerUp(canvasEvent);
  };

  private handlePointerCancel = (_e: PointerEvent): void => {
    this.onInteractionChange?.(false);
  };

  private toCanvasKeyboardEvent(e: KeyboardEvent): CanvasKeyboardEvent {
    return {
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      isComposing: e.isComposing,
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation()
    };
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (isEditableTarget(e.target)) return;
    this.engine.inputScopes.dispatchKeyDown(this.toCanvasKeyboardEvent(e));
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (isEditableTarget(e.target)) return;
    this.engine.inputScopes.dispatchKeyUp(this.toCanvasKeyboardEvent(e));
  };

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.getContainerRect();
    const clientPoint: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };

    const viewport = this.getViewport();
    const centerPoint = screenToWorld(clientPoint, viewport);

    const isZoom = e.ctrlKey || e.metaKey;
    const deltaZoom = isZoom ? -e.deltaY * 0.002 : 0;
    const deltaPan: Point = isZoom ? { x: 0, y: 0 } : { x: -e.deltaX, y: -e.deltaY };

    const wheelEvent: CanvasWheelEvent = {
      centerPoint,
      deltaPan,
      deltaZoom,
      isGesture: e.ctrlKey,
      stopPropagation: () => e.stopPropagation()
    };

    this.engine.pointer.dispatchWheel(wheelEvent);
  };
}
