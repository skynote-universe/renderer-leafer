import './setup';
import { Group } from 'leafer';
import { expect, it, vi } from 'vitest';
import { SkyNoteEngine, createEmptyCanvasDocument } from '@skynote/core';
import type { CanvasPatch } from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';
import type { NodeLayer } from '../src/layers/node-layer';
import type { ConnectorLayer } from '../src/layers/connector-layer';
import { mountSceneGroups, withDetachedBranches } from '../src/layers/scene-subtree-mutation';

const base = {
  type: 'node' as const,
  nodeType: 'rect',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  zIndex: 'a0',
  locked: false
};

it('事务同时反转祖先关系并新建中间容器，撤销重做保留既存图元', () => {
  const doc = createEmptyCanvasDocument();
  doc.content.nodes.a = { ...base, id: 'a' };
  doc.content.nodes.b = { ...base, id: 'b', parentId: 'a' };
  const engine = new SkyNoteEngine({ initialDoc: doc });
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
  const a = layer.getGroup('a')!;
  const b = layer.getGroup('b')!;
  const verify = (changed: boolean): void => {
    expect(layer.getGroup('a') === a && layer.getGroup('b') === b).toBe(true);
    if (changed) {
      expect(b.parent === renderer.contentLayer).toBe(true);
      expect(layer.getGroup('n')!.parent === layer.getChildrenContainer('b')).toBe(true);
      expect(a.parent === layer.getChildrenContainer('n')).toBe(true);
    } else {
      expect(a.parent === renderer.contentLayer).toBe(true);
      expect(b.parent === layer.getChildrenContainer('a')).toBe(true);
      expect(layer.getGroup('n')).toBeUndefined();
    }
  };
  try {
    expect(
      engine.documentStore.commit({
        patches: [
          { op: 'unset', path: ['content', 'nodes', 'b', 'parentId'] },
          { op: 'set', path: ['content', 'nodes', 'n'], value: { ...base, id: 'n', parentId: 'b' } },
          { op: 'set', path: ['content', 'nodes', 'a', 'parentId'], value: 'n' }
        ]
      })
    ).not.toBeNull();
    renderer.renderFrame();
    verify(true);
    engine.documentStore.undo();
    renderer.renderFrame();
    verify(false);
    engine.documentStore.redo();
    renderer.renderFrame();
    verify(true);
  } finally {
    renderer.destroy();
    engine.destroy();
  }
});

it.each([100, 200])('%s层批量改挂及撤销重做只拆装子树并集，保留内部连线', (depth) => {
  const doc = createEmptyCanvasDocument();
  for (let i = 0; i < depth; i++) {
    doc.content.nodes[`p${i}`] = { ...base, id: `p${i}`, ...(i ? { parentId: `p${i - 1}` } : {}) };
    doc.content.nodes[`q${i}`] = { ...base, id: `q${i}`, parentId: `p${i}` };
  }
  for (const id of ['a', 'b'])
    doc.content.nodes[id] = { ...base, id, parentId: `p${depth - 1}`, x: id === 'a' ? 0 : 20 };
  doc.content.connectors.e = {
    id: 'e',
    type: 'connector',
    connectorType: 'straight',
    from: { nodeId: 'a' },
    to: { nodeId: 'b' },
    zIndex: 'a0',
    locked: false
  };
  const engine = new SkyNoteEngine({ initialDoc: doc });
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const { nodeLayer, connectorLayer } = renderer as unknown as { nodeLayer: NodeLayer; connectorLayer: ConnectorLayer };
  const leaf = nodeLayer.getGroup(`p${depth - 1}`);
  const connector = connectorLayer.getGroup('e');
  const removes = vi.spyOn(Group.prototype, 'removeAll');
  const verify = (changed: boolean): void => {
    expect(removes.mock.calls.length).toBeLessThan(depth * 40);
    removes.mockClear();
    for (let i = 1; i < depth; i++)
      expect(
        nodeLayer.getGroup(`p${i}`)!.parent === nodeLayer.getChildrenContainer(`${changed ? 'q' : 'p'}${i - 1}`)
      ).toBe(true);
    expect(nodeLayer.getGroup(`p${depth - 1}`) === leaf).toBe(true);
    expect(connectorLayer.getGroup('e') === connector).toBe(true);
    expect(connector!.parent === nodeLayer.getChildrenContainer(`p${depth - 1}`)).toBe(true);
  };
  try {
    const patches: CanvasPatch[] = Array.from({ length: depth - 1 }, (_, i) => ({
      op: 'set',
      path: ['content', 'nodes', `p${i + 1}`, 'parentId'],
      value: `q${i}`
    }));
    expect(engine.documentStore.commit({ patches })).not.toBeNull();
    renderer.renderFrame();
    verify(true);
    engine.documentStore.undo();
    renderer.renderFrame();
    verify(false);
    engine.documentStore.redo();
    renderer.renderFrame();
    verify(true);
  } finally {
    removes.mockRestore();
    renderer.destroy();
    engine.destroy();
  }
});

