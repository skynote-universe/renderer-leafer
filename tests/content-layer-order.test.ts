import { describe, it, expect } from 'vitest';
import type { NodeEntity, ConnectorEntity } from '@skynote/core';
import {
  resolveConnectorLayerPlacement,
  compareContentLayerEntries,
  type ContentLayerOrderEntry
} from '../src/layering/content-layer-order';

function node(id: string, zIndex: string, parentId?: string): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'custom',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex,
    parentId,
    locked: false
  };
}

function connector(id: string, fromId?: string, toId?: string, zIndex = 'a1'): ConnectorEntity {
  return {
    id,
    type: 'connector',
    connectorType: 'straight',
    from: { nodeId: fromId },
    to: { nodeId: toId },
    zIndex,
    locked: false
  };
}

/**
 * 根层级：A(a1)、frame(a2)；frame 内：B(a1)、C(a2)、inner(a3)；inner 内：D(a1)
 */
function createScene() {
  const nodes = new Map<string, NodeEntity>(
    [
      node('A', 'a1'),
      node('frame', 'a2'),
      node('B', 'a1', 'frame'),
      node('C', 'a2', 'frame'),
      node('inner', 'a3', 'frame'),
      node('D', 'a1', 'inner')
    ].map((n) => [n.id, n])
  );
  return { nodes, getNode: (id: string) => nodes.get(id) };
}

describe('resolveConnectorLayerPlacement 连线挂载位置 (ADR-114)', () => {
  it('两端同在一个容器内：挂在该容器，紧贴较高一端下方', () => {
    const { getNode } = createScene();
    const placement = resolveConnectorLayerPlacement(connector('c', 'B', 'C'), getNode);
    expect(placement.containerId).toBe('frame');
    expect(placement.anchorNode!.id).toBe('C');
    expect(placement.placement).toBe('below');
  });

  it('跨容器：挂在公共祖先容器，较高一端嵌套在子容器里时紧贴该子容器上方', () => {
    const { getNode } = createScene();
    const placement = resolveConnectorLayerPlacement(connector('c', 'A', 'B'), getNode);
    expect(placement.containerId).toBeUndefined();
    expect(placement.anchorNode!.id).toBe('frame');
    expect(placement.placement).toBe('above');

    // 较高一端直接位于公共容器时仍紧贴其下方
    const nested = resolveConnectorLayerPlacement(connector('c', 'D', 'C'), getNode);
    expect(nested.containerId).toBe('frame');
    expect(nested.anchorNode!.id).toBe('inner');
    expect(nested.placement).toBe('above');

    const direct = resolveConnectorLayerPlacement(connector('c', 'D', 'B'), getNode);
    expect(direct.anchorNode!.id).toBe('inner');
  });

  it('较高一端直接位于公共容器：紧贴其下方', () => {
    const { nodes, getNode } = createScene();
    nodes.set('A', node('A', 'a9'));
    const placement = resolveConnectorLayerPlacement(connector('c', 'A', 'B'), getNode);
    expect(placement.anchorNode!.id).toBe('A');
    expect(placement.placement).toBe('below');
  });

  it('一端是另一端的祖先：挂在该祖先内部，锚定另一端在其中的代表兄弟', () => {
    const { getNode } = createScene();
    const child = resolveConnectorLayerPlacement(connector('c', 'frame', 'C'), getNode);
    expect(child.containerId).toBe('frame');
    expect(child.anchorNode!.id).toBe('C');
    expect(child.placement).toBe('below');

    const grandchild = resolveConnectorLayerPlacement(connector('c', 'D', 'frame'), getNode);
    expect(grandchild.containerId).toBe('frame');
    expect(grandchild.anchorNode!.id).toBe('inner');
    expect(grandchild.placement).toBe('above');
  });

  it('只绑定一端、自环与两端悬空', () => {
    const { getNode } = createScene();
    expect(resolveConnectorLayerPlacement(connector('c', 'D'), getNode)).toMatchObject({
      containerId: 'inner',
      placement: 'below'
    });
    expect(resolveConnectorLayerPlacement(connector('c', 'B', 'B'), getNode).containerId).toBe('frame');
    expect(resolveConnectorLayerPlacement(connector('c', 'missing'), getNode)).toEqual({
      containerId: undefined,
      anchorNode: null,
      placement: 'below'
    });
  });
});

describe('compareContentLayerEntries 容器内排序', () => {
  it('同一锚点：下方连线 < 节点 < 上方连线，同侧多条连线按自身索引', () => {
    const anchor = node('X', 'a5');
    const other = node('Y', 'a6');
    const entries: ContentLayerOrderEntry[] = [
      { kind: 'node', node: other, group: null },
      { kind: 'connector', connector: connector('above', 'X'), group: null, anchorNode: anchor, placement: 'above' },
      { kind: 'node', node: anchor, group: null },
      {
        kind: 'connector',
        connector: connector('below2', 'X', undefined, 'a2'),
        group: null,
        anchorNode: anchor,
        placement: 'below'
      },
      {
        kind: 'connector',
        connector: connector('below1', 'X', undefined, 'a1'),
        group: null,
        anchorNode: anchor,
        placement: 'below'
      }
    ];
    const order = [...entries]
      .sort(compareContentLayerEntries)
      .map((entry) => (entry.kind === 'node' ? entry.node.id : entry.connector.id));
    expect(order).toEqual(['below1', 'below2', 'X', 'above', 'Y']);
  });

  it('悬空连线以自身索引与节点交错排序', () => {
    const entries: ContentLayerOrderEntry[] = [
      { kind: 'node', node: node('N', 'a5'), group: null },
      {
        kind: 'connector',
        connector: connector('dangling', undefined, undefined, 'a3'),
        group: null,
        anchorNode: null,
        placement: 'below'
      }
    ];
    const order = [...entries]
      .sort(compareContentLayerEntries)
      .map((entry) => (entry.kind === 'node' ? entry.node.id : entry.connector.id));
    expect(order).toEqual(['dangling', 'N']);
  });
});
