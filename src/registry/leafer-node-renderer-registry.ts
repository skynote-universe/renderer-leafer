/**
 * @file leafer-node-renderer-registry.ts
 * @description 原生 Leafer 节点渲染器注册表
 *
 * 设计考量 (Why):
 * 1. 原生性能逃生舱：针对极端复杂的商业节点（如思维导图折叠骨架、无限表格网格），
 *    允许直接挂载原生 Leafer 图元，获得原生绘制性能；
 * 2. 弱耦合：注册与注销严格成对，支持插件动态插拔热更新。
 */

import type { NodeEntity, NodeStyle } from '@skynote/core';
import type { LeaferShape, LeaferRenderContext } from '../types';

/** 原生节点生命周期渲染器接口契约 */
export interface LeaferNodeLifecycleRenderer<TData = Record<string, unknown>, TStyle extends NodeStyle = NodeStyle> {
  readonly nodeType: string;
  /** 创建图元树并挂载至父级 Group */
  create(node: NodeEntity<TData, TStyle>, context: LeaferRenderContext): LeaferShape[];
  /** 当节点属性变更时增量更新已有图元 */
  update(shapes: LeaferShape[], node: NodeEntity<TData, TStyle>, context: LeaferRenderContext): void;
  /** 节点从画布卸载时清理资源 */
  destroy?(shapes: LeaferShape[], node: NodeEntity<TData, TStyle>): void;
}

export class LeaferNodeRendererRegistry {
  private readonly renderers = new Map<string, LeaferNodeLifecycleRenderer>();

  register(renderer: LeaferNodeLifecycleRenderer): () => void {
    const { nodeType } = renderer;
    if (!nodeType) {
      throw new Error('[LeaferNodeRendererRegistry] 注册失败：缺少有效 nodeType 字段');
    }

    this.renderers.set(nodeType, renderer);
    return () => {
      if (this.renderers.get(nodeType) === renderer) {
        this.renderers.delete(nodeType);
      }
    };
  }

  get(nodeType: string): LeaferNodeLifecycleRenderer | undefined {
    return this.renderers.get(nodeType);
  }

  has(nodeType: string): boolean {
    return this.renderers.has(nodeType);
  }

  clear(): void {
    this.renderers.clear();
  }
}
