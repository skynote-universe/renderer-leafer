/**
 * @file content-layer-order.ts
 * @description 容器内层叠排序 (ContentLayerOrder)：节点嵌套渲染后，每个容器只排序自己的直接子图元 (ADR-114)
 *
 * 核心设计考量 (Why):
 * 1. 按容器分组：节点图元挂在父节点的子容器里，容器内的条目全部是兄弟，比较退化为兄弟间的分数索引比较，
 *    不再需要跨层回溯祖先链；跨容器的整体层叠由场景树嵌套天然保证。
 * 2. 连线的挂载容器与伴生锚点由内核求解 (resolveConnectorLayerPlacement)，拾取与渲染共用同一规则；
 *    这里只负责在容器内把连线排在锚点正上方。
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
      /** 容器内的伴生锚点 (容器的直接子节点)，连线紧贴其上方；两端都悬空时为 null，以连线自身索引参与排序 */
      anchorNode: NodeEntity | null;
    };

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

  // 同一锚点下节点在前、伴生连线在后 (紧贴其上方)
  const rankOrder = (left.kind === 'node' ? 0 : 1) - (right.kind === 'node' ? 0 : 1);
  if (rankOrder !== 0) return rankOrder;

  // 伴生到同一锚点的多条连线：按连线自身索引与 id 排序
  const leftEntity = left.kind === 'connector' ? left.connector : left.node;
  const rightEntity = right.kind === 'connector' ? right.connector : right.node;
  return compareFractionalIndex(leftEntity.zIndex, leftEntity.id, rightEntity.zIndex, rightEntity.id);
}
