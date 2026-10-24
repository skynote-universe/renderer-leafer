import './setup';
import { Group, Rect } from 'leafer-ui';
import { expect, it, vi } from 'vitest';
import { SkyNoteEngine, createEmptyCanvasDocument, generateNKeysBetween } from '@skynote/core';
import type { CanvasPatch } from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';
import type { NodeLayer } from '../src/layers/node-layer';
import type { ConnectorLayer } from '../src/layers/connector-layer';
import { withDetachedBranches } from '../src/layers/scene-subtree-mutation';

it('祖先少量移动和后代批量换序共用计划，撤销重做保留图元', () => {
  const doc = createEmptyCanvasDocument();
  const keys = generateNKeysBetween(null, null, 20);
  const base = {
    type: 'node' as const,
    nodeType: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    locked: false
  };
  doc.content.nodes.p = { ...base, id: 'p', zIndex: 'a0' };
  for (let i = 1; i <= 3; i++) doc.content.nodes[`s${i}`] = { ...base, id: `s${i}`, zIndex: `a${i}` };
  const ids = keys.map((_, i) => `c${i}`);
  for (let i = 0; i < ids.length; i++)
    doc.content.nodes[ids[i]] = { ...base, id: ids[i], zIndex: keys[i], parentId: 'p' };
  const engine = new SkyNoteEngine({ initialDoc: doc });
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
  const parent = layer.getGroup('p')!;
  const children = ids.map((id) => layer.getGroup(id)!);
  const verify = (reverse: boolean): void => {
    expect(renderer.contentLayer.children[reverse ? 3 : 0] === parent).toBe(true);
    expect(layer.getChildrenContainer('p')!.children).toEqual(reverse ? [...children].reverse() : children);
  };
  try {
    const patches: CanvasPatch[] = ids.map((id, i) => ({
      op: 'set',
      path: ['content', 'nodes', id, 'zIndex'],
      value: keys[19 - i]
    }));
    patches.push({ op: 'set', path: ['content', 'nodes', 'p', 'zIndex'], value: 'a4' });
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
    renderer.destroy();
    engine.destroy();
  }
});

it.each([100, 200].flatMap((depth) => ['reorder', 'reentry'].map((mode) => [depth, mode] as const)))(
  '%s层容器%s的小更新集合只拆装子树并集一次',
  (depth, mode) => {
    const doc = createEmptyCanvasDocument();
    const base = {
      type: 'node' as const,
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      locked: false
    };
    for (let i = 0; i < depth; i++) {
      const parent = i ? { parentId: `p${i - 1}` } : {};
      doc.content.nodes[`p${i}`] = { ...base, ...parent, id: `p${i}`, zIndex: mode === 'reentry' ? 'a4' : 'a0' };
      for (let j = 1; j <= 3; j++)
        doc.content.nodes[`s${i}_${j}`] = { ...base, ...parent, id: `s${i}_${j}`, zIndex: `a${j}` };
    }
    const engine = new SkyNoteEngine({ initialDoc: doc });
    const renderer = new LeaferRenderer(engine, document.createElement('div'), {
      enableFrameScheduler: false,
      offscreenCacheLimit: depth * 4
    });
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    const leaf = layer.getGroup(`p${depth - 1}`);
    if (mode === 'reentry') {
      engine.session.setViewport({ x: -10000, y: 0 });
      renderer.renderFrame();
    }
    const removes = vi.spyOn(Group.prototype, 'removeAll');
    const verify = (last: boolean): void => {
      for (let i = 0; i < depth; i++) {
        const parent = i ? layer.getChildrenContainer(`p${i - 1}`)! : renderer.contentLayer;
        expect(parent.children.length).toBe(4);
        expect(parent.children[last ? 3 : 0] === layer.getGroup(`p${i}`)).toBe(true);
        expect(layer.getGroup(`p${i}`)!.parent === parent).toBe(true);
      }
      expect(layer.getGroup(`p${depth - 1}`) === leaf).toBe(true);
    };
    try {
      if (mode === 'reentry') engine.session.setViewport({ x: 0, y: 0 });
      else {
        const patches: CanvasPatch[] = Array.from({ length: depth }, (_, i) => ({
          op: 'set',
          path: ['content', 'nodes', `p${i}`, 'zIndex'],
          value: 'a4'
        }));
        expect(engine.documentStore.commit({ patches })).not.toBeNull();
      }
      renderer.renderFrame();
      expect(removes.mock.calls.length).toBeLessThan(depth * 40);
      removes.mockRestore();
      verify(true);
      if (mode === 'reorder') {
        engine.documentStore.undo();
        renderer.renderFrame();
        verify(false);
        engine.documentStore.redo();
        renderer.renderFrame();
        verify(true);
      }
    } finally {
      removes.mockRestore();
      renderer.destroy();
      engine.destroy();
    }
  }
);

