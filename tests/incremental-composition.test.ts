import './setup';
import { expect, it, vi } from 'vitest';
import {
  SkyNoteEngine,
  DARK_CANVAS_THEME_SEED,
  getRunsText,
  type NodeComposeContext,
  type NodeDataPath,
  type NodeCompositionPart,
  type NodeEntity,
  type NodeTypeDefinition,
  type TextPrimitive
} from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';
import { PrimitiveMapper } from '../src/primitives/primitive-mapper';
import type { NodeLayer } from '../src/layers/node-layer';
import { Box, Rect, type Group } from 'leafer-ui';

function setup() {
  const engine = new SkyNoteEngine({ fonts: { measureWidth: (text) => text.length * 7 } });
  const part = (node: NodeEntity, index: number): NodeCompositionPart => ({
    id: String(index),
    primitives: [
      {
        kind: 'text',
        id: node.textBlocks![index].id,
        x: 0,
        y: index * 30,
        width: 100,
        height: 30,
        runs: node.textBlocks![index].runs,
        style: { fontSize: 14, color: '$ink' }
      }
    ]
  });
  const full = vi.fn((node: NodeEntity) => [part(node, 0), part(node, 1)]);
  const partial = vi.fn((node: NodeEntity, _context: NodeComposeContext, paths: readonly NodeDataPath[]) =>
    paths.some((path) => path[0] !== 'textBlocks' || path.length < 3)
      ? null
      : [...new Set<number>(paths.map((path) => Number(path[1])))].map((index) => part(node, index))
  );
  const definition: NodeTypeDefinition = {
    type: 'parts',
    label: '分片',
    defaultData: {},
    createContent: () => ({
      width: 100,
      height: 60,
      textBlocks: [
        { id: 'first', runs: [{ text: '甲' }] },
        { id: 'second', runs: [{ text: '乙' }] }
      ]
    }),
    composeParts: full,
    composeChangedParts: partial
  };
  engine.nodeTypes.register(definition);
  const id = engine.documentStore.createNode({ nodeType: 'parts', x: 0, y: 0 })!;
  const reconcile = vi.spyOn(PrimitiveMapper.prototype, 'reconcile');
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
  const content = layer.getGroup(id)!.children[0] as Group;
  const write = (index: number, text: string) =>
    engine.documentStore.commit({
      label: '修改分片',
      patches: [{ op: 'set', path: ['content', 'nodes', id, 'textBlocks', index, 'runs'], value: [{ text }] }]
    });
  full.mockClear();
  reconcile.mockClear();
  const destroy = () => {
    renderer.destroy();
    engine.destroy();
    reconcile.mockRestore();
  };
  return { engine, renderer, layer, content, full, partial, reconcile, write, id, destroy };
}

it('同帧多次提交按分片去重，只重算受影响图元，未修改的文字图元保持原实例', () => {
  const { engine, renderer, content, full, partial, reconcile, write, destroy } = setup();
  try {
    const untouched = (content.children[1] as Group).children[0];
    write(0, '甲一');
    engine.documentStore.createNode({ nodeType: 'parts', x: 10000, y: 10000 });
    write(0, '甲二');
    renderer.renderFrame();
    expect(full).not.toHaveBeenCalled();
    expect(partial).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((content.children[1] as Group).children[0]).toBe(untouched);
    write(0, '甲三');
    write(1, '乙一');
    renderer.renderFrame();
    expect(reconcile).toHaveBeenCalledTimes(3);
  } finally {
    destroy();
  }
});

