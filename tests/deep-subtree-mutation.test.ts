import './setup';
import { expect, it, vi } from 'vitest';
import { Group } from 'leafer-ui';
import { SkyNoteEngine, createEmptyCanvasDocument } from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';
import type { NodeLayer } from '../src/layers/node-layer';
import type { ConnectorLayer } from '../src/layers/connector-layer';

it.each([200, 400])('%s层整树删除不逐祖先重复拆装后代', (depth) => {
  const doc = createEmptyCanvasDocument();
  for (let i = 0; i < depth; i++)
    doc.content.nodes[`n${i}`] = {
      id: `n${i}`,
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...(i ? { parentId: `n${i - 1}` } : {})
    };
  const engine = new SkyNoteEngine({ initialDoc: doc });
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const removes = vi.spyOn(Group.prototype, 'remove');
  try {
    engine.documentStore.removeEntities({ nodeIds: ['n0'] });
    renderer.renderFrame();
    expect(removes.mock.calls.length).toBeLessThan(depth * 20);
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    expect(layer.cacheCount).toBe(0);
  } finally {
    removes.mockRestore();
    renderer.destroy();
    engine.destroy();
  }
});

it.each(['delete-tree', 'delete-shell', 'reparent', 'reorder'] as const)(
  '12000层已挂载子树%s及撤销重做不溢出',
  (mode) => {
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
    for (let i = 1; i <= 3; i++)
      doc.content.nodes[`other${i}`] = {
        ...doc.content.nodes.n0,
        id: `other${i}`,
        x: 0,
        zIndex: `a${i}`
      };
    doc.content.nodes.peer = { ...doc.content.nodes.n11999, id: 'peer', zIndex: 'a1' };
    doc.content.connectors.inner = {
      id: 'inner',
      type: 'connector',
      connectorType: 'straight',
      from: { nodeId: 'n11999' },
      to: { nodeId: 'peer' },
      zIndex: 'a0',
      locked: false
    };
    const engine = new SkyNoteEngine({ initialDoc: doc });
    const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    const connectors = (renderer as unknown as { connectorLayer: ConnectorLayer }).connectorLayer;
    const leaf = layer.getGroup('n11999');
    const connector = connectors.getGroup('inner');
    const verify = (changed: boolean): void => {
      if (mode === 'delete-tree' && changed) {
        expect(layer.getGroup('n11999')).toBeUndefined();
        expect(connectors.getGroup('inner')).toBeUndefined();
        return;
      }
      expect(layer.getGroup('n11999')).toBeDefined();
      expect(layer.getGroup('n11999')!.parent === layer.getChildrenContainer('n11998')).toBe(true);
      expect(connectors.getGroup('inner')!.parent === layer.getChildrenContainer('n11998')).toBe(true);
      if (mode !== 'delete-tree') {
        expect(layer.getGroup('n11999') === leaf).toBe(true);
        expect(connectors.getGroup('inner') === connector).toBe(true);
      }
      if (mode === 'reparent')
        expect(
          layer.getGroup('n0')!.parent === (changed ? layer.getChildrenContainer('other1') : renderer.contentLayer)
        ).toBe(true);
      if (mode === 'reorder') {
        const expected = changed ? ['other1', 'other2', 'other3', 'n0'] : ['n0', 'other1', 'other2', 'other3'];
        expect(
          renderer.contentLayer.children.map((group) => expected.find((id) => layer.getGroup(id) === group))
        ).toEqual(expected);
      }
    };
    try {
      if (mode === 'delete-tree') expect(engine.documentStore.removeEntities({ nodeIds: ['n0'] })).not.toBeNull();
      else if (mode === 'delete-shell')
        expect(engine.documentStore.commit({ patches: [{ op: 'unset', path: 'content.nodes.n0' }] })).not.toBeNull();
      else if (mode === 'reparent')
        expect(engine.documentStore.updateNode('n0', { parentId: 'other1' })).not.toBeNull();
      else expect(engine.documentStore.updateNode('n0', { zIndex: 'a4' })).not.toBeNull();
      if (mode === 'delete-shell') engine.session.setViewport({ x: -500, y: 0 });
      renderer.renderFrame();
      verify(true);
      engine.documentStore.undo();
      if (mode === 'delete-shell') engine.session.setViewport({ x: 0, y: 0 });
      renderer.renderFrame();
      verify(false);
      engine.documentStore.redo();
      if (mode === 'delete-shell') engine.session.setViewport({ x: -500, y: 0 });
      renderer.renderFrame();
      verify(true);
    } finally {
      renderer.destroy();
      engine.destroy();
    }
  }
);
