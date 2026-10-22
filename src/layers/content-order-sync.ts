/**
 * @file content-order-sync.ts
 * @description 层级同步：按容器维护与场景树子图元一一对应的有序列表，增量写回层叠顺序
 *
 * 规则 (比较算法见 layering/content-layer-order)：节点嵌套在父节点的子容器中 (ADR-114)，
 * 每个容器 (根内容层或某节点的子容器) 只排序自己的直接子图元；图元当前挂在哪个容器即其 group.parent。
 *
 * 设计考量 (Why):
 * 1. 少量入场二分定位后插入，大批次先排序并与存活条目归并，避免逐项 splice 的平方搬移；
 *    Leafer 每次 add/addAt 都会摘下再插入，小更新仅规划必要移动，大更新规划容器回写。
 * 2. 层级真正变化时才全量排序 (zIndex / parentId / 连线端点变化、实体增删替换)，
 *    按容器以最长递增子序列求出必要移动数，整帧统一拆装所选子树并集，避免嵌套更新重复访问后代。
 * 3. 容器内的子图元全部是被跟踪的条目 (节点外层组、连线组)，有序列表下标即 children 下标。
 */

import type { Group } from 'leafer';
import type { EntityReader } from '@skynote/core';
import { compareContentLayerEntries, type ContentLayerOrderEntry } from '../layering/content-layer-order';
import type { NodeLayer } from './node-layer';
import type { ConnectorLayer } from './connector-layer';
import { withDetachedBranches } from './scene-subtree-mutation';
import type { SceneChildrenChange } from './scene-subtree-mutation';

type OrderEntry = ContentLayerOrderEntry<Group>;

interface OrderPlan {
  roots: Group[];
  changes: Map<Group, SceneChildrenChange>;
  moves: { container: Group; group: Group; next: Group | null }[];
}

// 小更新只移动必要图元；限制逐项插入/移位数量，宽容器的大批次改走排序合并与一次回写。
const MAX_INCREMENTAL_MOVES = 8;

/** 最长递增子序列 (返回构成子序列的下标)，O(n log n) */
function longestIncreasingSubsequence(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[tails[mid]] < values[i]) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[i] = tails[low - 1];
    tails[low] = i;
  }
  const result = new Set<number>();
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i !== -1; i = previous[i]) {
    result.add(i);
  }
  return result;
}

export class ContentOrderSync {
  /** 容器 → 与其子图元顺序一致的有序条目 (自下而上) */
  private sortedByContainer = new Map<Group, OrderEntry[]>();

  constructor(
    private readonly nodeLayer: NodeLayer,
    private readonly connectorLayer: ConnectorLayer,
    private readonly entityStore: EntityReader
  ) {}

