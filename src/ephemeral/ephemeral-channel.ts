/**
 * @file ephemeral-channel.ts
 * @description 覆盖层通道 (OverlayChannel 的 Leafer 实现)：选中框、框选区域、参考线等绘制在内容层之上
 *
 * 设计考量 (Why):
 * 1. 0 DOM 残留：框选蚂蚁线、吸附对齐参考线、选中框统一走场景树顶层，淘汰 DOM div；
 * 2. 按会话隔离：持久图元 (选中框) 随状态更新；瞬态图元 (框选、参考线) 在失焦或 Esc 时兜底清除，
 *    交互被打断时不残留，同时不误清仍然有效的选中框；
 * 3. 就地复用：同一会话的图元按位置与类型就地更新，拖拽中逐帧刷新不反复创建对象。
 */

import type { CanvasPrimitive, OverlayChannel, OverlayOptions } from '@skynote/core';
import type { Group } from 'leafer';
import { reconcileLeaferShapes } from '../primitives/primitive-mapper';
import type { EphemeralSession } from '../types';

export class EphemeralChannel implements OverlayChannel {
  private readonly sessions = new Map<string, EphemeralSession>();
  private readonly transientSessions = new Set<string>();

  constructor(
    private readonly containerGroup: Group,
    private readonly dpr = 1
  ) {}

  /**
   * 为指定会话声明式设置图元 (就地复用或更新)；空数组即清除该会话
   * @param sessionId 交互会话唯一标识 (例如 'selection:outline', 'selection:marquee')
   */
  setPrimitives(sessionId: string, primitives: readonly CanvasPrimitive[], options?: OverlayOptions): void {
    if (primitives.length === 0) {
      this.clear(sessionId);
      return;
    }
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { sessionId, shapes: [] };
      this.sessions.set(sessionId, session);
    }
    if (options?.transient) this.transientSessions.add(sessionId);
    else this.transientSessions.delete(sessionId);
    session.shapes = reconcileLeaferShapes(this.containerGroup, session.shapes, [...primitives], this.dpr);
  }

  clear(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const shape of session.shapes) shape.remove();
    this.sessions.delete(sessionId);
    this.transientSessions.delete(sessionId);
  }

  /** 兜底守护：清除全部瞬态会话 (失焦、Esc)，持久会话保留 */
  clearTransient(): void {
    for (const sessionId of [...this.transientSessions]) this.clear(sessionId);
  }

  destroy(): void {
    for (const sessionId of [...this.sessions.keys()]) this.clear(sessionId);
  }
}