it('编辑视图切换只刷新相关文字分片，离屏期间累积变化在回场后应用，撤销重做不丢失', () => {
  const { engine, renderer, full, reconcile, write, id, destroy } = setup();
  try {
    engine.session.setTextEditing({ kind: 'node', id, blockId: 'first', scrollY: 10, composition: null });
    renderer.renderFrame();
    expect(reconcile).toHaveBeenCalledTimes(1);
    engine.session.setTextEditing({
      kind: 'node',
      id,
      blockId: 'first',
      scrollY: 10,
      composition: { offset: 1, text: '中', style: {} }
    });
    renderer.renderFrame();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(getRunsText((reconcile.mock.calls.at(-1)![2][0] as TextPrimitive).runs)).toBe('甲中');
    engine.session.setTextEditing({ kind: 'node', id, blockId: 'second', scrollY: 0, composition: null });
    renderer.renderFrame();
    expect(reconcile).toHaveBeenCalledTimes(4);
    engine.session.setTextEditing(null);
    renderer.renderFrame();
    reconcile.mockClear();
    engine.session.setViewport({ x: -10000, y: 0 });
    renderer.renderFrame();
    write(0, '离屏修改');
    renderer.renderFrame();
    expect(reconcile).not.toHaveBeenCalled();
    engine.session.setViewport({ x: 0, y: 0 });
    renderer.renderFrame();
    expect(full).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    engine.documentStore.undo();
    renderer.renderFrame();
    engine.documentStore.redo();
    renderer.renderFrame();
    expect(reconcile).toHaveBeenCalledTimes(3);
  } finally {
    destroy();
  }
});

it('整体替换、主题切换和增量异常退回完整绘制；异常后可以恢复并释放分片', () => {
  const { engine, renderer, layer, full, partial, write, id, destroy } = setup();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    engine.documentStore.updateNode(id, {
      textBlocks: [
        { id: 'first', runs: [{ text: '替换' }] },
        { id: 'second', runs: [{ text: '保留' }] }
      ]
    });
    renderer.renderFrame();
    expect(full).toHaveBeenCalledTimes(1);
    engine.session.setTheme({ seed: DARK_CANVAS_THEME_SEED });
    renderer.renderFrame();
    expect(full).toHaveBeenCalledTimes(2);
    partial.mockImplementationOnce(() => {
      throw new Error('测试分片异常');
    });
    write(0, '异常');
    renderer.renderFrame();
    expect(errors).toHaveBeenCalled();
    write(0, '恢复');
    renderer.renderFrame();
    expect(full).toHaveBeenCalledTimes(3);
    layer.destroy(id);
    expect(layer.getGroup(id)).toBeUndefined();
  } finally {
    errors.mockRestore();
    destroy();
  }
});

it('一万个分片修改一项只协调一个原生图元组，保持其他实例及层叠顺序', () => {
  const engine = new SkyNoteEngine();
  const part = (node: NodeEntity, index: number): NodeCompositionPart => ({
    id: String(index),
    primitives: [
      {
        kind: 'rect',
        x: (index % 100) * 10,
        y: Math.floor(index / 100) * 10,
        width: 10,
        height: 10,
        fill: (node.data?.cells as string[])[index]
      }
    ]
  });
  const full = vi.fn((node: NodeEntity) => Array.from({ length: 10000 }, (_, index) => part(node, index)));
  engine.nodeTypes.register({
    type: 'many-parts',
    label: '万片',
    defaultData: {},
    createContent: () => ({ width: 1000, height: 1000, data: { cells: Array(10000).fill('$blue') } }),
    composeParts: full,
    composeChangedParts: (node, _context, paths) =>
      paths.every((path) => path[0] === 'data' && path[1] === 'cells' && path.length === 3)
        ? paths.map((path) => part(node, Number(path[2])))
        : null
  });
  const id = engine.documentStore.createNode({ nodeType: 'many-parts', x: 0, y: 0 })!;
  const reconcile = vi.spyOn(PrimitiveMapper.prototype, 'reconcile');
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  try {
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    const content = layer.getGroup(id)!.children[0] as Group;
    const first = content.children[0];
    const last = content.children[9999];
    reconcile.mockClear();
    full.mockClear();
    engine.documentStore.commit({
      label: '单片颜色',
      patches: [{ op: 'set', path: ['content', 'nodes', id, 'data', 'cells', 5050], value: '$red' }]
    });
    renderer.renderFrame();
    expect(full).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(content.children[0]).toBe(first);
    expect(content.children[9999]).toBe(last);
    expect(content.children).toHaveLength(10000);
  } finally {
    renderer.destroy();
    engine.destroy();
    reconcile.mockRestore();
  }
}, 30000);