it.each([1000, 2000].flatMap((width) => ['delete', 'partial', 'destroyAll'].map((mode) => [width, mode] as const)))(
  '%s条连线%s先批量摘除再释放，保留混合兄弟',
  (width, mode) => {
    const doc = createEmptyCanvasDocument();
    const ids = Array.from({ length: width }, (_, i) => `e${i.toString().padStart(5, '0')}`);
    for (const id of ids)
      doc.content.connectors[id] = {
        id,
        type: 'connector',
        connectorType: 'straight',
        from: { position: { x: 0, y: 0 } },
        to: { position: { x: 100, y: 100 } },
        zIndex: 'a0',
        locked: false
      };
    for (const id of ['n0', 'n1'])
      doc.content.nodes[id] = {
        id,
        type: 'node',
        nodeType: 'rect',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        zIndex: 'a0',
        locked: false
      };
    const engine = new SkyNoteEngine({ initialDoc: doc });
    const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
    const { nodeLayer, connectorLayer } = renderer as unknown as {
      nodeLayer: NodeLayer;
      connectorLayer: ConnectorLayer;
    };
    const parent = renderer.contentLayer;
    const deleted = new Set(mode === 'partial' ? ids.filter((_, i) => i % 2 === 0) : ids);
    const deletedGroups = new Set([...deleted].map((id) => connectorLayer.getGroup(id)));
    const survivors = parent.children.filter(
      (group) => group !== nodeLayer.getGroup('n0') && !deletedGroups.has(group as Group)
    );
    const expected = mode === 'destroyAll' ? [nodeLayer.getGroup('n0')!, ...survivors] : survivors;
    const before = [...parent.children];
    const retained = nodeLayer.getGroup('n1');
    const budget = trackSiblingWork(parent);
    try {
      if (mode === 'destroyAll') connectorLayer.destroyAll();
      else engine.documentStore.removeEntities({ nodeIds: ['n0'], connectorIds: [...deleted] });
      if (mode !== 'destroyAll') renderer.renderFrame();
      budget.check(width + 2);
      budget.restore();
      expect(connectorLayer.cacheCount).toBe(width - deleted.size);
      expect(parent.children).toEqual(expected);
      expect(nodeLayer.getGroup('n1') === retained).toBe(true);
      if (mode !== 'destroyAll') {
        engine.documentStore.undo();
        renderer.renderFrame();
        expect(connectorLayer.cacheCount).toBe(width);
        expect(parent.children.length).toBe(before.length);
        expect(parent.children.filter((group) => expected.includes(group))).toEqual(expected);
        engine.documentStore.redo();
        renderer.renderFrame();
        expect(parent.children).toEqual(expected);
      }
    } finally {
      budget.restore();
      renderer.destroy();
      engine.destroy();
    }
  }
);

