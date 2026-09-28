/**
 * @file host-bridge.ts
 * @description 宿主网关与输入事件桥接实现 (DOMHostBridge)
 * 
 * 遵守 AGENTS.md 准则：
 * 1. 平台中立边界：此文件为面向浏览器 DOM 容器的专用桥接器，Core 不感知具体 DOM；
 * 2. 坐标归一化：DOM 原生事件解算为视口与世界逻辑坐标，挂载 claimPointer 独占裁判；
 * 3. 资源成对销毁：destroy() 彻底卸载所有事件监听，无任何残留。
 */

import type {
  IHostBridge,
  SystemCursor,
  CanvasPointerEvent,
  CanvasWheelEvent,
  SkyNoteEngine,
  Point,
  NodeEntity
} from '@skynote/core';
import { screenToWorld, type ViewportState } from '../viewport/viewport-transform';

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

  constructor(options: HostBridgeOptions) {
    this.container = options.container;
    this.engine = options.engine;
    this.getViewport = options.getViewport;
    this.hitTest = options.hitTest;
    this.onInteractionChange = options.onInteractionChange;

    this.bindDomEvents();
  }

  getViewportRect(): { width: number; height: number } {
    const rect = this.container.getBoundingClientRect();
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
  }

  private bindDomEvents(): void {
    const { signal } = this.abortController;

    this.container.addEventListener('pointerdown', this.handlePointerDown, { signal });
    this.container.addEventListener('pointermove', this.handlePointerMove, { signal });
    this.container.addEventListener('pointerup', this.handlePointerUp, { signal });
    this.container.addEventListener('pointercancel', this.handlePointerCancel, { signal });
    this.container.addEventListener('wheel', this.handleWheel, { signal, passive: false });
  }

  private toCanvasPointerEvent(e: PointerEvent): CanvasPointerEvent {
    const rect = this.container.getBoundingClientRect();
    const clientPoint: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };

    const viewport = this.getViewport();
    const worldPoint = screenToWorld(clientPoint, viewport);
    const target = this.hitTest ? this.hitTest(worldPoint) : undefined;

    let isClaimed = false;
    let isStopped = false;

    return {
      point: worldPoint,
      clientPoint,
      target,
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
        isStopped = true;
        e.stopPropagation();
      }
    };
  }

  private handlePointerDown = (e: PointerEvent): void => {
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

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.container.getBoundingClientRect();
    const clientPoint: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };

    const viewport = this.getViewport();
    const centerPoint = screenToWorld(clientPoint, viewport);

    const isZoom = e.ctrlKey || e.metaKey;
    const deltaZoom = isZoom ? -e.deltaY * 0.002 : 0;
    const deltaPan: Point = isZoom
      ? { x: 0, y: 0 }
      : { x: -e.deltaX, y: -e.deltaY };

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