  /**
   * @param fullResort 文档层级变化时全量排序；否则增量插入或批次归并，按必要移动数选择回写策略
   */
  sync(fullResort: boolean): void {
    const plan: OrderPlan = { roots: [], changes: new Map(), moves: [] };
    if (fullResort) {
      const buckets = this.collectShownEntries(null);
      for (const [container, entries] of buckets) {
        entries.sort(compareContentLayerEntries);
        this.applyOrder(container, entries, plan);
      }
      this.applyPlan(plan);
      this.sortedByContainer = buckets;
      return;
    }

    // 离开视野或换挂容器的条目已被图层摘下，从原容器的有序列表中剔除；其余保持原有相对顺序
    const known = new Set<Group>();
    for (const [container, entries] of this.sortedByContainer) {
      const kept = entries.filter((entry) => entry.group.parent === container && this.isStillShown(entry));
      if (kept.length === 0) {
        this.sortedByContainer.delete(container);
        continue;
      }
      this.sortedByContainer.set(container, kept);
      for (const entry of kept) known.add(entry.group);
    }

    for (const [container, entries] of this.collectShownEntries(known)) {
      let sorted = this.sortedByContainer.get(container);
      if (!sorted) {
        sorted = [];
        this.sortedByContainer.set(container, sorted);
      }
      if (entries.length > MAX_INCREMENTAL_MOVES) {
        entries.sort(compareContentLayerEntries);
        const merged: OrderEntry[] = [];
        let existing = 0;
        let added = 0;
        while (existing < sorted.length && added < entries.length) {
          if (compareContentLayerEntries(sorted[existing], entries[added]) <= 0) merged.push(sorted[existing++]);
          else merged.push(entries[added++]);
        }
        while (existing < sorted.length) merged.push(sorted[existing++]);
        while (added < entries.length) merged.push(entries[added++]);
        this.sortedByContainer.set(container, merged);
        this.applyOrder(container, merged, plan);
        continue;
      }
      for (const entry of entries) {
        let low = 0;
        let high = sorted.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (compareContentLayerEntries(sorted[mid], entry) <= 0) low = mid + 1;
          else high = mid;
        }
        sorted.splice(low, 0, entry);
      }
      this.applyOrder(container, sorted, plan);
    }
    this.applyPlan(plan);
  }

  private isStillShown(entry: OrderEntry): boolean {
    return entry.kind === 'node'
      ? this.nodeLayer.getGroup(entry.node.id) === entry.group && this.nodeLayer.shownIds.has(entry.node.id)
      : this.connectorLayer.getGroup(entry.connector.id) === entry.group &&
          this.connectorLayer.shownIds.has(entry.connector.id);
  }

  /** 收集当前挂载实体的条目并按所在容器分组；exclude 非空时跳过其中已有的图元 */
  private collectShownEntries(exclude: ReadonlySet<Group> | null): Map<Group, OrderEntry[]> {
    const buckets = new Map<Group, OrderEntry[]>();
    const push = (entry: OrderEntry): void => {
      const container = entry.group.parent as Group;
      let bucket = buckets.get(container);
      if (!bucket) {
        bucket = [];
        buckets.set(container, bucket);
      }
      bucket.push(entry);
    };

    for (const nodeId of this.nodeLayer.shownIds) {
      const group = this.nodeLayer.getGroup(nodeId);
      const node = this.entityStore.getNode(nodeId)?.entity;
      if (!group || !node || exclude?.has(group)) continue;
      push({ kind: 'node', node, group });
    }
    for (const connectorId of this.connectorLayer.shownIds) {
      const group = this.connectorLayer.getGroup(connectorId);
      const connector = this.entityStore.getConnector(connectorId)?.entity;
      if (!group || !connector || exclude?.has(group)) continue;
      const { anchorNode } = this.connectorLayer.getPlacement(connectorId)!;
      push({ kind: 'connector', connector, group, anchorNode });
    }
    return buckets;
  }

  /**
   * 先规划所有容器：小更新仅选择LIS以外的图元，大更新选择容器，最后统一拆装子树并集。
   */
  private applyOrder(container: Group, entries: readonly OrderEntry[], plan: OrderPlan): void {
    const currentIndex = new Map<Group, number>();
    const children = container.children;
    for (let i = 0; i < children.length; i++) {
      currentIndex.set(children[i] as Group, i);
    }
    const stable = longestIncreasingSubsequence(entries.map((entry) => currentIndex.get(entry.group) ?? -1));
    if (entries.length === stable.size) return;
    plan.changes.set(container, { ordered: entries.map((entry) => entry.group) });
    if (entries.length - stable.size > MAX_INCREMENTAL_MOVES) {
      plan.roots.push(container);
      return;
    }

    for (let i = entries.length - 1; i >= 0; i--) {
      if (stable.has(i)) continue;
      const group = entries[i].group;
      const next = i + 1 < entries.length ? entries[i + 1].group : null;
      plan.roots.push(group);
      plan.moves.push({ container, group, next });
    }
  }

  private applyPlan(plan: OrderPlan): void {
    if (!plan.roots.length) return;
    withDetachedBranches(
      plan.roots,
      (detachedParents) => {
        for (const { container, group, next } of plan.moves) {
          // 已被祖先选中的父容器通过顺序计划恢复；此时兄弟分支已摘下，不能再依赖其下标。
          if (detachedParents.has(container)) continue;
          group.remove();
          if (next) container.addAt(group, container.children.indexOf(next));
          else container.add(group);
        }
      },
      plan.changes
    );
  }
}
