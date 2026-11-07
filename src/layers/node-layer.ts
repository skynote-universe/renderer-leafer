/**
 * @file node-layer.ts
 * @description 节点图层：维护视锥内节点的 NodeView，挂载到父容器 (ADR-114)，摘除离屏者并按 LRU 淘汰
 */

import type { Group } from 'leafer-ui';
import { isNodeHiddenByOpacity, type SkyNoteEngine } from '@skynote/core';
import type { DocumentChangeSet, RuntimeNodeView } from '@skynote/core';
import type { LayerSyncResult, LeaferRenderContext } from '../types';
import type { LeaferNodeRendererRegistry } from '../registry/leafer-node-renderer-registry';
import type { PrimitiveMapper } from '../primitives/primitive-mapper';
import { NodeView, type NodeRenderDetail, type NodeViewEnvironment } from '../node/node-view';
import { VisibilityTracker } from './visibility-tracker';
import { detachSceneGroups, mountSceneGroups, withDetachedBranches } from './scene-subtree-mutation';

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
  readonly pending: RuntimeNodeView[];
  readonly mounts: Map<Group, Group>;
}

export class NodeLayer {
  private readonly views = new Map<string, NodeView>();
  private readonly assetNodes = new Map<string, Set<string>>();
  private readonly nodeAssets = new Map<string, { version: number; ids: readonly string[] }>();

  recordChanges(changes: DocumentChangeSet): void {
    for (const id of changes.nodes.data)
      this.views
        .get(id)
        ?.recordChanges(
          changes.nodes.dataPaths?.get(id) ?? null,
          this.options.engine.entityStore.getNode(id)?.runtime.dataVersion ?? -1
        );
  }

  invalidateAssets(assetIds: ReadonlySet<string>): void {
    for (const assetId of assetIds)
      for (const id of this.assetNodes.get(assetId) ?? []) this.views.get(id)?.invalidateContent();
  }

  /** 节点类型动态注册或注销时，使该类型已缓存的视图内容失效 */
  invalidateNodeType(type: string): void {
    for (const view of this.views.values()) {
      if (view.nodeType === type) view.invalidateContent();
    }
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
    this.visibility = new VisibilityTracker(options.offscreenCacheLimit, true);
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
    const frame: NodeFrame = {
      context,
      detail,
      result: { entered: 0, enterMs: 0, left: 0 },
      pending: [],
      mounts: new Map()
    };

    this.visibility.beginFrame();
    for (let i = 0; i < visibleIds.length; i++) {
      const nodeId = visibleIds[i];
      if (!isCommitted(nodeId)) continue;
      const node = entityStore.getNode(nodeId)?.entity;
      if (!node || isNodeHiddenByOpacity(node, this.options.engine.nodeTypes.get(node.nodeType))) continue;
      this.show(nodeId, frame);
    }
    for (const containerId of containerIds) this.show(containerId, frame);
    const mountStart = frame.result.entered ? performance.now() : 0;
    mountSceneGroups(frame.mounts);
    if (frame.result.entered) frame.result.enterMs += performance.now() - mountStart;
    this.visibility.endFrame(
      (nodeIds) => {
        const groups: Group[] = [];
        for (const id of nodeIds) {
          const view = this.views.get(id);
          if (view) groups.push(view.group);
        }
        detachSceneGroups(groups);
        frame.result.left += nodeIds.length;
      },
      (nodeId) => this.destroy(nodeId)
    );
    return frame.result;
  }

  destroy(nodeId: string): void {
    this.releaseAssetIndex(nodeId);
    this.visibility.forget(nodeId);
    const view = this.views.get(nodeId);
    this.views.delete(nodeId);
    view?.destroy();
  }

  destroyAll(): void {
    this.destroyMany(this.views.keys());
  }

  /** 删除集合按实际场景父链后代优先，避免逐祖先拆装同一子树导致平方开销。 */
  destroyMany(nodeIds: Iterable<string>): void {
    const depths = new Map<Group, number>();
    const entries: { id: string; depth: number }[] = [];
    for (const id of nodeIds) {
      const view = this.views.get(id);
      if (!view) continue;
      const path: Group[] = [];
      let current: Group | undefined = view.group;
      while (current && !depths.has(current)) {
        path.push(current);
        current = current.parent as Group | undefined;
      }
      let depth = current ? depths.get(current)! : -1;
      for (let i = path.length - 1; i >= 0; i--) depths.set(path[i], ++depth);
      entries.push({ id, depth: depths.get(view.group)! });
    }
    entries.sort((a, b) => b.depth - a.depth);
    detachSceneGroups(entries.map(({ id }) => this.views.get(id)!.group));
    for (const { id } of entries) this.destroy(id);
  }

  /** 共享已标记祖先，反向挂载未就绪父链；深层离屏祖先不消耗调用栈。 */
  private show(nodeId: string, frame: NodeFrame): NodeView | undefined {
    if (this.visibility.isMarked(nodeId)) return this.views.get(nodeId);
    const pending = frame.pending;
    let current: string | undefined = nodeId;
    while (current !== undefined && !this.visibility.isMarked(current)) {
      const runtimeNode = this.options.engine.entityStore.getNode(current);
      if (!runtimeNode) {
        current = undefined;
        break;
      }
      pending.push(runtimeNode);
      current = runtimeNode.entity.parentId;
    }
    let parentView = current === undefined ? undefined : this.views.get(current);
    for (let i = pending.length - 1; i >= 0; i--) {
      parentView = this.mount(pending[i], parentView, frame);
    }
    const view = pending.length ? parentView : undefined;
    pending.length = 0;
    return view;
  }

  private mount(runtimeNode: RuntimeNodeView, parentView: NodeView | undefined, frame: NodeFrame): NodeView {
    const node = runtimeNode.entity;
    const nodeId = node.id;
    let view = this.views.get(nodeId);
    if (view && (view.nodeType !== node.nodeType || view.definition !== this.env.nodeTypes.get(node.nodeType))) {
      this.destroy(nodeId);
      view = undefined;
    }
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
    const container = parentView ? parentView.children : this.options.contentLayer;
    const entering = !this.visibility.shownIds.has(nodeId);
    const start = entering ? performance.now() : 0;

    const created = !view;
    if (!view) {
      view = new NodeView(this.env, node);
      this.views.set(nodeId, view);
    }
    view.update(node, runtimeNode.runtime, frame.context, frame.detail);
    // 改挂容器或父容器被删除 (子节点回落根层级) 时换挂，层级由 ContentOrderSync 重新定位
    if (view.group.parent !== container) {
      if (created) withDetachedBranches([view.group], () => container.add(view.group));
      else frame.mounts.set(view.group, container);
    }

    this.visibility.markShown(nodeId);
    if (entering) {
      frame.result.enterMs += performance.now() - start;
      frame.result.entered++;
    }
    return view;
  }
}
