/**
 * @file content-order-sync.ts
 * @description 内容层层级同步：维护与场景树子节点一一对应的有序列表，增量写回层叠顺序
 *
 * 规则 (比较算法见 layering/content-layer-order)：伴生锚定、紧贴宿主下方、只排序已挂载实体。
 *
 * 设计考量 (Why):
 * 1. 平移时只插入：新进入视野的实体按比较器二分定位后 addAt 插入，已挂载实体不动；
 *    Leafer 每次 add/addAt 都是摘下再插入，若每帧整体重挂上千个图元，结构开销会逼近整个帧预算。
 * 2. 层级真正变化时才全量排序 (zIndex / parentId / 连线端点变化、实体增删替换)，
 *    并以最长递增子序列求出最少需要移动的图元，单个节点调整层级只移动它自己。
 */

import type { Group } from 'leafer';
import type { EntityReader, NodeEntity } from '@skynote/core';
import {
  compareHierarchicalNodes,
  resolveConnectorLayerAnchor,
  compareContentLayerEntries,
  type ContentLayerOrderEntry
} from '../layering/content-layer-order';
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
  /** 与内容层子节点顺序一致的有序条目 (自下而上) */
  private sorted: OrderEntry[] = [];

  constructor(
    private readonly contentLayer: Group,
    private readonly nodeLayer: NodeLayer,
    private readonly connectorLayer: ConnectorLayer,
    private readonly entityStore: EntityReader
  ) {}

  /**
   * @param fullResort 文档层级发生变化时为 true：全量排序并最少移动；否则只为新挂载的实体定位插入
   */
  sync(fullResort: boolean): void {
    const chainCache = new Map<string, NodeEntity[]>();
    const getNode = (id: string) => this.entityStore.getNode(id)?.entity;
    const compareNodes = (left: NodeEntity, right: NodeEntity) => compareHierarchicalNodes(left, right, getNode, chainCache);
    const compare = (left: OrderEntry, right: OrderEntry) => compareContentLayerEntries(left, right, compareNodes);

    if (fullResort) {
      const entries = this.collectShownEntries(null, getNode, compareNodes);
      entries.sort(compare);
      this.applyMinimalMoves(entries);
      this.sorted = entries;
      return;
    }

    // 离开视野的实体已被图层摘除，从有序列表中剔除；其余保持原有相对顺序
    const kept = this.sorted.filter((entry) => this.isStillShown(entry));
    const known = new Set(kept.map((entry) => entry.group));
    this.sorted = kept;

    for (const entry of this.collectShownEntries(known, getNode, compareNodes)) {
      let low = 0;
      let high = this.sorted.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (compare(this.sorted[mid], entry) <= 0) low = mid + 1;
        else high = mid;
      }
      // 新图元此前由图层追加在内容层末尾，addAt 将其移至有序位置，不触碰其他图元
      this.sorted.splice(low, 0, entry);
      this.contentLayer.addAt(entry.group, low);
    }
  }

  private isStillShown(entry: OrderEntry): boolean {
    return entry.kind === 'node'
      ? this.nodeLayer.getGroup(entry.node.id) === entry.group && this.nodeLayer.shownIds.has(entry.node.id)
      : this.connectorLayer.getGroup(entry.connector.id) === entry.group && this.connectorLayer.shownIds.has(entry.connector.id);
  }

  /** 收集当前挂载实体的条目；exclude 非空时跳过其中已有的图元 */
  private collectShownEntries(
    exclude: ReadonlySet<Group> | null,
    getNode: (id: string) => NodeEntity | undefined,
    compareNodes: (left: NodeEntity, right: NodeEntity) => number
  ): OrderEntry[] {
    const entries: OrderEntry[] = [];
    for (const nodeId of this.nodeLayer.shownIds) {
      const group = this.nodeLayer.getGroup(nodeId);
      const node = getNode(nodeId);
      if (!group || !node || exclude?.has(group)) continue;
      entries.push({ kind: 'node', node, group });
    }
    for (const connectorId of this.connectorLayer.shownIds) {
      const group = this.connectorLayer.getGroup(connectorId);
      const connector = this.entityStore.getConnector(connectorId)?.entity;
      if (!group || !connector || exclude?.has(group)) continue;
      entries.push({
        kind: 'connector',
        connector,
        group,
        anchorNode: resolveConnectorLayerAnchor(connector, getNode, compareNodes)
      });
    }
    return entries;
  }

  /**
   * 只移动不在最长递增子序列中的图元：自上而下逐个插到其后继之前，其余图元保持不动
   */
  private applyMinimalMoves(entries: readonly OrderEntry[]): void {
    const currentIndex = new Map<Group, number>();
    const children = this.contentLayer.children;
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
        this.contentLayer.addAt(group, this.contentLayer.children.indexOf(next));
      } else {
        this.contentLayer.add(group);
      }
    }
  }
}
