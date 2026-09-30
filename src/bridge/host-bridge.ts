/**
 * @file host-bridge.ts
 * @description 浏览器宿主桥：DOM 输入 → 归一化画布事件，并向引擎提供宿主能力 (CanvasHost)
 *
 * 遵守 AGENTS.md 准则：
 * 1. 平台中立边界：此文件为面向浏览器 DOM 容器的专用桥接器，Core 不感知具体 DOM；
 * 2. 坐标归一化：DOM 原生事件解算为视口与世界逻辑坐标，挂载 claimPointer 独占裁判；
 * 3. 资源成对销毁：destroy() 卸载所有事件监听，无任何残留。
 * 4. 键盘经容器焦点进入 ADR-005 焦点栈：画布容器可聚焦、按下指针时获得焦点，只在画布持有焦点时响应快捷键；
 *    来自输入框与可编辑区域 (含 mountDOM 嵌入的编辑器) 的按键不转发，避免打字时误触删除等快捷键；
 *    画布文字编辑的隐藏输入通道例外，它的编辑按键正是交给键盘作用域处理的 (ADR-122)。
 * 5. 高频事件零强制布局：容器矩形缓存复用，仅在尺寸变化、页面滚动或新手势开始时刷新，
 *    避免 pointermove 每次调用 getBoundingClientRect 触发同步重排；命中拾取延迟到首次读取 target 时才计算。
 * 6. 按帧合并高频输入：120Hz / 240Hz 设备一帧内会收到多次 pointermove 与滚轮，逐个分发会让拖拽在一帧内提交多次事务。
 *    移动只保留每个指针的最新一次，滚轮位移累加，在渲染器本帧开始时统一冲刷 (与渲染同帧，不增加延迟)；
 *    按下、抬起、取消前先冲刷该指针待分发的移动，保证事件顺序。
 */

import type {
  CanvasHost,
  CanvasKeyboardEvent,
  OverlayChannel,
  Point,
  SkyNoteEngine,
  SystemCursor,
  TextInputHandler,
  TextInputSession
} from '@skynote/core';
import { ClickCounter, SyntheticPointerEvent, SyntheticWheelEvent, screenToWorld } from '@skynote/core';
import { DOMTextInput, TEXT_INPUT_ATTRIBUTE } from './dom-text-input';

/** 事件是否来自原生可编辑元素 (这些按键属于文本输入，不是画布快捷键)；画布自己的隐藏输入通道除外 */
function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  if (element.hasAttribute(TEXT_INPUT_ATTRIBUTE)) return false;
  return (
    element.isContentEditable ||
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT'
  );
}

/** 一帧内累加的滚轮输入 (同一种手势：平移或缩放) */
interface PendingWheel {
  deltaX: number;
  deltaY: number;
  latest: WheelEvent;
}

/** 滚轮位移统一为像素：Firefox 等以行或页为单位上报 */
const WHEEL_LINE_HEIGHT = 16;

export interface HostBridgeOptions {
  container: HTMLElement;
  engine: SkyNoteEngine;
  /** 覆盖层 (由渲染器提供)，随宿主能力一并交给引擎 */
  overlay: OverlayChannel;
  /** 申请下一帧：渲染器在帧开始时调用 flushPendingInput 冲刷合并后的输入 */
  requestFrame: () => void;
  /** 指针按下 / 抬起时通知 (渲染器据此调整 LOD) */
  onInteractionChange: (isInteracting: boolean) => void;
}

export class DOMHostBridge implements CanvasHost {
  readonly overlay: OverlayChannel;
  private readonly container: HTMLElement;
  private readonly engine: SkyNoteEngine;
  private readonly requestFrame: () => void;
  private readonly onInteractionChange: (isInteracting: boolean) => void;
  private readonly abortController = new AbortController();
  private pendingMoves = new Map<number, PointerEvent>();
  /** 键为是否缩放手势：平移与缩放各自累加，同帧内先后发生时分别分发 */
  private pendingWheels = new Map<boolean, PendingWheel>();
  private containerRect: DOMRect | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly clicks = new ClickCounter();
  /** 按下时的连击序号，移动与抬起沿用 */
  private clickCount = 1;
  private textInput: DOMTextInput | null = null;