it.each([1000, 2000].flatMap((width) => ['nodes', 'connectors'].map((kind) => [width, kind] as const)))(
  '%s个%s批量改挂避免旧父兄弟数组平方搬移',
  (width, kind) => {
    const doc = createEmptyCanvasDocument();
    for (const id of ['source', 'target']) doc.content.nodes[id] = { ...base, id };
    if (kind === 'connectors')
      for (const id of ['a', 'b', 'c', 'd'])
        doc.content.nodes[id] = {
          ...base,
          id,
          parentId: id < 'c' ? 'source' : 'target',
          x: id === 'b' || id === 'd' ? 20 : 0
        };
    const ids = Array.from({ length: width }, (_, i) => `m${i.toString().padStart(5, '0')}`);
    for (const id of ids) {
      if (kind === 'nodes') doc.content.nodes[id] = { ...base, id, parentId: 'source' };
      else
        doc.content.connectors[id] = {
          id,
          type: 'connector',
          connectorType: 'straight',
          from: { nodeId: 'a' },
          to: { nodeId: 'b' },
          zIndex: 'a0',
          locked: false
        };
    }
    const engine = new SkyNoteEngine({ initialDoc: doc });
    const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
    const { nodeLayer, connectorLayer } = renderer as unknown as {
      nodeLayer: NodeLayer;
      connectorLayer: ConnectorLayer;
    };
    const layer = kind === 'nodes' ? nodeLayer : connectorLayer;
    const source = nodeLayer.getChildrenContainer('source')!;
    const target = nodeLayer.getChildrenContainer('target')!;
    const groups = ids.map((id) => layer.getGroup(id)!);
    const members = new Set(groups);
    const originalIndexOf = Array.prototype.indexOf;
    const originalSplice = Array.prototype.splice;
    let work = 0;
    const lookup = vi.spyOn(Array.prototype, 'indexOf').mockImplementation(function (this: unknown[], value, from) {
      const index = originalIndexOf.call(this, value, from);
      if (this === source.children || this === target.children) work += index < 0 ? this.length : index + 1;
      return index;
    });
    const splice = vi.spyOn(Array.prototype, 'splice').mockImplementation(function (
      this: unknown[],
      start,
      count,
      ...items
    ) {
      if ((this === source.children || this === target.children) && count)
        work += Math.max(0, this.length - start - count);
      return originalSplice.call(this, start, count!, ...items);
    });
    const verify = (changed: boolean): void => {
      expect(work).toBeLessThan(width * 8);
      work = 0;
      const parent = changed ? target : source;
      expect(parent.children.filter((group) => members.has(group as Group))).toEqual(groups);
      expect((changed ? source : target).children.some((group) => members.has(group as Group))).toBe(false);
      for (let i = 0; i < ids.length; i++)
        expect(layer.getGroup(ids[i]) === groups[i] && groups[i].parent === parent).toBe(true);
    };
    try {
      const patches: CanvasPatch[] = ids.flatMap((id): CanvasPatch[] =>
        kind === 'nodes'
          ? [{ op: 'set', path: ['content', 'nodes', id, 'parentId'], value: 'target' }]
          : [
              { op: 'set', path: ['content', 'connectors', id, 'from'], value: { nodeId: 'c' } },
              { op: 'set', path: ['content', 'connectors', id, 'to'], value: { nodeId: 'd' } }
            ]
      );
      expect(engine.documentStore.commit({ patches })).not.toBeNull();
      renderer.renderFrame();
      verify(true);
      engine.documentStore.undo();
      renderer.renderFrame();
      verify(false);
      engine.documentStore.redo();
      renderer.renderFrame();
      verify(true);
    } finally {
      lookup.mockRestore();
      splice.mockRestore();
      renderer.destroy();
      engine.destroy();
    }
  }
);

it('12000层最终祖先关系反转按新拓扑恢复，不递归绑定深层分支', () => {
  const root = new Group();
  const groups = Array.from({ length: 12000 }, () => new Group());
  root.add(groups[0]);
  for (let i = 1; i < groups.length; i++) groups[i - 1].add(groups[i]);
  const mounts = new Map<Group, Group>([[groups.at(-1)!, root]]);
  for (let i = groups.length - 2; i >= 0; i--) mounts.set(groups[i], groups[i + 1]);
  try {
    mountSceneGroups(mounts);
    expect(root.children[0] === groups.at(-1)).toBe(true);
    for (let i = 0; i < groups.length - 1; i++) expect(groups[i].parent === groups[i + 1]).toBe(true);
  } finally {
    withDetachedBranches([root], () => root.removeAll(), new Map([[root, { ordered: [] }]]));
    for (const group of groups) group.removeAll();
    for (const group of groups) group.destroy();
    root.destroy();
  }
});

it('单目标换挂不清空旧父或目标容器', () => {
  const source = new Group();
  const target = new Group();
  const member = new Group();
  source.add(member);
  const sourceClear = vi.spyOn(source, 'removeAll');
  const targetClear = vi.spyOn(target, 'removeAll');
  try {
    mountSceneGroups(new Map([[member, target]]));
    expect(member.parent === target).toBe(true);
    expect(sourceClear).not.toHaveBeenCalled();
    expect(targetClear).not.toHaveBeenCalled();
  } finally {
    sourceClear.mockRestore();
    targetClear.mockRestore();
    source.destroy();
    target.destroy();
  }
});
