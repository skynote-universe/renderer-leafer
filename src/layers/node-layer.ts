/**
 * @file node-layer.ts
 * @description 节点图层：维护视锥内节点的 NodeView，挂载到父容器 (ADR-114)，摘除离屏者并按 LRU 淘汰
 */

import type { Group } from 'leafer';
import { isNodeHiddenByOpacity, type SkyNoteEngine } from '@skynote/core';
import type { LayerSyncResult, LeaferRenderContext } from '../types';
import type { LeaferNodeRendererRegistry } from '../registry/leafer-node-renderer-registry';
import type { PrimitiveMapper } from '../primitives/primitive-mapper';
import { NodeView, type NodeRenderDetail, type NodeViewEnvironment } from '../node/node-view';
import { VisibilityTracker } from './visibility-tracker';

export interface NodeLayerOptions {
  contentLayer: Group;
  engine: SkyNoteEngine;
  renderers: LeaferNodeRendererRegistry;
  mapper: PrimitiveMapper;
  offscreenCacheLimit: number;
}

/** 单帧同步的共享参数与累计结果 */
interface NodeFrame {
  readonly context: LeaferRenderContext;
  readonly detail: NodeRenderDetail;
  readonly result: LayerSyncResult;
}

export class NodeLayer {
  private readonly views = new Map<string, NodeView>();
  private readonly assetNodes = new Map<string, Set<string>>();
  private readonly nodeAssets = new Map<string, { version: number; ids: readonly string[] }>();

  invalidateAssets(assetIds: ReadonlySet<string>): void {
    for (const assetId of assetIds)
      for (const id of this.assetNodes.get(assetId) ?? []) this.views.get(id)?.invalidateContent();
  }

  private releaseAssetIndex(id: string): void {
    for (const assetId of this.nodeAssets.get(id)?.ids ?? []) {
      const nodes = this.assetNodes.get(assetId)!;
      nodes.delete(id);
      if (!nodes.size) this.assetNodes.delete(assetId);
    }
    this.nodeAssets.delete(id);
  }
  private readonly visibility: VisibilityTracker;
  private readonly env: NodeViewEnvironment;

  constructor(private readonly options: NodeLayerOptions) {
    this.visibility = new VisibilityTracker(options.offscreenCacheLimit);
    this.env = { nodeTypes: options.engine.nodeTypes, renderers: options.renderers, mapper: options.mapper };
  }

  /** 当前持有的视图数 (含离屏保留) */
  get cacheCount(): number {
    return this.views.size;
  }

  /** 当前挂载在场景中的节点 */
  get shownIds(): ReadonlySet<string> {
    return this.visibility.shownIds;
  }

  getGroup(nodeId: string): Group | undefined {
    return this.views.get(nodeId)?.group;
  }

  /** 已挂载节点的子容器 (连线图层据此挂载两端同在该容器内的连线)；本帧 sync 之后调用 */
  getChildrenContainer(nodeId: string): Group | undefined {
    return this.views.get(nodeId)?.children;
  }

  /**
   * 渲染本帧视锥内节点，摘除离开视野者并按 LRU 淘汰超额缓存
   * 可见节点的祖先必须一并挂载 (即使祖先自身不在视锥内)
   * 只对新进入场景的节点计时：已挂载节点多为版本号命中的空转，计入会把单个挂载成本估得虚高
   * @param containerIds 本帧可见连线所需的挂载容器 (须先于连线图层挂载)
   */
  sync(
    visibleIds: readonly string[],
    isCommitted: (id: string) => boolean,
    context: LeaferRenderContext,
    detail: NodeRenderDetail,
    containerIds: Iterable<string>
  ): LayerSyncResult {
    const { entityStore } = this.options.engine;
    const frame: NodeFrame = { context, detail, result: { entered: 0, enterMs: 0, left: 0 } };

    this.visibility.beginFrame();
    for (let i = 0; i < visibleIds.length; i++) {
      const nodeId = visibleIds[i];
      if (!isCommitted(nodeId)) continue;
      const node = entityStore.getNode(nodeId)?.entity;
      if (!node || isNodeHiddenByOpacity(node, this.options.engine.nodeTypes.get(node.nodeType))) continue;
      this.show(nodeId, frame);
    }
    for (const containerId of containerIds) this.show(containerId, frame);
    this.visibility.endFrame(
      (nodeId) => {
        this.views.get(nodeId)?.group.remove();
        frame.result.left++;
      },
      (nodeId) => this.destroy(nodeId)
    );
    return frame.result;
  }

  destroy(nodeId: string): void {
    this.releaseAssetIndex(nodeId);
    this.visibility.forget(nodeId);
    this.views.get(nodeId)?.destroy();
    this.views.delete(nodeId);
  }

  destroyAll(): void {
    for (const nodeId of [...this.views.keys()]) this.destroy(nodeId);
  }

  /** 挂载单个节点 (先递归挂载祖先)；节点不存在时返回 undefined */
  private show(nodeId: string, frame: NodeFrame): NodeView | undefined {
    if (this.visibility.isMarked(nodeId)) return this.views.get(nodeId);
    const runtimeNode = this.options.engine.entityStore.getNode(nodeId);
    if (!runtimeNode) return undefined;

    const node = runtimeNode.entity;
    if (this.nodeAssets.get(nodeId)?.version !== runtimeNode.runtime.dataVersion) {
      this.releaseAssetIndex(nodeId);
      let ids: readonly string[] = [];
      try {
        ids = this.options.engine.nodeTypes.get(node.nodeType)?.assets?.collect(node) ?? [];
      } catch {
        /* 损坏节点由 NodeView 降级；索引不让无效字段中断整帧。 */
      }
      this.nodeAssets.set(nodeId, { version: runtimeNode.runtime.dataVersion, ids });
      for (const assetId of ids) {
        let nodes = this.assetNodes.get(assetId);
        if (!nodes) {
          nodes = new Set();
          this.assetNodes.set(assetId, nodes);
        }
        nodes.add(nodeId);
      }
    }
    const parentView = node.parentId === undefined ? undefined : this.show(node.parentId, frame);
    const container = parentView ? parentView.children : this.options.contentLayer;
    const entering = !this.visibility.shownIds.has(nodeId);
    const start = entering ? performance.now() : 0;

    let view = this.views.get(nodeId);
    if (!view) {
      view = new NodeView(this.env, node);
      this.views.set(nodeId, view);
    }
    view.update(node, runtimeNode.runtime, frame.context, frame.detail);
    // 改挂容器或父容器被删除 (子节点回落根层级) 时换挂，层级由 ContentOrderSync 重新定位
    if (view.group.parent !== container) container.add(view.group);

    this.visibility.markShown(nodeId);
    if (entering) {
      frame.result.enterMs += performance.now() - start;
      frame.result.entered++;
    }
    return view;
  }
}
