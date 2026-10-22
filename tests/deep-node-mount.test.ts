import './setup';
import { expect, it, vi } from 'vitest';
import { SkyNoteEngine, createEmptyCanvasDocument, parseCanvasDocument } from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';
import type { NodeLayer } from '../src/layers/node-layer';
import { NodeView } from '../src/node/node-view';

it.each([0, 12000])('12000层离屏祖先初始化、刷新、离场和销毁不溢出，缓存=%s', (offscreenCacheLimit) => {
  const doc = createEmptyCanvasDocument();
  for (let i = 0; i < 12000; i++)
    doc.content.nodes[`n${i}`] = {
      id: `n${i}`,
      type: 'node',
      nodeType: 'rect',
      x: i === 0 ? -1000 : i === 11999 ? 1000 : 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...(i ? { parentId: `n${i - 1}` } : {})
    };
  expect(parseCanvasDocument(JSON.parse(JSON.stringify(doc))).ok).toBe(true);
  const engine = new SkyNoteEngine({ initialDoc: doc });
  expect(engine.spatialIndex.search({ left: 0, top: 0, right: 100, bottom: 100 })).toEqual(['n11999']);
  let renderer: LeaferRenderer | undefined;
  try {
    renderer = new LeaferRenderer(engine, document.createElement('div'), {
      enableFrameScheduler: false,
      offscreenCacheLimit
    });
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    expect(layer.shownIds.size).toBe(12000);
    for (let i = 1; i < 12000; i++)
      expect(layer.getGroup(`n${i}`)!.parent).toBe(layer.getChildrenContainer(`n${i - 1}`));
    renderer.renderFrame();
    expect(layer.shownIds.size).toBe(12000);
    const leaf = layer.getGroup('n11999');
    engine.session.setViewport({ x: -10000, y: 0 });
    renderer.renderFrame();
    expect(layer.shownIds.size).toBe(0);
    expect(layer.cacheCount).toBe(offscreenCacheLimit);
    engine.session.setViewport({ x: 0, y: 0 });
    renderer.renderFrame();
    expect(layer.shownIds.size).toBe(12000);
    if (offscreenCacheLimit) expect(layer.getGroup('n11999')).toBe(leaf);
  } finally {
    renderer?.destroy();
    engine.destroy();
  }
});

it('共享离屏祖先每帧仅更新一次，改挂及父节点删除恢复保留存活图元', () => {
  const doc = createEmptyCanvasDocument();
  for (let i = 0; i < 400; i++)
    doc.content.nodes[`n${i}`] = {
      id: `n${i}`,
      type: 'node',
      nodeType: 'rect',
      x: i ? 0 : -1000,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...(i ? { parentId: `n${i - 1}` } : {})
    };
  for (let i = 0; i < 100; i++)
    doc.content.nodes[`leaf${i}`] = {
      ...doc.content.nodes.n399,
      id: `leaf${i}`,
      x: 1000,
      parentId: 'n399'
    };
  const engine = new SkyNoteEngine({ initialDoc: doc });
  const updates = vi.spyOn(NodeView.prototype, 'update');
  let renderer: LeaferRenderer | undefined;
  try {
    renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    expect(updates).toHaveBeenCalledTimes(500);
    updates.mockClear();
    const reads = vi.spyOn(engine.entityStore, 'getNode');
    try {
      layer.sync(
        Array.from({ length: 100 }, (_, i) => `leaf${i}`),
        () => true,
        {
          viewport: engine.session.viewport,
          isInteracting: false,
          theme: engine.session.theme,
          textEditing: engine.session.textEditing
        },
        'full',
        []
      );
      expect(updates).toHaveBeenCalledTimes(500);
      expect(reads.mock.calls.length).toBeLessThan(1200);
    } finally {
      reads.mockRestore();
    }
    const leaf = layer.getGroup('leaf0')!;
    engine.documentStore.updateNode('leaf0', { parentId: 'n0', x: 1000 });
    renderer.renderFrame();
    expect(leaf.parent).toBe(layer.getChildrenContainer('n0'));
    engine.documentStore.commit({ origin: 'remote', patches: [{ op: 'unset', path: 'content.nodes.n399' }] });
    engine.session.setViewport({ x: -500, y: 0 });
    renderer.renderFrame();
    expect(layer.getGroup('leaf1')!.parent).toBe(renderer.contentLayer);
    engine.documentStore.commit({
      origin: 'remote',
      patches: [{ op: 'set', path: 'content.nodes.n399', value: doc.content.nodes.n399 }]
    });
    engine.session.setViewport({ x: 0, y: 0 });
    renderer.renderFrame();
    expect(layer.getGroup('leaf1')!.parent).toBe(layer.getChildrenContainer('n399'));
    expect(layer.getGroup('leaf0')).toBe(leaf);
    expect(leaf.destroyed).not.toBe(true);
  } finally {
    updates.mockRestore();
    renderer?.destroy();
    engine.destroy();
  }
});
