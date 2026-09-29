/**
 * @file content-order-sync.ts
 * @description 内容层层级同步：把已挂载的节点与连线按层叠规则排序后写回场景树
 *
 * 规则 (算法见 layering/content-layer-order)：
 * 1. 伴生锚定：连线跟随两端层级较高者伴生；
 * 2. 紧贴下层：同伴生节点时连线严格排在节点紧下方；
 * 3. 只排序已挂载实体：离屏图元已从场景树摘除，重新进入视野时会再次触发同步。
 * 开销 O(V log V)，仅在层级脏标记置位时执行。
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

export function syncContentOrder(
  contentLayer: Group,
  nodeLayer: NodeLayer,
  connectorLayer: ConnectorLayer,
  entityStore: EntityReader
): void {
  const chainCache = new Map<string, NodeEntity[]>();
  const getNode = (id: string) => entityStore.getNode(id)?.entity;
  const compareNodes = (left: NodeEntity, right: NodeEntity) => compareHierarchicalNodes(left, right, getNode, chainCache);

  const ordered: ContentLayerOrderEntry<Group>[] = [];
  for (const nodeId of nodeLayer.shownIds) {
    const group = nodeLayer.getGroup(nodeId);
    const node = getNode(nodeId);
    if (!group || !node) continue;
    ordered.push({ kind: 'node', node, group });
  }
  for (const connectorId of connectorLayer.shownIds) {
    const group = connectorLayer.getGroup(connectorId);
    const connector = entityStore.getConnector(connectorId)?.entity;
    if (!group || !connector) continue;
    ordered.push({
      kind: 'connector',
      connector,
      group,
      anchorNode: resolveConnectorLayerAnchor(connector, getNode, compareNodes)
    });
  }

  ordered.sort((left, right) => compareContentLayerEntries(left, right, compareNodes));

  // 快速脏检查：仅当顺序与场景树当前顺序不一致时才重新挂载
  const currentChildren = contentLayer.children;
  let needReorder = currentChildren.length !== ordered.length;
  for (let i = 0; !needReorder && i < ordered.length; i++) {
    needReorder = currentChildren[i] !== ordered[i].group;
  }
  if (needReorder) {
    for (let i = 0; i < ordered.length; i++) {
      contentLayer.add(ordered[i].group);
    }
  }
}