it('空分片按需挂载，逆序首次显示仍按声明顺序排列，清空后可以原位恢复', () => {
  const engine = new SkyNoteEngine();
  const part = (node: NodeEntity, index: number): NodeCompositionPart => ({
    id: String(index),
    primitives:
      node.data?.fills && (node.data.fills as string[])[index]
        ? [{ kind: 'rect', x: 0, y: 0, width: 10, height: 10, fill: (node.data.fills as string[])[index] }]
        : []
  });
  engine.nodeTypes.register({
    type: 'empty-parts',
    label: '空分片',
    defaultData: { fills: [] as string[] },
    createContent: () => ({ width: 100, height: 100, data: { fills: ['', '$blue', ''] } }),
    composeParts: (node) => [0, 1, 2].map((index) => part(node, index)),
    composeChangedParts: (node, _context, paths) => paths.map((path) => part(node, Number(path[2])))
  });
  const id = engine.documentStore.createNode({ nodeType: 'empty-parts', x: 0, y: 0 })!;
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const write = (index: number, value: string) => {
    engine.documentStore.commit({
      patches: [{ op: 'set', path: ['content', 'nodes', id, 'data', 'fills', index], value }]
    });
    renderer.renderFrame();
  };
  try {
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    const content = layer.getGroup(id)!.children[0] as Group;
    expect(content.children).toHaveLength(1);
    const middle = content.children[0];
    write(2, '$red');
    const last = content.children[1];
    write(0, '$green');
    expect(content.children).toHaveLength(3);
    expect(content.children[1]).toBe(middle);
    expect(content.children[2]).toBe(last);
    const first = content.children[0] as Group;
    write(0, '');
    expect(first.children).toHaveLength(0);
    write(0, '$red');
    expect(first.children).toHaveLength(1);
    expect(content.children[0]).toBe(first);
    expect(content.children[1]).toBe(middle);
    expect(content.children[2]).toBe(last);
  } finally {
    renderer.destroy();
    engine.destroy();
  }
});

it.each([false, true])('切换节点类型完整重建分片顺序和裁剪（离屏修改：%s）', (offscreen) => {
  const engine = new SkyNoteEngine();
  const part = (id: string, fill: string): NodeCompositionPart => ({
    id,
    primitives: [{ kind: 'rect', x: 0, y: 0, width: 100, height: 100, fill }]
  });
  const a = [part('back', '$blue'), part('front', '$red')];
  const b = [part('front', '$red'), part('back', '$blue')];
  const fullB = vi.fn(() => b);
  const partialB = vi.fn(() => b);
  engine.nodeTypes.register({
    type: 'type-a',
    label: 'A',
    defaultData: {},
    createContent: () => ({ width: 100, height: 100 }),
    composeParts: () => a
  });
  engine.nodeTypes.register({
    type: 'type-b',
    label: 'B',
    defaultData: {},
    clipContent: true,
    composeParts: fullB,
    composeChangedParts: partialB
  });
  const id = engine.documentStore.createNode({ nodeType: 'type-a', x: 0, y: 0 })!;
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  try {
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    const previous = layer.getGroup(id)!;
    expect(previous.children[0]).not.toBeInstanceOf(Box);
    if (offscreen) {
      engine.session.setViewport({ x: -10000, y: 0 });
      renderer.renderFrame();
    }
    engine.documentStore.updateNode(id, { nodeType: 'type-b' });
    if (offscreen) {
      renderer.renderFrame();
      engine.session.setViewport({ x: 0, y: 0 });
    }
    renderer.renderFrame();
    const next = layer.getGroup(id)!;
    expect(next).not.toBe(previous);
    const content = next.children[0] as Group;
    expect(content).toBeInstanceOf(Box);
    expect(fullB).toHaveBeenCalledTimes(1);
    expect(partialB).not.toHaveBeenCalled();
    expect((content.children[0] as Group).children[0].fill).toBe(engine.session.theme.palette.red);
    expect((content.children[1] as Group).children[0].fill).toBe(engine.session.theme.palette.blue);
    engine.documentStore.undo();
    renderer.renderFrame();
    expect(layer.getGroup(id)!.children[0]).not.toBeInstanceOf(Box);
    engine.documentStore.redo();
    renderer.renderFrame();
    expect(layer.getGroup(id)!.children[0]).toBeInstanceOf(Box);
    expect(fullB).toHaveBeenCalledTimes(2);
  } finally {
    renderer.destroy();
    engine.destroy();
  }
});

