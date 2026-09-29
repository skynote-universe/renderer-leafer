/**
 * @file content-layer-order.ts
 * @description 容器内层叠排序 (ContentLayerOrder)：节点嵌套渲染后，每个容器只排序自己的直接子图元 (ADR-114)
 *
 * 核心设计考量 (Why):
 * 1. 按容器分组：节点图元挂在父节点的子容器里，容器内的条目全部是兄弟，比较退化为兄弟间的分数索引比较，
 *    不再需要跨层回溯祖先链；跨容器的整体层叠由场景树嵌套天然保证。
 * 2. 连线挂在两端节点的最近公共祖先容器中，以两端在该容器中的「代表兄弟」(自身或所在的子容器) 作为伴生锚点：
 *    - 较高一端直接位于该容器：紧贴其下方，连线不压住卡片与文字 (原伴生锚定规则)；
 *    - 较高一端嵌套在某个子容器里：紧贴该子容器上方，连线完整可见、不被容器底色遮挡，也不被容器裁剪
 *      (与 tldraw、FigJam 一致)。
 * 3. 两端都在同一容器内的连线挂在该容器里，随容器一起移动、旋转与裁剪。
 */

import type { ConnectorEntity, NodeEntity } from '@skynote/core';
import { compareFractionalIndex, resolveNodeAncestryChain } from '@skynote/core';

/** 连线相对伴生锚点的位置 */
export type ConnectorPlacement = 'below' | 'above';

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
      /** 容器内的伴生锚点 (容器的直接子节点)；两端都悬空时为 null，以连线自身索引参与排序 */
      anchorNode: NodeEntity | null;
      placement: ConnectorPlacement;
    };

/** 连线的挂载位置 */
export interface ConnectorLayerPlacement {
  /** 挂载容器节点 id，undefined 为根内容层 */
  readonly containerId: string | undefined;
  readonly anchorNode: NodeEntity | null;
  readonly placement: ConnectorPlacement;
}

/**
 * 求解连线的挂载容器与伴生锚点
 * @param chainCache 同一帧内复用祖先链
 */
export function resolveConnectorLayerPlacement(
  connector: Pick<ConnectorEntity, 'from' | 'to'>,
  getNode: (nodeId: string) => NodeEntity | undefined,
  chainCache?: Map<string, NodeEntity[]>
): ConnectorLayerPlacement {
  const getChain = (node: NodeEntity): NodeEntity[] => {
    let chain = chainCache?.get(node.id);
    if (!chain) {
      chain = resolveNodeAncestryChain(node, getNode);
      chainCache?.set(node.id, chain);
    }
    return chain;
  };
  const fromNode = connector.from.nodeId ? getNode(connector.from.nodeId) : undefined;
  const toNode = connector.to.nodeId ? getNode(connector.to.nodeId) : undefined;

  // 只有一端绑定节点 (另一端为自由坐标或悬空) 或自环：挂在该节点所在容器，紧贴其下方
  if (!fromNode || !toNode || fromNode.id === toNode.id) {
    const node = fromNode ?? toNode;
    if (!node) return { containerId: undefined, anchorNode: null, placement: 'below' };
    const chain = getChain(node);
    return {
      containerId: chain.length > 1 ? chain[chain.length - 2].id : undefined,
      anchorNode: node,
      placement: 'below'
    };
  }

  const fromChain = getChain(fromNode);
  const toChain = getChain(toNode);
  let depth = 0;
  while (depth < fromChain.length && depth < toChain.length && fromChain[depth].id === toChain[depth].id) {
    depth += 1;
  }

  // 一端是另一端的祖先 (如画框连向自己的子节点)：挂在该祖先内部，锚定另一端在其中的代表兄弟
  if (depth === fromChain.length || depth === toChain.length) {
    const innerChain = depth === fromChain.length ? toChain : fromChain;
    return {
      containerId: innerChain[depth - 1].id,
      anchorNode: innerChain[depth],
      placement: innerChain.length > depth + 1 ? 'above' : 'below'
    };
  }

  const fromRep = fromChain[depth];
  const toRep = toChain[depth];
  const fromHigher = compareFractionalIndex(fromRep.zIndex, fromRep.id, toRep.zIndex, toRep.id) >= 0;
  const [rep, chain] = fromHigher ? [fromRep, fromChain] : [toRep, toChain];
  return {
    containerId: depth > 0 ? fromChain[depth - 1].id : undefined,
    anchorNode: rep,
    placement: chain.length > depth + 1 ? 'above' : 'below'
  };
}

/** 条目在容器内的排位档：同一锚点下「下方连线 < 节点 < 上方连线」 */
function entryRank(entry: ContentLayerOrderEntry<unknown>): number {
  if (entry.kind === 'node') return 1;
  return entry.placement === 'below' ? 0 : 2;
}

/**
 * 同一容器内的排序比较器 (满足严格弱序)：条目的锚点均为该容器的直接子节点
 */
export function compareContentLayerEntries(
  left: ContentLayerOrderEntry<unknown>,
  right: ContentLayerOrderEntry<unknown>
): number {
  const leftAnchor = left.kind === 'node' ? left.node : left.anchorNode;
  const rightAnchor = right.kind === 'node' ? right.node : right.anchorNode;
  // 悬空连线 (两端节点均不存在) 以自身索引参与排序
  const leftRef = leftAnchor ?? (left as { connector: ConnectorEntity }).connector;
  const rightRef = rightAnchor ?? (right as { connector: ConnectorEntity }).connector;

  const order = compareFractionalIndex(leftRef.zIndex, leftRef.id, rightRef.zIndex, rightRef.id);
  if (order !== 0) return order;

  const rankOrder = entryRank(left) - entryRank(right);
  if (rankOrder !== 0) return rankOrder;

  // 伴生到同一锚点、同一侧的多条连线：按连线自身索引与 id 排序
  const leftEntity = left.kind === 'connector' ? left.connector : left.node;
  const rightEntity = right.kind === 'connector' ? right.connector : right.node;
  return compareFractionalIndex(leftEntity.zIndex, leftEntity.id, rightEntity.zIndex, rightEntity.id);
}
