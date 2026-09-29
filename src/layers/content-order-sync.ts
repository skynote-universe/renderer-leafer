/**
 * @file content-order-sync.ts
 * @description 层级同步：按容器维护与场景树子图元一一对应的有序列表，增量写回层叠顺序
 *
 * 规则 (比较算法见 layering/content-layer-order)：节点嵌套在父节点的子容器中 (ADR-114)，
 * 每个容器 (根内容层或某节点的子容器) 只排序自己的直接子图元；图元当前挂在哪个容器即其 group.parent。
 *
 * 设计考量 (Why):
 * 1. 平移时只插入：新进入视野的实体按比较器二分定位后 addAt 插入所在容器，已挂载实体不动；
 *    Leafer 每次 add/addAt 都是摘下再插入，若每帧整体重挂上千个图元，结构开销会逼近整个帧预算。
 * 2. 层级真正变化时才全量排序 (zIndex / parentId / 连线端点变化、实体增删替换)，
 *    并按容器以最长递增子序列求出最少需要移动的图元，单个节点调整层级只移动它自己。
 * 3. 容器内的子图元全部是被跟踪的条目 (节点外层组、连线组)，有序列表下标即 children 下标。
 */

import type { Group } from 'leafer';
import type { EntityReader } from '@skynote/core';
import { compareContentLayerEntries, type ContentLayerOrderEntry } from '../layering/content-layer-order';
import type { NodeLayer } from './node-layer';
import type { ConnectorLayer } from './connector-layer';

type OrderEntry = ContentLayerOrderEntry<Group>;

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
   * @param fullResort 文档层级发生变化时为 true：全量排序并最少移动；否则只为新挂载或换挂容器的实体定位插入
   */
  sync(fullResort: boolean): void {
    if (fullResort) {
      const buckets = this.collectShownEntries(null);
      for (const [container, entries] of buckets) {
        entries.sort(compareContentLayerEntries);
        this.applyMinimalMoves(container, entries);
      }
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
      for (const entry of entries) {
        let low = 0;
        let high = sorted.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (compareContentLayerEntries(sorted[mid], entry) <= 0) low = mid + 1;
          else high = mid;
        }
        // 新图元此前由图层追加在容器末尾，addAt 将其移至有序位置，不触碰其他图元
        sorted.splice(low, 0, entry);
        container.addAt(entry.group, low);
      }
    }
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
      const { anchorNode, placement } = this.connectorLayer.getPlacement(connectorId)!;
      push({ kind: 'connector', connector, group, anchorNode, placement });
    }
    return buckets;
  }

  /**
   * 只移动不在最长递增子序列中的图元：自上而下逐个插到其后继之前，其余图元保持不动
   */
  private applyMinimalMoves(container: Group, entries: readonly OrderEntry[]): void {
    const currentIndex = new Map<Group, number>();
    const children = container.children;
    for (let i = 0; i < children.length; i++) {
      currentIndex.set(children[i] as Group, i);
    }
    const stable = longestIncreasingSubsequence(entries.map((entry) => currentIndex.get(entry.group) ?? -1));

    for (let i = entries.length - 1; i >= 0; i--) {
      if (stable.has(i)) continue;
      const group = entries[i].group;
      group.remove();
      const next = i + 1 < entries.length ? entries[i + 1].group : null;
      if (next) {
        container.addAt(group, container.children.indexOf(next));
      } else {
        container.add(group);
      }
    }
  }
}
