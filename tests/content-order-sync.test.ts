import './setup';
import { describe, it, expect } from 'vitest';
import type { Group } from 'leafer';
import { SkyNoteEngine, compareHierarchicalNodes } from '@skynote/core';
import type { ConnectorEntity, NodeEntity } from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';
import { compareContentLayerEntries, type ContentLayerOrderEntry } from '../src/layering/content-layer-order';
import type { NodeLayer } from '../src/layers/node-layer';
import type { ConnectorLayer } from '../src/layers/connector-layer';

function createRandom(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

interface RendererInternals {
  nodeLayer: NodeLayer;
  connectorLayer: ConnectorLayer;
}

function internalsOf(renderer: LeaferRenderer): RendererInternals {
  return renderer as unknown as RendererInternals;
}

/** 场景树中节点的实际绘制顺序 (深度优先，自下而上) */
function paintOrder(renderer: LeaferRenderer): string[] {
  const { nodeLayer } = internalsOf(renderer);
  const groupToId = new Map<unknown, string>();
  for (const id of nodeLayer.shownIds) groupToId.set(nodeLayer.getGroup(id), id);
  const result: string[] = [];
  const walk = (container: Group): void => {
    for (const child of container.children) {
      const id = groupToId.get(child);
      if (id === undefined) continue;
      result.push(id);
      // 外层组的子图元为 [内容组, 子容器?]
      const childrenContainer = (child as Group).children[1] as Group | undefined;
      if (childrenContainer) walk(childrenContainer);
    }
  };
  walk(renderer.contentLayer);
  return result;
}

/** 独立推导每个容器应有的条目与顺序，并与场景树逐容器比对 */
function expectContainersMatch(engine: SkyNoteEngine, renderer: LeaferRenderer, step: number): void {
  const { nodeLayer, connectorLayer } = internalsOf(renderer);
  const getNode = (id: string) => engine.entityStore.getNode(id)?.entity;
  const containerOf = (containerId: string | undefined): Group =>
    containerId === undefined ? renderer.contentLayer : nodeLayer.getChildrenContainer(containerId)!;

  const expected = new Map<Group, ContentLayerOrderEntry<Group>[]>();
  const push = (container: Group, entry: ContentLayerOrderEntry<Group>) => {
    if (!expected.has(container)) expected.set(container, []);
    expected.get(container)!.push(entry);
  };
  for (const id of nodeLayer.shownIds) {
    const node = getNode(id)!;
    push(containerOf(node.parentId !== undefined && getNode(node.parentId) ? node.parentId : undefined), {
      kind: 'node',
      node,
      group: nodeLayer.getGroup(id)!
    });
  }
  for (const id of connectorLayer.shownIds) {
    const placement = connectorLayer.getPlacement(id)!;
    push(containerOf(placement.containerId), {
      kind: 'connector',
      connector: engine.entityStore.getConnector(id)!.entity as ConnectorEntity,
      group: connectorLayer.getGroup(id)!,
      anchorNode: placement.anchorNode
    });
  }
  for (const [container, entries] of expected) {
    entries.sort(compareContentLayerEntries);
    expect(container.children, `step ${step}`).toEqual(entries.map((entry) => entry.group));
  }
}

describe('ContentOrderSync 按容器增量层级同步 (ADR-114)', () => {
  it('随机平移、调整层级、增删节点与连线、改挂容器后，场景树结构与各容器顺序始终正确', () => {
    const random = createRandom(2024);
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    let seq = 0;
    const pickFrom = (ids: string[]) => ids[Math.floor(random() * ids.length)];
    const addRandomNode = () => {
      const id = `n${seq++}`;
      const candidates = Object.keys(engine.documentStore.getView().content.nodes);
      const parentId = random() < 0.3 && candidates.length > 0 ? pickFrom(candidates) : undefined;
      const node: NodeEntity = {
        id,
        type: 'node',
        nodeType: 'rect',
        // 子节点坐标相对父容器，放在父框附近
        x: parentId ? Math.floor(random() * 80) : Math.floor(random() * 3000),
        y: parentId ? Math.floor(random() * 60) : Math.floor(random() * 2000),
        width: 60,
        height: 40,
        rotation: 0,
        zIndex: store.createTopZIndex(parentId),
        locked: false,
        parentId
      };
      store.addNode(node);
    };
    const addRandomConnector = () => {
      const ids = Object.keys(engine.documentStore.getView().content.nodes);
      if (ids.length < 2) return;
      const id = `c${seq++}`;
      store.commit({
        patches: [
          {
            op: 'set',
            path: ['content', 'connectors', id],
            value: {
              id,
              type: 'connector',
              connectorType: 'straight',
              from: { nodeId: pickFrom(ids) },
              to: { nodeId: pickFrom(ids) },
              zIndex: 'a0',
              locked: false
            }
          }
        ]
      });
    };
    for (let i = 0; i < 120; i++) addRandomNode();
    for (let i = 0; i < 40; i++) addRandomConnector();

    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1000 });
    Object.defineProperty(container, 'clientHeight', { value: 800 });
    const renderer = new LeaferRenderer(engine, container, { enableFrameScheduler: false });
    const getNode = (id: string) => engine.entityStore.getNode(id)?.entity;

    for (let step = 0; step < 250; step++) {
      const ids = Object.keys(engine.documentStore.getView().content.nodes);
      const roll = random();
      if (roll < 0.3) {
        engine.session.setViewport({ x: -Math.floor(random() * 2200), y: -Math.floor(random() * 1300) });
      } else if (roll < 0.5) {
        const moves = ['forward', 'backward', 'front', 'back'] as const;
        store.moveLayers([pickFrom(ids), pickFrom(ids)], moves[Math.floor(random() * 4)]);
      } else if (roll < 0.62) {
        addRandomNode();
      } else if (roll < 0.7) {
        addRandomConnector();
      } else if (roll < 0.8) {
        store.removeEntities({ nodeIds: [pickFrom(ids)] });
      } else if (roll < 0.9) {
        // 改挂到随机容器或移出到根层级 (会成环的改挂被提交守卫拒绝)
        const target = random() < 0.25 ? undefined : pickFrom(ids);
        const originalError = console.error;
        console.error = () => {};
        store.reparentNodes([pickFrom(ids)], target);
        console.error = originalError;
      } else {
        store.moveEntities({ nodeIds: [pickFrom(ids)] }, { x: Math.floor(random() * 200) - 100 });
      }
      renderer.renderFrame();

      const shownNodes = [...internalsOf(renderer).nodeLayer.shownIds].map((id) => getNode(id)!);
      const expectedPaint = shownNodes.sort((a, b) => compareHierarchicalNodes(a, b, getNode)).map((n) => n.id);
      expect(paintOrder(renderer), `step ${step}`).toEqual(expectedPaint);
      expectContainersMatch(engine, renderer, step);
    }
    renderer.destroy();
  });
});