it('容器切换类型时保留子节点原生实例，重新挂载到新裁剪容器并保持兄弟顺序', () => {
  const engine = new SkyNoteEngine();
  engine.nodeTypes.register({
    type: 'container-a',
    label: 'A',
    defaultData: {},
    createContent: () => ({ width: 200, height: 200 })
  });
  engine.nodeTypes.register({ type: 'container-b', label: 'B', defaultData: {}, clipChildren: true });
  const parent = engine.documentStore.createNode({ nodeType: 'container-a', x: 0, y: 0 })!;
  const child = engine.documentStore.createNode({ nodeType: 'container-a', x: 10, y: 10 })!;
  const sibling = engine.documentStore.createNode({ nodeType: 'container-a', x: 300, y: 0 })!;
  engine.documentStore.updateNode(child, { parentId: parent });
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  try {
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    const previous = layer.getGroup(parent)!;
    const childGroup = layer.getGroup(child)!;
    const siblingGroup = layer.getGroup(sibling)!;
    const container = previous.parent as Group;
    const index = container.children.indexOf(previous);
    engine.documentStore.updateNode(parent, { nodeType: 'container-b' });
    renderer.renderFrame();
    const next = layer.getGroup(parent)!;
    expect(layer.getGroup(child)).toBe(childGroup);
    expect(childGroup.parent).toBeInstanceOf(Box);
    expect(childGroup.parent!.parent).toBe(next);
    expect(container.children[index]).toBe(next);
    expect(siblingGroup.parent).toBe(container);
    expect(container.children).toHaveLength(2);
  } finally {
    renderer.destroy();
    engine.destroy();
  }
});

it('类型切换由创建原生图元的渲染器清理，清理时保留旧类型快照', () => {
  const engine = new SkyNoteEngine();
  engine.nodeTypes.register({
    type: 'native-a',
    label: 'A',
    defaultData: {},
    createContent: () => ({ width: 100, height: 100 })
  });
  engine.nodeTypes.register({ type: 'native-b', label: 'B', defaultData: {} });
  const id = engine.documentStore.createNode({ nodeType: 'native-a', x: 0, y: 0 })!;
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const destroyA = vi.fn();
  const destroyB = vi.fn();
  renderer.nodeRenderers.register({
    nodeType: 'native-a',
    create: () => [new Rect({ width: 100, height: 100 })],
    update() {},
    destroy: destroyA
  });
  renderer.nodeRenderers.register({
    nodeType: 'native-b',
    create: () => [new Rect({ width: 100, height: 100 })],
    update() {},
    destroy: destroyB
  });
  try {
    engine.documentStore.updateNode(id, { data: { ready: true } });
    renderer.renderFrame();
    engine.documentStore.updateNode(id, { nodeType: 'native-b' });
    renderer.renderFrame();
    expect(destroyA).toHaveBeenCalledTimes(1);
    expect(destroyA.mock.calls[0][1].nodeType).toBe('native-a');
    expect(destroyB).not.toHaveBeenCalled();
  } finally {
    renderer.destroy();
    engine.destroy();
  }
  expect(destroyA).toHaveBeenCalledTimes(1);
  expect(destroyB).toHaveBeenCalledTimes(1);
});