  constructor(options: HostBridgeOptions) {
    this.overlay = options.overlay;
    this.container = options.container;
    this.engine = options.engine;
    this.requestFrame = options.requestFrame;
    this.onInteractionChange = options.onInteractionChange;
    this.bindDomEvents();
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

  openTextInput(handler: TextInputHandler): TextInputSession {
    this.textInput?.close();
    this.textInput = new DOMTextInput(this.container, handler, (session) => {
      if (this.textInput === session) this.textInput = null;
    });
    return this.textInput;
  }

  /** 分发本帧合并后的指针移动与滚轮 (由渲染器在帧开始时调用) */
  flushPendingInput(): void {
    if (this.pendingMoves.size > 0) {
      const moves = this.pendingMoves;
      this.pendingMoves = new Map();
      for (const e of moves.values()) {
        this.engine.pointer.dispatchPointerMove(this.toCanvasPointerEvent(e));
      }
    }
    if (this.pendingWheels.size > 0) {
      const wheels = this.pendingWheels;
      this.pendingWheels = new Map();
      for (const [isZoom, wheel] of wheels) this.dispatchWheel(isZoom, wheel);
    }
  }

  destroy(): void {
    this.textInput?.close();
    this.pendingMoves.clear();
    this.pendingWheels.clear();
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
    // 失焦后 keyup 不会到达：切走窗口或焦点移出画布时通知焦点栈复位按键状态 (如按住的空格)
    window.addEventListener('blur', this.handleBlur, { signal });
    this.container.addEventListener('blur', this.handleBlur, { signal });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.invalidateContainerRect);
      this.resizeObserver.observe(this.container);
    }
  }

  private toCanvasPointerEvent(e: PointerEvent): SyntheticPointerEvent {
    const rect = this.getContainerRect();
    const clientPoint: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const point = screenToWorld(clientPoint, this.engine.session.viewport);
    return new SyntheticPointerEvent({
      point,
      clientPoint,
      pointerId: e.pointerId,
      button: e.button,
      modifiers: { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey },
      pressure: e.pressure || 0.5,
      clickCount: this.clickCount,
      // 命中拾取延迟到首次读取 target (多数移动监听者不读)
      resolveTarget: () => this.engine.hitTestNode(point),
      onStopPropagation: () => e.stopPropagation()
    });
  }

  /** 按下、抬起、取消前先分发该指针待合并的移动，保证下游看到的事件顺序与真实顺序一致 */
  private flushPointerMove(pointerId: number): void {
    const pending = this.pendingMoves.get(pointerId);
    if (!pending) return;
    this.pendingMoves.delete(pointerId);
    this.engine.pointer.dispatchPointerMove(this.toCanvasPointerEvent(pending));
  }

  private handlePointerDown = (e: PointerEvent): void => {
    this.flushPointerMove(e.pointerId);
    // 新手势开始时兜底刷新一次，覆盖 CSS transform 等观察器无法感知的位移
    this.containerRect = null;
    // 点在画布上即获得键盘焦点；点在嵌入的可编辑区域时让其保留焦点
    if (!this.textInput && !isEditableTarget(e.target)) {
      this.container.focus({ preventScroll: true });
    }
    this.onInteractionChange(true);
    const rect = this.getContainerRect();
    this.clickCount = this.clicks.press({ x: e.clientX - rect.left, y: e.clientY - rect.top }, e.button, e.timeStamp);
    const canvasEvent = this.toCanvasPointerEvent(e);
    this.engine.pointer.dispatchPointerDown(canvasEvent);
    // 文字编辑中 (含本次按下刚进入编辑)：焦点须留在输入通道，阻止默认行为使随后的兼容 mousedown 不把焦点抢回容器
    if (this.textInput) e.preventDefault();
  };

  private handlePointerMove = (e: PointerEvent): void => {
    this.pendingMoves.set(e.pointerId, e);
    this.requestFrame();
  };

  private handlePointerUp = (e: PointerEvent): void => {
    this.flushPointerMove(e.pointerId);
    this.onInteractionChange(false);
    const canvasEvent = this.toCanvasPointerEvent(e);
    this.engine.pointer.dispatchPointerUp(canvasEvent);
  };

  private handlePointerCancel = (e: PointerEvent): void => {
    this.flushPointerMove(e.pointerId);
    this.onInteractionChange(false);
    this.engine.pointer.dispatchPointerCancel(this.toCanvasPointerEvent(e));
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

  private handleBlur = (): void => {
    this.engine.inputScopes.dispatchBlur();
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (isEditableTarget(e.target)) return;
    this.engine.inputScopes.dispatchKeyUp(this.toCanvasKeyboardEvent(e));
  };

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? WHEEL_LINE_HEIGHT : e.deltaMode === 2 ? this.getContainerRect().height : 1;
    const isZoom = e.ctrlKey || e.metaKey;
    const pending = this.pendingWheels.get(isZoom);
    if (pending) {
      pending.deltaX += e.deltaX * unit;
      pending.deltaY += e.deltaY * unit;
      pending.latest = e;
    } else {
      this.pendingWheels.set(isZoom, { deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, latest: e });
    }
    this.requestFrame();
  };

  private dispatchWheel(isZoom: boolean, wheel: PendingWheel): void {
    const rect = this.getContainerRect();
    const clientPoint: Point = {
      x: wheel.latest.clientX - rect.left,
      y: wheel.latest.clientY - rect.top
    };
    this.engine.pointer.dispatchWheel(
      new SyntheticWheelEvent({
        centerPoint: screenToWorld(clientPoint, this.engine.session.viewport),
        deltaPan: isZoom ? { x: 0, y: 0 } : { x: -wheel.deltaX, y: -wheel.deltaY },
        // 对数刻度：累加后取指数即为各次缩放倍率之积，合并与否结果一致
        deltaZoom: isZoom ? -wheel.deltaY * 0.002 : 0,
        isGesture: wheel.latest.ctrlKey,
        onStopPropagation: () => wheel.latest.stopPropagation()
      })
    );
  }
}
