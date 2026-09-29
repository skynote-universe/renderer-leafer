/**
 * @file leafer-connector-renderer-registry.ts
 * @description 原生 Leafer 连线渲染器注册表
 */

import type { ConnectorEntity, NodeEntity, Point } from '@skynote/core';
import type { LeaferShape, LeaferRenderContext } from '../types';

/** 连线原生渲染上下文 */
export interface LeaferConnectorRenderContext extends LeaferRenderContext {
  fromNode?: NodeEntity;
  toNode?: NodeEntity;
  computedPoints?: Point[];
}

/**
 * 原生连线生命周期渲染器契约
 * 【尚未接入】连线图层目前统一按引擎路由以默认线型绘制，不会调用 create / update / destroy；
 * 接入时上下文应改为携带 ComputedRoute，而非自行解析端点。
 */
export interface LeaferConnectorLifecycleRenderer {
  readonly connectorType: string;
  create(connector: ConnectorEntity, context: LeaferConnectorRenderContext): LeaferShape[];
  update(shapes: LeaferShape[], connector: ConnectorEntity, context: LeaferConnectorRenderContext): void;
  destroy?(shapes: LeaferShape[], connector: ConnectorEntity): void;
}

export class LeaferConnectorRendererRegistry {
  private readonly renderers = new Map<string, LeaferConnectorLifecycleRenderer>();

  register(renderer: LeaferConnectorLifecycleRenderer): () => void {
    const { connectorType } = renderer;
    if (!connectorType) {
      throw new Error('[LeaferConnectorRendererRegistry] 注册失败：缺少有效 connectorType 字段');
    }

    this.renderers.set(connectorType, renderer);
    return () => {
      if (this.renderers.get(connectorType) === renderer) {
        this.renderers.delete(connectorType);
      }
    };
  }

  get(connectorType: string): LeaferConnectorLifecycleRenderer | undefined {
    return this.renderers.get(connectorType);
  }

  has(connectorType: string): boolean {
    return this.renderers.has(connectorType);
  }

  clear(): void {
    this.renderers.clear();
  }
}