it('同名类型定义重新注册时同步重建裁剪容器', () => {
  const engine = new SkyNoteEngine();
  engine.nodeTypes.register({
    type: 'replace-definition',
    label: '旧',
    defaultData: {},
    createContent: () => ({ width: 100, height: 100 })
  });
  const id = engine.documentStore.createNode({ nodeType: 'replace-definition', x: 0, y: 0 })!;
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    engine.nodeTypes.register({ type: 'replace-definition', label: '新', defaultData: {}, clipContent: true });
    renderer.renderFrame();
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    expect(layer.getGroup(id)!.children[0]).toBeInstanceOf(Box);
  } finally {
    warn.mockRestore();
    renderer.destroy();
    engine.destroy();
  }
});

it('原生渲染器替换或卸载时先释放实际创建者，再建立新的内容来源', () => {
  const engine = new SkyNoteEngine();
  engine.nodeTypes.register({
    type: 'native-owner',
    label: '原生',
    defaultData: {},
    createContent: () => ({ width: 100, height: 100 })
  });
  const id = engine.documentStore.createNode({ nodeType: 'native-owner', x: 0, y: 0 })!;
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const firstDestroy = vi.fn();
  const secondDestroy = vi.fn();
  const secondCreate = vi.fn(() => [new Rect({ width: 100, height: 100 })]);
  const secondUpdate = vi.fn();
  const write = (version: number) => {
    engine.documentStore.updateNode(id, { data: { version } });
    renderer.renderFrame();
  };
  try {
    renderer.nodeRenderers.register({
      nodeType: 'native-owner',
      create: () => [new Rect({ width: 100, height: 100 })],
      update() {},
      destroy: firstDestroy
    });
    write(1);
    const release = renderer.nodeRenderers.register({
      nodeType: 'native-owner',
      create: secondCreate,
      update: secondUpdate,
      destroy: secondDestroy
    });
    write(2);
    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(secondCreate).toHaveBeenCalledTimes(1);
    expect(secondUpdate).not.toHaveBeenCalled();
    release();
    write(3);
    expect(secondDestroy).toHaveBeenCalledTimes(1);
  } finally {
    renderer.destroy();
    engine.destroy();
  }
  expect(firstDestroy).toHaveBeenCalledTimes(1);
  expect(secondDestroy).toHaveBeenCalledTimes(1);
});

it.each(['type', 'remove', 'unload', 'destroy'] as const)('原生清理部分执行后抛错仍释放图元和缓存（%s）', (action) => {
  const engine = new SkyNoteEngine();
  engine.nodeTypes.register({
    type: 'bad-cleanup',
    label: '异常清理',
    defaultData: {},
    createContent: () => ({ width: 100, height: 100 })
  });
  engine.nodeTypes.register({
    type: 'normal',
    label: '普通',
    defaultData: {},
    createContent: () => ({ width: 100, height: 100 })
  });
  const id = engine.documentStore.createNode({ nodeType: 'bad-cleanup', x: 0, y: 0 })!;
  const neighbor = engine.documentStore.createNode({ nodeType: 'normal', x: 200, y: 0 })!;
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const rect = new Rect({ width: 100, height: 100 });
  const dispose = vi.fn((shapes: Rect[]) => {
    shapes[0].remove();
    shapes.length = 0;
    throw new Error('dispose failure');
  });
  const release = renderer.nodeRenderers.register({
    nodeType: 'bad-cleanup',
    create: () => [rect],
    update() {},
    destroy: dispose
  });
  try {
    engine.documentStore.updateNode(id, { data: { ready: true } });
    renderer.renderFrame();
    const layer = (renderer as unknown as { nodeLayer: NodeLayer }).nodeLayer;
    const previous = layer.getGroup(id)!;
    if (action === 'destroy') expect(() => renderer.destroy()).not.toThrow();
    else {
      if (action === 'type') engine.documentStore.updateNode(id, { nodeType: 'normal' });
      if (action === 'remove') engine.documentStore.removeEntities({ nodeIds: [id] });
      if (action === 'unload') {
        release();
        engine.documentStore.updateNode(id, { data: { ready: false } });
      }
      engine.documentStore.updateNode(neighbor, { x: 250 });
      expect(() => renderer.renderFrame()).not.toThrow();
      expect(layer.getGroup(neighbor)!.x).toBe(250);
    }
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(rect.destroyed).toBe(true);
    if (action === 'remove' || action === 'destroy') expect(layer.getGroup(id)).toBeUndefined();
    if (action === 'type') expect(layer.getGroup(id)).not.toBe(previous);
    if (action !== 'unload') expect(previous.destroyed).toBe(true);
    expect(() => renderer.destroy()).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(layer.cacheCount).toBe(0);
  } finally {
    renderer.destroy();
    engine.destroy();
    errors.mockRestore();
  }
});

