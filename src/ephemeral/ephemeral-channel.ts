/**
 * @file ephemeral-channel.ts
 * @description GPU 顶层瞬态图元渲染通道 (Ephemeral Channel)
 *
 * 设计考量 (Why):
 * 1. 0 DOM 残留：框选蚂蚁线、吸附对齐参考线、临时拖拽幽灵框，统一走此 GPU 顶层通道，彻底淘汰 DOM div；
 * 2. 自动兜底守护：支持按会话隔离 (sessionId)，失焦、Esc 或操作结束时自动一键清空，根绝幽灵残留；
 * 3. 极限性能：内部采用图元复用池，毫秒级快速更新。
 */

import type { CanvasPrimitive } from '@skynote/core';
import type { Group } from 'leafer';
import { reconcileLeaferShapes } from '../primitives/primitive-mapper';
import type { EphemeralSession } from '../types';

export class EphemeralChannel {
  private readonly containerGroup: Group;
  private readonly sessions = new Map<string, EphemeralSession>();
  private readonly dpr: number;

  constructor(containerGroup: Group, dpr = 1) {
    this.containerGroup = containerGroup;
    this.dpr = dpr;
  }

  /**
   * 为指定会话声明式塞入瞬态图元 (就地复用或更新)
   * @param sessionId 交互会话唯一标识 (例如 'interaction:marquee', 'interaction:snapping')
   * @param primitives 声明式图元描述
   */
  setPrimitives(sessionId: string, primitives: CanvasPrimitive[]): void {
    if (primitives.length === 0) {
      this.clearSession(sessionId);
      return;
    }

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        shapes: []
      };
      this.sessions.set(sessionId, session);
    }

    // 就地复用图元更新
    session.shapes = reconcileLeaferShapes(this.containerGroup, session.shapes, primitives, this.dpr);
  }

  /**
   * 清理指定会话的所有瞬态图元
   */
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.shapes.forEach((shape) => shape.remove());
      this.sessions.delete(sessionId);
    }
  }

  /**
   * 兜底守护：一键清空所有会话与图元 (通常在 Esc、失去焦点或画布销毁时触发)
   */
  clearAll(): void {
    this.sessions.forEach((session) => {
      session.shapes.forEach((shape) => shape.remove());
    });
    this.sessions.clear();
  }

  /**
   * 销毁通道
   */
  destroy(): void {
    this.clearAll();
  }
}
