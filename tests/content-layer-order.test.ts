import { describe, it, expect } from 'vitest';
import type { NodeEntity, ConnectorEntity } from '@skynote/core';
import {
  resolveNodeAncestryChain,
  compareHierarchicalNodes,
  resolveConnectorLayerAnchor,
  compareContentLayerEntries,
  type ContentLayerOrderEntry
} from '../src/layering/content-layer-order';

function createMockNode(params: {
  id: string;
  zIndex?: string;
  parentId?: string;
}): NodeEntity {
  return {
    id: params.id,
    type: 'node',
    nodeType: 'custom',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: params.zIndex ?? 'a1',
    parentId: params.parentId,
    locked: false
  };
}

function createMockConnector(params: {
  id: string;
  fromId?: string;
  toId?: string;
  zIndex?: string;
}): ConnectorEntity {
  return {
    id: params.id,
    type: 'connector',
    connectorType: 'straight',
    from: { nodeId: params.fromId },
    to: { nodeId: params.toId },
    zIndex: params.zIndex ?? 'a1',
    locked: false
  };
}

describe('ContentLayerOrder 场景树层级拓扑排序', () => {
  it('resolveNodeAncestryChain 正确求解祖先链并防御环状引用', () => {
    const root = createMockNode({ id: 'root', zIndex: 'a1' });
    const container = createMockNode({ id: 'container', parentId: 'root', zIndex: 'a1' });
    const child = createMockNode({ id: 'child', parentId: 'container', zIndex: 'a1' });

    const nodes = new Map<string, NodeEntity>([
      ['root', root],
      ['container', container],
      ['child', child]
    ]);

    const chain = resolveNodeAncestryChain(child, id => nodes.get(id));
    expect(chain.map(n => n.id)).toEqual(['root', 'container', 'child']);

    // 环状防御测试
    const loopA = createMockNode({ id: 'loopA', parentId: 'loopB', zIndex: 'a1' });
    const loopB = createMockNode({ id: 'loopB', parentId: 'loopA', zIndex: 'a1' });
    const loopNodes = new Map<string, NodeEntity>([
      ['loopA', loopA],
      ['loopB', loopB]
    ]);

    expect(() => {
      resolveNodeAncestryChain(loopA, id => loopNodes.get(id));
    }).not.toThrow();
  });

  it('compareHierarchicalNodes 确保父容器在底、子节点在顶', () => {
    const container = createMockNode({ id: 'frame1', zIndex: 'a1' });
    const child = createMockNode({ id: 'card1', parentId: 'frame1', zIndex: 'a1' });

    const nodes = new Map<string, NodeEntity>([
      ['frame1', container],
      ['card1', child]
    ]);

    // 父容器 < 子节点 (容器在下方)
    expect(compareHierarchicalNodes(container, child, id => nodes.get(id))).toBeLessThan(0);
    expect(compareHierarchicalNodes(child, container, id => nodes.get(id))).toBeGreaterThan(0);
  });

  it('resolveConnectorLayerAnchor 求解连线的伴生锚点 (选取层级更高者)', () => {
    const frame = createMockNode({ id: 'frame', zIndex: 'a1' });
    const innerCard = createMockNode({ id: 'innerCard', parentId: 'frame', zIndex: 'a1' });
    const outsideCard = createMockNode({ id: 'outsideCard', zIndex: 'a2' });

    const nodes = new Map<string, NodeEntity>([
      ['frame', frame],
      ['innerCard', innerCard],
      ['outsideCard', outsideCard]
    ]);

    const getNode = (id?: string) => (id ? nodes.get(id) : undefined);
    const compareNodes = (a: NodeEntity, b: NodeEntity) => compareHierarchicalNodes(a, b, getNode);

    // 跨画框连线：outsideCard (zIndex 2) 比 frame (zIndex 1) 树分叉处更高
    const conn1 = createMockConnector({ id: 'c1', fromId: 'innerCard', toId: 'outsideCard' });
    const anchor = resolveConnectorLayerAnchor(conn1, getNode, compareNodes);
    expect(anchor?.id).toBe('outsideCard');

    // 悬空连线：只有一端连接节点
    const connDangling = createMockConnector({ id: 'cDangling', fromId: 'innerCard' });
    expect(resolveConnectorLayerAnchor(connDangling, getNode, compareNodes)?.id).toBe('innerCard');
  });

  it('综合拓扑排序：容器内连线高于容器背景、低于内部子节点', () => {
    const frame = createMockNode({ id: 'frame', zIndex: 'a1' });
    const cardA = createMockNode({ id: 'cardA', parentId: 'frame', zIndex: 'a1' });
    const cardB = createMockNode({ id: 'cardB', parentId: 'frame', zIndex: 'a2' });
    const innerConn = createMockConnector({ id: 'innerConn', fromId: 'cardA', toId: 'cardB', zIndex: 'a1' });

    const nodes = new Map<string, NodeEntity>([
      ['frame', frame],
      ['cardA', cardA],
      ['cardB', cardB]
    ]);
    const getNode = (id?: string) => (id ? nodes.get(id) : undefined);
    const compareNodes = (a: NodeEntity, b: NodeEntity) => compareHierarchicalNodes(a, b, getNode);

    const entries: ContentLayerOrderEntry[] = [
      { kind: 'node', node: cardB, group: null },
      {
        kind: 'connector',
        connector: innerConn,
        group: null,
        anchorNode: resolveConnectorLayerAnchor(innerConn, getNode, compareNodes)
      },
      { kind: 'node', node: frame, group: null },
      { kind: 'node', node: cardA, group: null }
    ];

    entries.sort((a, b) => compareContentLayerEntries(a, b, compareNodes));

    const resultIds = entries.map(e => e.kind === 'node' ? e.node.id : e.connector.id);
    // 预期顺序：frame (背景在最底) -> cardA -> innerConn (伴生于高层 cardB 紧下方) -> cardB (顶层卡片)
    expect(resultIds).toEqual(['frame', 'cardA', 'innerConn', 'cardB']);
  });

  it('跨画框连线穿透：高于低层容器背景，伴随高层容器子节点且在卡片下方', () => {
    const frameA = createMockNode({ id: 'frameA', zIndex: 'a1' });
    const cardInA = createMockNode({ id: 'cardInA', parentId: 'frameA', zIndex: 'a1' });

    const frameB = createMockNode({ id: 'frameB', zIndex: 'a2' });
    const cardInB = createMockNode({ id: 'cardInB', parentId: 'frameB', zIndex: 'a1' });

    const crossConn = createMockConnector({ id: 'crossConn', fromId: 'cardInA', toId: 'cardInB', zIndex: 'a1' });

    const nodes = new Map<string, NodeEntity>([
      ['frameA', frameA],
      ['cardInA', cardInA],
      ['frameB', frameB],
      ['cardInB', cardInB]
    ]);
    const getNode = (id?: string) => (id ? nodes.get(id) : undefined);
    const compareNodes = (a: NodeEntity, b: NodeEntity) => compareHierarchicalNodes(a, b, getNode);

    const entries: ContentLayerOrderEntry[] = [
      { kind: 'node', node: cardInB, group: null },
      { kind: 'node', node: frameB, group: null },
      {
        kind: 'connector',
        connector: crossConn,
        group: null,
        anchorNode: resolveConnectorLayerAnchor(crossConn, getNode, compareNodes)
      },
      { kind: 'node', node: cardInA, group: null },
      { kind: 'node', node: frameA, group: null }
    ];

    entries.sort((a, b) => compareContentLayerEntries(a, b, compareNodes));

    const resultIds = entries.map(e => e.kind === 'node' ? e.node.id : e.connector.id);
    // frameA -> cardInA -> frameB -> crossConn (在 cardInB 紧下方) -> cardInB
    expect(resultIds).toEqual(['frameA', 'cardInA', 'frameB', 'crossConn', 'cardInB']);
  });

  it('同分兄弟节点按 id 决胜，伴生连线紧贴宿主节点下方', () => {
    // 兄弟卡片 A 与 B (zIndex 均为 1，且同属于 root)
    const cardA = createMockNode({ id: 'cardA', zIndex: 'a1' });
    const cardB = createMockNode({ id: 'cardB', zIndex: 'a1' });
    // 连线 connB 伴随 cardB
    const connB = createMockConnector({ id: 'connB', fromId: 'cardB', zIndex: 'a1' });

    const nodes = new Map<string, NodeEntity>([
      ['cardA', cardA],
      ['cardB', cardB]
    ]);
    const getNode = (id?: string) => (id ? nodes.get(id) : undefined);
    const compareNodes = (a: NodeEntity, b: NodeEntity) => compareHierarchicalNodes(a, b, getNode);

    // 输入顺序：cardA (0) -> connB (1) -> cardB (2)
    const entries: ContentLayerOrderEntry[] = [
      { kind: 'node', node: cardB, group: null },
      {
        kind: 'connector',
        connector: connB,
        group: null,
        anchorNode: cardB
      },
      { kind: 'node', node: cardA, group: null }
    ];

    entries.sort((a, b) => compareContentLayerEntries(a, b, compareNodes));

    const resultIds = entries.map(e => e.kind === 'node' ? e.node.id : e.connector.id);
    // 严格满足：cardA -> connB (紧贴 cardB 下方) -> cardB
    expect(resultIds).toEqual(['cardA', 'connB', 'cardB']);
  });
});