it('原生更新和清理同时抛错时降级占位，下一次数据变化能恢复', () => {
  const engine = new SkyNoteEngine();
  engine.nodeTypes.register({
    type: 'bad-update',
    label: '异常更新',
    defaultData: {},
    createContent: () => ({ width: 100, height: 100 })
  });
  const id = engine.documentStore.createNode({ nodeType: 'bad-update', x: 0, y: 0 })!;
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const created: Rect[] = [];
  const dispose = vi.fn(() => {
    throw new Error('dispose failure');
  });
  renderer.nodeRenderers.register({
    nodeType: 'bad-update',
    create: () => {
      const rect = new Rect({ width: 100, height: 100 });
      created.push(rect);
      return [rect];
    },
    update: () => {
      throw new Error('update failure');
    },
    destroy: dispose
  });
  const write = (version: number) => {
    engine.documentStore.updateNode(id, { data: { version } });
    renderer.renderFrame();
  };
  try {
    write(1);
    expect(() => write(2)).not.toThrow();
    expect(created[0].destroyed).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => write(3)).not.toThrow();
    expect(created).toHaveLength(2);
    expect(created[1].destroyed).not.toBe(true);
  } finally {
    renderer.destroy();
    engine.destroy();
    errors.mockRestore();
  }
  expect(dispose).toHaveBeenCalledTimes(2);
});

it('原生图元子类自身销毁抛错时，继续释放同节点其他图元并隔离旧场景分支', () => {
  class BrokenRect extends Rect {
    override destroy(): void {
      throw new Error('shape disposal failure');
    }
  }
  const engine = new SkyNoteEngine();
  engine.nodeTypes.register({
    type: 'broken-shape',
    label: '异常图元',
    defaultData: {},
    createContent: () => ({ width: 100, height: 100 })
  });
  engine.nodeTypes.register({ type: 'normal', label: '普通', defaultData: {} });
  const id = engine.documentStore.createNode({ nodeType: 'broken-shape', x: 0, y: 0 })!;
  const renderer = new LeaferRenderer(engine, document.createElement('div'), { enableFrameScheduler: false });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const broken = new BrokenRect({ width: 100, height: 100 });
  const remaining = new Rect({ width: 100, height: 100 });
  renderer.nodeRenderers.register({ nodeType: 'broken-shape', create: () => [broken, remaining], update() {} });
  try {
    engine.documentStore.updateNode(id, { data: { ready: true } });
    renderer.renderFrame();
    engine.documentStore.updateNode(id, { nodeType: 'normal' });
    expect(() => renderer.renderFrame()).not.toThrow();
    expect(broken.parent).toBeNull();
    expect(remaining.destroyed).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
  } finally {
    renderer.destroy();
    engine.destroy();
    errors.mockRestore();
  }
});