it.each([1000, 2000].flatMap((width) => ['reentry', 'reorder'].map((mode) => [width, mode] as const)))(
  '%s成员%s逆序层叠按批次回写',
  (width, mode) => {
    const doc = createEmptyCanvasDocument();
    const keys = generateNKeysBetween(null, null, width);
    doc.content.nodes.p = {
      id: 'p',
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };
    const ids = Array.from({ length: width }, (_, i) => `c${i.toString().padStart(5, '0')}`);
    for (let i = 0; i < width; i++)
      doc.content.nodes[ids[i]] = {
        ...doc.content.nodes.p,
        id: ids[i],
        parentId: 'p',
        zIndex: keys[mode === 'reentry' ? width - i - 1 : i]
      };
    const engine = new SkyNoteEngine({ initialDoc: doc });
    const renderer = new LeaferRenderer(engine, document.createElement('div'), {
      enableFrameScheduler: false,
      offscreenCacheLimit: width + 1
    });
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    const parent = layer.getChildrenContainer('p')!;
    const first = layer.getGroup(ids[0]);
    if (mode === 'reentry') {
      engine.session.setViewport({ x: -10000, y: 0 });
      renderer.renderFrame();
    }
    const budget = trackSiblingWork(parent);
    try {
      if (mode === 'reentry') engine.session.setViewport({ x: 0, y: 0 });
      else {
        const patches: CanvasPatch[] = ids.map((id, i) => ({
          op: 'set',
          path: ['content', 'nodes', id, 'zIndex'],
          value: keys[width - i - 1]
        }));
        expect(engine.documentStore.commit({ patches })).not.toBeNull();
      }
      renderer.renderFrame();
      budget.check(width);
      budget.restore();
      expect(parent.children.length).toBe(width);
      expect(parent.children.every((group, i) => group === layer.getGroup(ids[width - i - 1]))).toBe(true);
      expect(layer.getGroup(ids[0]) === first).toBe(true);
      if (mode === 'reorder') {
        engine.documentStore.undo();
        renderer.renderFrame();
        expect(parent.children.every((group, i) => group === layer.getGroup(ids[i]))).toBe(true);
        engine.documentStore.redo();
        renderer.renderFrame();
        expect(parent.children.every((group, i) => group === layer.getGroup(ids[width - i - 1]))).toBe(true);
      }
    } finally {
      budget.restore();
      renderer.destroy();
      engine.destroy();
    }
  }
);

it.each([100, 200])('%s层保留容器的部分离场只拆装子树并集一次', (depth) => {
  const doc = createEmptyCanvasDocument();
  for (let i = 0; i < depth; i++) {
    const id = `p${i}`;
    doc.content.nodes[id] = {
      id,
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 1000,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      ...(i ? { parentId: `p${i - 1}` } : {})
    };
    for (const label of ['a', 'b'])
      doc.content.nodes[`${label}${i}`] = {
        ...doc.content.nodes[id],
        id: `${label}${i}`,
        parentId: id,
        x: label === 'a' ? 0 : 20,
        width: 10
      };
    for (const label of ['e', 'f'])
      doc.content.connectors[`${label}${i}`] = {
        id: `${label}${i}`,
        type: 'connector',
        connectorType: 'straight',
        from: { nodeId: `a${i}` },
        to: { nodeId: `b${i}` },
        zIndex: 'a0',
        locked: false
      };
  }
  const engine = new SkyNoteEngine({ initialDoc: doc });
  const renderer = new LeaferRenderer(engine, document.createElement('div'), {
    enableFrameScheduler: false,
    offscreenCacheLimit: 10000
  });
  const { nodeLayer, connectorLayer } = renderer as unknown as { nodeLayer: NodeLayer; connectorLayer: ConnectorLayer };
  const first = nodeLayer.getGroup('p0');
  const connector = connectorLayer.getGroup('e0');
  const removes = vi.spyOn(Group.prototype, 'removeAll');
  try {
    engine.session.setViewport({ x: -500, y: 0 });
    renderer.renderFrame();
    expect(removes.mock.calls.length).toBeLessThan(depth * 40);
    removes.mockRestore();
    expect(nodeLayer.shownIds.size).toBe(depth);
    expect(connectorLayer.shownIds.size).toBe(0);
    expect(nodeLayer.cacheCount).toBe(depth * 3);
    expect(connectorLayer.cacheCount).toBe(depth * 2);
    for (let i = 1; i < depth; i++)
      expect(nodeLayer.getGroup(`p${i}`)!.parent === nodeLayer.getChildrenContainer(`p${i - 1}`)).toBe(true);
    engine.session.setViewport({ x: 0, y: 0 });
    renderer.renderFrame();
    expect(nodeLayer.getGroup('p0') === first).toBe(true);
    expect(connectorLayer.getGroup('e0') === connector).toBe(true);
    expect(connector!.parent === nodeLayer.getChildrenContainer('p0')).toBe(true);
  } finally {
    removes.mockRestore();
    renderer.destroy();
    engine.destroy();
  }
});

