/**
 * @file leafer-overlay.ts
 * @description 覆盖层通道的 Leafer 实现：选中框、框选区域、参考线画在内容层之上
 *
 * 设计考量 (Why):
 * 1. 按会话隔离：每个会话一个分组，图元按位置对齐时只在本会话内计算下标，不受其他会话影响；
 *    持久图元 (选中框) 随状态更新，瞬态图元 (框选、参考线) 在失焦或 Esc 时兜底清除。
 * 2. 就地复用：同一会话的图元按位置与类型就地更新，拖拽中逐帧刷新不反复创建对象。
 */

import type { CanvasPrimitive, OverlayChannel, OverlayOptions } from '@skynote/core';
import { Group } from 'leafer';
import type { LeaferShape } from '../types';
import type { PrimitiveMapper } from '../primitives/primitive-mapper';

interface OverlaySession {
  readonly group: Group;
  shapes: LeaferShape[];
  transient: boolean;
}

export class LeaferOverlay implements OverlayChannel {
  private readonly sessions = new Map<string, OverlaySession>();

  constructor(
    private readonly layer: Group,
    private readonly mapper: PrimitiveMapper
  ) {}

  /** 空数组即清除该会话 */
  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void {
    if (primitives.length === 0) {
      this.clear(sessionId);
      return;
    }
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { group: new Group(), shapes: [], transient: false };
      this.layer.add(session.group);
      this.sessions.set(sessionId, session);
    }
    session.transient = options?.transient ?? false;
    session.shapes = this.mapper.reconcile(session.group, session.shapes, primitives);
  }

  clear(sessionId: string): void {
    this.sessions.get(sessionId)?.group.destroy();
    this.sessions.delete(sessionId);
  }

  /** 清除全部瞬态会话 (失焦、Esc)，持久会话保留 */
  clearTransient(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.transient) this.clear(sessionId);
    }
  }

  destroy(): void {
    for (const sessionId of [...this.sessions.keys()]) this.clear(sessionId);
  }
}
