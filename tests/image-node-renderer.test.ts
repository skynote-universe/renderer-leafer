import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import type { AssetAdapter, NodeEntity } from '@skynote/core';
import type { Rect, Text } from 'leafer';
import { ImageNodeRenderer } from '../src/node/image-node-renderer';
import { LeaferRenderer } from '../src/leafer-renderer';

class TestImage {
  static instances: TestImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  crossOrigin = '';
  constructor() {
    TestImage.instances.push(this);
  }
  removeAttribute(): void {
    this.src = '';
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  TestImage.instances = [];
});

function imageNode(assetId = 'first'): NodeEntity & { image: { assetId: string; fit: 'contain' } } {
  return {
    id: 'image',
    type: 'node',
    nodeType: 'image',
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    image: { assetId, fit: 'contain' },
    style: { opacity: 0, fill: '$red', stroke: '$blue', strokeWidth: 3 }
  };
}

describe('图片渲染生命周期', () => {
  it('宿主失败图独立解析与释放，替换后退回原图且不改写节点', async () => {
    vi.stubGlobal('Image', TestImage);
    const engine = new SkyNoteEngine();
    const context = {
      viewport: engine.session.viewport,
      theme: engine.session.theme,
      isInteracting: false,
      textEditing: null
    };
    const resolveFailure = vi.fn(() => 'blob:fallback');
    const releaseFailure = vi.fn();
    const node = imageNode('missing');
    const before = structuredClone(node);
    const renderer = new ImageNodeRenderer(
      (id) => (id === 'missing' ? undefined : { src: `memory:${id}` }),
      { upload: vi.fn(), resolve: () => 'blob:original' },
      { resolve: resolveFailure, release: releaseFailure }
    );
    const shapes = renderer.create(node, context);
    await vi.waitFor(() => expect(TestImage.instances).toHaveLength(1));
    TestImage.instances[0].onload!();
    expect(resolveFailure).toHaveBeenCalledWith(
      node,
      'missing-asset',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect((shapes[4] as Text).opacity).toBe(0);
    expect((shapes[2] as Rect).opacity).toBe(1);
    expect(node).toEqual(before);
    renderer.update(shapes, imageNode('good'), context);
    expect(releaseFailure).toHaveBeenCalledExactlyOnceWith('blob:fallback');
    await Promise.resolve();
    TestImage.instances[1].onload!();
    expect((shapes[2] as Rect).fill).toMatchObject({ url: 'blob:original' });
    renderer.destroy(shapes);
    shapes.forEach((shape) => shape.destroy());
    engine.destroy();
  });

  it('失败图本身损坏退回文字，销毁后的晚到失败图只释放不写入', async () => {
    vi.stubGlobal('Image', TestImage);
    const engine = new SkyNoteEngine();
    const context = {
      viewport: engine.session.viewport,
      theme: engine.session.theme,
      isInteracting: false,
      textEditing: null
    };
    let finish!: (url: string) => void;
    const release = vi.fn();
    const renderer = new ImageNodeRenderer(() => undefined, undefined, {
      resolve: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      release
    });
    const shapes = renderer.create(imageNode(), context);
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish('blob:bad-fallback');
    await vi.waitFor(() => expect(TestImage.instances).toHaveLength(1));
    TestImage.instances[0].onerror!();
    expect(release).toHaveBeenCalledExactlyOnceWith('blob:bad-fallback');
    expect((shapes[4] as Text).text).toBe('图片资产缺失');
    renderer.update(shapes, imageNode('other'), context);
    await Promise.resolve();
    renderer.destroy(shapes);
    finish('blob:late-fallback');
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith('blob:late-fallback'));
    expect((shapes[2] as Rect).fill).toBeUndefined();
    shapes.forEach((shape) => shape.destroy());
    engine.destroy();
  });

  it('缺失、加载、解码失败分别提示；成功隐藏提示，失败释放 URL 且可替换恢复', async () => {
    vi.stubGlobal('Image', TestImage);
    const engine = new SkyNoteEngine();
    const context = {
      viewport: engine.session.viewport,
      theme: engine.session.theme,
      isInteracting: false,
      textEditing: null
    };
    const release = vi.fn();
    const renderer = new ImageNodeRenderer((id) => (id === 'missing' ? undefined : { src: `memory:${id}` }), {
      upload: vi.fn(),
      resolve: (src) => `blob:${src}`,
      release
    });
    const shapes = renderer.create(imageNode('missing'), context);
    const status = shapes[4] as Text;
    expect(status.text).toBe('图片资产缺失');
    renderer.update(shapes, imageNode(), context);
    expect(status.text).toBe('图片加载中');
    await Promise.resolve();
    TestImage.instances[0].onerror!();
    expect(status.text).toContain('无法解码');
    expect(release).toHaveBeenCalledExactlyOnceWith('memory:first', 'blob:memory:first');
    renderer.update(shapes, imageNode('second'), context);
    await Promise.resolve();
    TestImage.instances[1].onload!();
    expect(status.opacity).toBe(0);
    expect((shapes[1] as Rect).opacity).toBe(0);
    renderer.destroy(shapes);
    expect(release).toHaveBeenCalledTimes(2);
    shapes.forEach((shape) => shape.destroy());
    engine.destroy();
  });

  it('解析失败显示错误，销毁后的晚到失败不修改图元', async () => {
    const engine = new SkyNoteEngine();
    const context = {
      viewport: engine.session.viewport,
      theme: engine.session.theme,
      isInteracting: false,
      textEditing: null
    };
    let fail!: (error: Error) => void;
    const renderer = new ImageNodeRenderer(() => ({ src: 'memory:first' }), {
      upload: vi.fn(),
      resolve: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        })
    });
    const shapes = renderer.create(imageNode(), context);
    fail(new Error('missing'));
    await Promise.resolve();
    await Promise.resolve();
    expect((shapes[4] as Text).text).toContain('加载失败');
    renderer.update(shapes, imageNode('second'), context);
    renderer.destroy(shapes);
    fail(new Error('late'));
    await Promise.resolve();
    await Promise.resolve();
    expect((shapes[4] as Text).text).toBe('图片加载中');
    shapes.forEach((shape) => shape.destroy());
    engine.destroy();
  });

  it('资产源地址变化会绕过节点版本缓存，释放旧 URL；删除资产后恢复占位', async () => {
    vi.stubGlobal('Image', TestImage);
    const resolve = vi.fn((src: string) => `blob:${src}`);
    const release = vi.fn();
    const engine = new SkyNoteEngine({ assets: { upload: vi.fn(), resolve, release } });
    engine.nodeTypes.register({
      type: 'image',
      label: '图片',
      defaultData: {},
      opacityBehavior: 'renderer-defined',
      assets: {
        collect: (node) => [(node as ReturnType<typeof imageNode>).image.assetId],
        remap: () => ({})
      }
    });
    engine.documentStore.addNode(imageNode());
    engine.documentStore.commit({
      patches: [
        { op: 'set', path: ['assets', 'first'], value: { id: 'first', src: 'memory:old', mimeType: 'image/png' } }
      ]
    });
    const renderer = new LeaferRenderer(engine, document.createElement('div'));
    await Promise.resolve();
    TestImage.instances[0].onload!();
    engine.documentStore.commit({ patches: [{ op: 'set', path: ['assets', 'first', 'src'], value: 'memory:new' }] });
    renderer.renderFrame();
    await Promise.resolve();
    expect(resolve).toHaveBeenCalledWith('memory:new', expect.anything());
    expect(release).toHaveBeenCalledWith('memory:old', 'blob:memory:old');
    engine.documentStore.commit({ patches: [{ op: 'unset', path: ['assets', 'first'] }] });
    renderer.renderFrame();
    expect(release).toHaveBeenCalledWith('memory:new', 'blob:memory:new');
    renderer.destroy();
    engine.destroy();
  });
  it('图片为零透明度时保留背景和边框，样式更新复用图元并保持已加载内容', async () => {
    vi.stubGlobal('Image', TestImage);
    const engine = new SkyNoteEngine();
    const release = vi.fn();
    const renderer = new ImageNodeRenderer(() => ({ src: 'memory:first' }), {
      upload: vi.fn(),
      resolve: () => 'blob:first',
      release
    });
    const context = {
      viewport: engine.session.viewport,
      theme: engine.session.theme,
      isInteracting: false,
      textEditing: null
    };
    const node = imageNode();
    const shapes = renderer.create(node, context) as Rect[];
    await Promise.resolve();
    TestImage.instances[0].onload!();
    expect(shapes[0].opacity).toBe(1);
    expect(shapes[2].opacity).toBe(0);
    expect(shapes[3].opacity).toBe(1);
    expect(shapes[3].strokeWidth).toBe(3);
    expect(shapes[1].opacity).toBe(0);
    const fill = shapes[2].fill;
    renderer.update(shapes, { ...node, width: 150, style: { ...node.style, radius: 8 } }, context);
    expect(shapes[2].fill).toEqual(fill);
    expect(shapes[1].opacity).toBe(0);
    expect(shapes[0].fill).toBe(engine.session.theme.palette.red);
    renderer.destroy(shapes);
    expect(release).toHaveBeenCalledExactlyOnceWith('memory:first', 'blob:first');
    expect(TestImage.instances[0].onload).toBeNull();
    shapes.forEach((shape) => shape.destroy());
    engine.destroy();
  });

  it('替换与销毁后到达的解析结果只释放 URL，不修改当前图元', async () => {
    vi.stubGlobal('Image', TestImage);
    const pending: { resolve: (url: string) => void; signal: AbortSignal }[] = [];
    const assets: AssetAdapter = {
      upload: vi.fn(),
      resolve: (_src, { signal }) => new Promise((resolve) => pending.push({ resolve, signal })),
      release: vi.fn()
    };
    const engine = new SkyNoteEngine();
    const context = {
      viewport: engine.session.viewport,
      theme: engine.session.theme,
      isInteracting: false,
      textEditing: null
    };
    const renderer = new ImageNodeRenderer((id) => ({ src: `memory:${id}` }), assets);
    const shapes = renderer.create(imageNode(), context) as Rect[];
    renderer.update(shapes, imageNode('second'), context);
    expect(pending[0].signal.aborted).toBe(true);
    pending[0].resolve('blob:old');
    await Promise.resolve();
    expect(assets.release).toHaveBeenCalledWith('memory:first', 'blob:old');
    expect(TestImage.instances).toHaveLength(0);
    renderer.destroy(shapes);
    expect(pending[1].signal.aborted).toBe(true);
    pending[1].resolve('blob:late');
    await Promise.resolve();
    expect(assets.release).toHaveBeenCalledWith('memory:second', 'blob:late');
    expect(TestImage.instances).toHaveLength(0);
    shapes.forEach((shape) => shape.destroy());
    engine.destroy();
  });

  it('图层保留声明局部透明语义的节点，普通透明节点被剔除', () => {
    const engine = new SkyNoteEngine();
    engine.nodeTypes.register({ type: 'image', label: '图片', defaultData: {}, opacityBehavior: 'renderer-defined' });
    engine.documentStore.addNode(imageNode());
    engine.documentStore.addNode({ ...imageNode(), id: 'hidden', nodeType: 'rect', x: 200 });
    const renderer = new LeaferRenderer(engine, document.createElement('div'));
    expect(renderer.contentLayer.children).toHaveLength(1);
    renderer.destroy();
    engine.destroy();
  });
});