it('单个层叠更新不批量重挂父容器', () => {
  const doc = createEmptyCanvasDocument();
  const keys = generateNKeysBetween(null, null, 20);
  for (let i = 0; i < 20; i++)
    doc.content.nodes[`n${i}`] = {
      id: `n${i}`,
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex: keys[i],
      locked: false
    };
  const engine = new SkyNoteEngine({ initialDoc: doc });
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
  const first = layer.getGroup('n0');
  const clears = vi.spyOn(renderer.contentLayer, 'removeAll');
  try {
    engine.documentStore.updateNode('n0', { zIndex: generateNKeysBetween(keys[19], null, 1)[0] });
    renderer.renderFrame();
    expect(clears).not.toHaveBeenCalled();
    expect(renderer.contentLayer.children.at(-1) === first).toBe(true);
  } finally {
    clears.mockRestore();
    renderer.destroy();
    engine.destroy();
  }
});

it.each(
  [1000, 2000].flatMap((width) =>
    [0, 10000].flatMap((cache) => ['nodes', 'connectors'].map((kind) => [width, cache, kind] as const))
  )
)('%s成员离场及回场满足宽度预算，缓存%s，种类%s', (width, cache, kind) => {
  const doc = createEmptyCanvasDocument();
  if (kind === 'nodes') {
    doc.content.nodes.p = {
      id: 'p',
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };
    for (let i = 0; i < width; i++) {
      const id = `c${i.toString().padStart(5, '0')}`;
      doc.content.nodes[id] = { ...doc.content.nodes.p, id, parentId: 'p' };
    }
  } else {
    for (let i = 0; i < width; i++) {
      const id = `e${i.toString().padStart(5, '0')}`;
      doc.content.connectors[id] = {
        id,
        type: 'connector',
        connectorType: 'straight',
        from: { position: { x: 0, y: 0 } },
        to: { position: { x: 100, y: 100 } },
        zIndex: 'a0',
        locked: false
      };
    }
  }
  const engine = new SkyNoteEngine({ initialDoc: doc });
  const renderer = new LeaferRenderer(engine, document.createElement('div'), {
    enableFrameScheduler: false,
    offscreenCacheLimit: cache
  });
  const { nodeLayer, connectorLayer } = renderer as unknown as { nodeLayer: NodeLayer; connectorLayer: ConnectorLayer };
  const layer = kind === 'nodes' ? nodeLayer : connectorLayer;
  const firstId = kind === 'nodes' ? 'c00000' : 'e00000';
  const first = layer.getGroup(firstId)!;
  const parent = kind === 'nodes' ? nodeLayer.getChildrenContainer('p')! : renderer.contentLayer;
  const budget = trackSiblingWork(parent);
  try {
    engine.session.setViewport({ x: -10000, y: 0 });
    renderer.renderFrame();
    budget.check(width);
    budget.restore();
    expect(layer.shownIds.size).toBe(0);
    expect(layer.cacheCount).toBe(cache ? width + (kind === 'nodes' ? 1 : 0) : 0);
    engine.session.setViewport({ x: 0, y: 0 });
    renderer.renderFrame();
    expect(layer.shownIds.size).toBe(width + (kind === 'nodes' ? 1 : 0));
    expect(layer.getGroup(firstId) === first).toBe(cache > 0);
  } finally {
    budget.restore();
    renderer.destroy();
    engine.destroy();
  }
});

