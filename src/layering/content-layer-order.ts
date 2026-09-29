/**
 * @file content-layer-order.ts
 * @description 场景树内容层拓扑排序算法 (ContentLayerOrder)
 *
 * 核心设计考量 (Why):
 * 1. 伴生锚定法则 (Anchor Node Hierarchy)：
 *    连线不设死板独立的全局孤立层，而是跟随其连接的两端节点中层级更高者伴生锚定；
 * 2. 紧贴下层法则 (Immediately Below Rule)：
 *    连线与伴生节点在同一层级时，连线严格排在节点紧下方 (-1)，彻底杜绝连线穿透盖住卡片与文字；
 * 3. 容器与跨画框自适应：
 *    画框内连线天然高于画框底色、低于子节点；跨画框连线天然高于低层画框底色、在目标节点处自然隐入。
 */

import type { ConnectorEntity, NodeEntity } from '@skynote/core';
import { compareFractionalIndex } from '@skynote/core';

export type ContentLayerOrderEntry<TGroup = unknown> =
  | {
      kind: 'node';
      node: NodeEntity;
      group: TGroup;
    }
  | {
      kind: 'connector';
      connector: ConnectorEntity;
      group: TGroup;
      anchorNode: NodeEntity | null;
    };

/**
 * 求解节点自根向下的继承祖先链
 */
export function resolveNodeAncestryChain(
  node: NodeEntity,
  getNode: (id: string) => NodeEntity | undefined
): NodeEntity[] {
  const result: NodeEntity[] = [node];
  let current = node;
  const visited = new Set<string>([node.id]);

  while (current.parentId) {
    if (visited.has(current.parentId)) break; // 防止环状依赖
    visited.add(current.parentId);
    const parent = getNode(current.parentId);
    if (!parent) break;
    result.push(parent);
    current = parent;
  }

  return result.reverse();
}

/**
 * 基于画框树状层级比较两个节点的前后顺序
 * 规则：
 * 1. 祖先节点永远排在子孙节点下方 (父背景在底，子节点在顶)；
 * 2. 同级分叉点按分数索引升序比较，键相同时按 id 决胜 (各客户端结果一致，除同一节点外从不返回 0)。
 */
export function compareHierarchicalNodes(
  left: NodeEntity,
  right: NodeEntity,
  getNode: (id: string) => NodeEntity | undefined,
  chainCache?: Map<string, NodeEntity[]>
): number {
  if (left.id === right.id) return 0;

  const getChain = (node: NodeEntity): NodeEntity[] => {
    if (chainCache?.has(node.id)) return chainCache.get(node.id)!;
    const chain = resolveNodeAncestryChain(node, getNode);
    chainCache?.set(node.id, chain);
    return chain;
  };

  const leftChain = getChain(left);
  const rightChain = getChain(right);

  let index = 0;
  while (index < leftChain.length && index < rightChain.length && leftChain[index].id === rightChain[index].id) {
    index += 1;
  }

  // left 是 right 的祖先容器：left 更低
  if (index === leftChain.length) return -1;
  // right 是 left 的祖先容器：right 更低，left 更高
  if (index === rightChain.length) return 1;

  // 相同深度的第一个分叉点 (互为兄弟)，按分数索引判定
  const leftFork = leftChain[index];
  const rightFork = rightChain[index];
  return compareFractionalIndex(leftFork.zIndex, leftFork.id, rightFork.zIndex, rightFork.id);
}

/**
 * 求解连线的伴生锚定节点 (选取两端中层级更高者)
 */
export function resolveConnectorLayerAnchor(
  connector: Pick<ConnectorEntity, 'from' | 'to'>,
  getNode: (nodeId: string) => NodeEntity | undefined,
  compareNodes: (left: NodeEntity, right: NodeEntity) => number
): NodeEntity | null {
  const fromNode = connector.from.nodeId ? getNode(connector.from.nodeId) : undefined;
  const toNode = connector.to.nodeId ? getNode(connector.to.nodeId) : undefined;

  if (!fromNode) return toNode ?? null;
  if (!toNode) return fromNode;

  return compareNodes(fromNode, toNode) >= 0 ? fromNode : toNode;
}

/**
 * 内容层统一拓扑排序比较器 (满足严格弱序 Strict Weak Ordering)
 */
export function compareContentLayerEntries(
  left: ContentLayerOrderEntry<unknown>,
  right: ContentLayerOrderEntry<unknown>,
  compareNodes: (left: NodeEntity, right: NodeEntity) => number
): number {
  const leftAnchor = left.kind === 'node' ? left.node : left.anchorNode;
  const rightAnchor = right.kind === 'node' ? right.node : right.anchorNode;

  let order: number;
  if (leftAnchor && rightAnchor) {
    order = compareNodes(leftAnchor, rightAnchor);
  } else {
    // 悬空连线 (两端节点均不存在) 以自身索引参与排序
    const leftRef = leftAnchor ?? (left.kind === 'connector' ? left.connector : left.node);
    const rightRef = rightAnchor ?? (right.kind === 'connector' ? right.connector : right.node);
    order = compareFractionalIndex(leftRef.zIndex, leftRef.id, rightRef.zIndex, rightRef.id);
  }

  if (order !== 0) return order;

  // 1. 严格同一伴生锚点守卫：仅当两者属于完全相同的宿主节点时，连线才排在节点紧下方 (-1)
  if (leftAnchor && rightAnchor && leftAnchor.id === rightAnchor.id) {
    if (left.kind !== right.kind) {
      return left.kind === 'connector' ? -1 : 1;
    }
  }

  // 2. 伴生到同一节点的多条连线：按连线自身索引与 id 排序
  const leftEntity = left.kind === 'connector' ? left.connector : left.node;
  const rightEntity = right.kind === 'connector' ? right.connector : right.node;
  return compareFractionalIndex(leftEntity.zIndex, leftEntity.id, rightEntity.zIndex, rightEntity.id);
}
