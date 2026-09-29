import './setup';
import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';
import { createLeaferRenderer, type LeaferRenderer } from '../src/leafer-renderer';
import { compareHierarchicalNodes } from '../src/layering/content-layer-order';

function createRandom(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

interface RendererInternals {
  nodeLayer: { shownIds: ReadonlySet<string>; getGroup(id: string): unknown };
}

/** 场景树实际顺序 (节点 id，自下而上) */
function actualOrder(renderer: LeaferRenderer): string[] {
  const internals = renderer as unknown as RendererInternals;
  const groupToId = new Map<unknown, string>();
  for (const id of internals.nodeLayer.shownIds) groupToId.set(internals.nodeLayer.getGroup(id), id);
  return renderer.getContentLayer()!.children.map((child) => groupToId.get(child)!);
}

/** 以比较器对当前挂载节点全量排序得到的期望顺序 */
function expectedOrder(engine: SkyNoteEngine, renderer: LeaferRenderer): string[] {
  const internals = renderer as unknown as RendererInternals;
  const getNode = (id: string) => engine.entityStore.getNode(id)?.entity;
  const shown = [...internals.nodeLayer.shownIds].map((id) => getNode(id)!);
  return shown.sort((a, b) => compareHierarchicalNodes(a, b, getNode)).map((node) => node.id);
}

describe('ContentOrderSync 增量层级同步', () => {
  it('随机平移、调整层级、增删节点与改挂容器后，场景树顺序始终等于全量排序结果', () => {
    const random = createRandom(2024);
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    let seq = 0;
    const addRandomNode = () => {
      const id = `n${seq++}`;
      const parentCandidates = Object.keys(engine.getView().content.nodes);
      const parentId =
        random() < 0.2 && parentCandidates.length > 0
          ? parentCandidates[Math.floor(random() * parentCandidates.length)]
          : undefined;
      const node: NodeEntity = {
        id,
        type: 'node',
        nodeType: 'rect',
        x: Math.floor(random() * 3000),
        y: Math.floor(random() * 2000),
        width: 60,
        height: 40,
        rotation: 0,
        zIndex: store.createTopZIndex(parentId),
        locked: false,
        parentId
      };
      store.addNode(node);
    };
    for (let i = 0; i < 120; i++) addRandomNode();

    const renderer = createLeaferRenderer(engine, { enableFrameScheduler: false });
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1000 });
    Object.defineProperty(container, 'clientHeight', { value: 800 });
    renderer.mount(container);

    for (let step = 0; step < 200; step++) {
      const ids = Object.keys(engine.getView().content.nodes);
      const pick = () => ids[Math.floor(random() * ids.length)];
      const roll = random();
      if (roll < 0.35) {
        renderer.setViewport({ x: -Math.floor(random() * 2200), y: -Math.floor(random() * 1300) });
      } else if (roll < 0.6) {
        const moves = ['forward', 'backward', 'front', 'back'] as const;
        store.moveLayers([pick(), pick()], moves[Math.floor(random() * 4)]);
      } else if (roll < 0.75) {
        addRandomNode();
      } else if (roll < 0.85) {
        store.removeNodes([pick()]);
      } else {
        const child = pick();
        const parent = pick();
        if (child !== parent) store.updateNode(child, { parentId: parent, zIndex: store.createTopZIndex(parent) });
      }
      renderer.renderFrame();
      expect(actualOrder(renderer), `step ${step}`).toEqual(expectedOrder(engine, renderer));
    }
    renderer.destroy();
  });
});