/** 跟踪当前兄弟数组，公开批量API替换数组后仍统计，避免预算漏掉新数组的成本。 */
function trackSiblingWork(parent: Group) {
  const originalIndexOf = Array.prototype.indexOf;
  const originalSplice = Array.prototype.splice;
  let comparisons = 0;
  let shifts = 0;
  const indexOf = vi.spyOn(Array.prototype, 'indexOf').mockImplementation(function (this: unknown[], value, from) {
    const index = originalIndexOf.call(this, value, from);
    if (this === parent.children) comparisons += index < 0 ? this.length : index + 1;
    return index;
  });
  const splice = vi.spyOn(Array.prototype, 'splice').mockImplementation(function (
    this: unknown[],
    start,
    count,
    ...items
  ) {
    if (this === parent.children && count) shifts += Math.max(0, this.length - start - count);
    return originalSplice.call(this, start, count!, ...items);
  });
  return {
    check: (width: number): void => {
      expect(comparisons).toBeLessThan(width * 4);
      expect(shifts).toBeLessThan(width * 4);
    },
    restore: (): void => {
      indexOf.mockRestore();
      splice.mockRestore();
    }
  };
}

it.each([1000, 2000])('%s个分支与混排叶子拆装避免平方查找和搬移', (width) => {
  const root = new Group();
  const children = Array.from({ length: width }, () => new Group());
  const marker = new Rect();
  for (const child of children) root.add(child);
  root.addAt(marker, width / 2);
  const expected = [...root.children];
  const budget = trackSiblingWork(root);
  try {
    withDetachedBranches([root], () => {});
    budget.check(width);
    expect(root.children).toEqual(expected);
  } finally {
    budget.restore();
    root.destroy();
  }
});

it.each([1000, 2000].flatMap((width) => ['reorder', 'delete', 'partial'].map((mode) => [width, mode] as const)))(
  '%s成员真实容器%s避免平方兄弟数组成本',
  (width, mode) => {
    const doc = createEmptyCanvasDocument();
    doc.content.nodes.p = {
      id: 'p',
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };
    const ids = Array.from({ length: width }, (_, i) => `c${i.toString().padStart(5, '0')}`);
    for (const id of ids) doc.content.nodes[id] = { ...doc.content.nodes.p, id, parentId: 'p' };
    for (let i = 1; i <= 3; i++) doc.content.nodes[`s${i}`] = { ...doc.content.nodes.p, id: `s${i}`, zIndex: `a${i}` };
    const engine = new SkyNoteEngine({ initialDoc: doc });
    const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    const parent = layer.getChildrenContainer('p')!;
    const survivors = ids.filter((_, i) => i % 2 === 1).map((id) => layer.getGroup(id)!);
    const budget = trackSiblingWork(parent);
    try {
      if (mode === 'reorder') engine.documentStore.updateNode('p', { zIndex: 'a4' });
      else
        engine.documentStore.removeEntities({ nodeIds: mode === 'delete' ? ['p'] : ids.filter((_, i) => i % 2 === 0) });
      renderer.renderFrame();
      budget.check(width);
      budget.restore();
      if (mode === 'reorder') {
        expect(parent.children.length).toBe(width);
        expect(renderer.contentLayer.children.at(-1) === layer.getGroup('p')).toBe(true);
      } else if (mode === 'delete') expect(layer.cacheCount).toBe(3);
      else expect(parent.children).toEqual(survivors);
      engine.documentStore.undo();
      renderer.renderFrame();
      expect(layer.getChildrenContainer('p')!.children.length).toBe(width);
      engine.documentStore.redo();
      renderer.renderFrame();
      if (mode === 'partial') expect(parent.children).toEqual(survivors);
    } finally {
      budget.restore();
      renderer.destroy();
      engine.destroy();
    }
  }
);
