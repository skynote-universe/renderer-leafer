import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import type { AssetAdapter, NodeEntity } from '@skynote/core';
import type { Rect, Text } from 'leafer-ui';
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
  it('下一帧前撤销节点类型替换时，复用图元重新取得加载与重试能力', () => {
    const engine = new SkyNoteEngine({
      assets: {
        upload: vi.fn(),
        resolve: () => {
          throw new Error('offline');
        }
      }
    });
    engine.nodeTypes.register({ type: 'image', label: '图片', defaultData: {}, opacityBehavior: 'renderer-defined' });
    engine.documentStore.commit({
      patches: [
        { op: 'set', path: ['assets', 'first'], value: { id: 'first', src: 'memory:first', mimeType: 'image/png' } }
      ]
    });
    engine.documentStore.addNode(imageNode());
    const renderer = new LeaferRenderer(engine, document.createElement('div'));
    engine.documentStore.updateNode('image', { nodeType: 'rect' });
    expect(renderer.images.getState('image')).toBeUndefined();
    engine.documentStore.undo();
    renderer.renderFrame();
    expect(renderer.images.getState('image')?.status).toBe('failed');
    expect(renderer.images.retry(['image'])).toEqual(['image']);
    renderer.destroy();
    engine.destroy();
  });

  it.each(['delete', 'replace', 'asset', 'destroy'] as const)(
    '重试中 %s 立即取消，忽略取消的适配器返回结果仍成对释放',
    async (action) => {
      vi.stubGlobal('Image', TestImage);
      let retrying = false;
      const pending: { finish: (url: string) => void; signal: AbortSignal }[] = [];
      const release = vi.fn();
      const engine = new SkyNoteEngine({
        assets: {
          upload: vi.fn(),
          resolve: (_src, { signal }) => {
            if (!retrying) return Promise.reject(new Error('offline'));
            return new Promise<string>((finish) => pending.push({ finish, signal }));
          },
          release
        }
      });
      engine.nodeTypes.register({ type: 'image', label: '图片', defaultData: {}, opacityBehavior: 'renderer-defined' });
      engine.documentStore.commit({
        patches: [
          { op: 'set', path: ['assets', 'first'], value: { id: 'first', src: 'memory:first', mimeType: 'image/png' } }
        ]
      });
      engine.documentStore.addNode(imageNode());
      const renderer = new LeaferRenderer(engine, document.createElement('div'));
      await vi.waitFor(() => expect(renderer.images.getState('image')?.status).toBe('failed'));
      retrying = true;
      renderer.images.retry(['image']);
      if (action === 'delete')
        engine.documentStore.commit({ patches: [{ op: 'unset', path: ['content', 'nodes', 'image'] }] });
      if (action === 'replace')
        engine.documentStore.commit({
          patches: [{ op: 'set', path: ['content', 'nodes', 'image', 'image', 'assetId'], value: 'missing' }]
        });
      if (action === 'asset')
        engine.documentStore.commit({
          patches: [{ op: 'set', path: ['assets', 'first', 'src'], value: 'memory:changed' }]
        });
      if (action === 'destroy') renderer.destroy();
      expect(pending[0].signal.aborted).toBe(true);
      pending[0].finish('blob:late-retry');
      await Promise.resolve();
      expect(release).toHaveBeenCalledExactlyOnceWith('memory:first', 'blob:late-retry');
      expect(TestImage.instances).toHaveLength(0);
      renderer.destroy();
      if (pending[1]) {
        expect(pending[1].signal.aborted).toBe(true);
        pending[1].finish('blob:late-changed');
        await Promise.resolve();
        expect(release).toHaveBeenCalledWith('memory:changed', 'blob:late-changed');
      }
      engine.destroy();
    }
  );

  it('失败图已显示仍报告原图失败，样式刷新不自动重试，显式重试释放占位 URL', async () => {
    vi.stubGlobal('Image', TestImage);
    const engine = new SkyNoteEngine();
    const context = {
      viewport: engine.session.viewport,
      theme: engine.session.theme,
      isInteracting: false,
      textEditing: null
    };
    const resolve = vi.fn(() => 'blob:fallback');
    const release = vi.fn();
    const renderer = new ImageNodeRenderer(() => undefined, undefined, { resolve, release });
    const shapes = renderer.create(imageNode(), context);
    await vi.waitFor(() => expect(TestImage.instances).toHaveLength(1));
    TestImage.instances[0].onload!();
    expect(renderer.getState('image')).toEqual({ status: 'failed', reason: 'missing-asset' });
    renderer.update(shapes, { ...imageNode(), style: { opacity: 0.5 } }, context);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(renderer.retry(['image'])).toEqual(['image']);
    expect(release).toHaveBeenCalledExactlyOnceWith('blob:fallback');
    await vi.waitFor(() => expect(TestImage.instances).toHaveLength(2));
    renderer.dispose();
    expect(release).toHaveBeenCalledTimes(2);
    shapes.forEach((shape) => shape.destroy());
    engine.destroy();
  });

  it('原引用重试只接受失败节点，成功后状态更新且不修改文档或历史', async () => {
    vi.stubGlobal('Image', TestImage);
    const engine = new SkyNoteEngine();
    const context = {
      viewport: engine.session.viewport,
      theme: engine.session.theme,
      isInteracting: false,
      textEditing: null
    };
    let unavailable = true;
    const resolve = vi.fn(() => {
      if (unavailable) throw new Error('offline');
      return 'blob:restored';
    });
    const release = vi.fn();
    const renderer = new ImageNodeRenderer(() => ({ src: 'memory:first' }), { upload: vi.fn(), resolve, release });
    const listener = vi.fn();
    const dispose = renderer.subscribe(listener);
    const node = imageNode();
    const before = structuredClone(node);
    const shapes = renderer.create(node, context);
    expect(renderer.getState(node.id)).toEqual({ status: 'failed', reason: 'load-failed' });
    unavailable = false;
    expect(renderer.retry(['absent', node.id, node.id])).toEqual([node.id]);
    expect(renderer.getState(node.id)).toEqual({ status: 'loading' });
    expect(renderer.retry([node.id])).toEqual([]);
    await Promise.resolve();
    TestImage.instances[0].onload!();
    expect(renderer.getState(node.id)).toEqual({ status: 'ready' });
    expect(renderer.retry([node.id])).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(node).toEqual(before);
    expect(listener).toHaveBeenCalled();
    dispose();
    listener.mockClear();
    renderer.destroy(shapes);
    expect(listener).not.toHaveBeenCalled();
    expect(renderer.getState(node.id)).toBeUndefined();
    expect(release).toHaveBeenCalledExactlyOnceWith('memory:first', 'blob:restored');
    shapes.forEach((shape) => shape.destroy());
    engine.destroy();
  });

  it('解码失败重试清理失败图与旧 URL，迟到失败图不能覆盖正常图', async () => {
    vi.stubGlobal('Image', TestImage);
    const engine = new SkyNoteEngine();
    const context = {
      viewport: engine.session.viewport,
      theme: engine.session.theme,
      isInteracting: false,
      textEditing: null
    };
    const release = vi.fn();
    const releaseFailure = vi.fn();
    let finish!: (url: string) => void;
    const renderer = new ImageNodeRenderer(
      () => ({ src: 'memory:first' }),
      {
        upload: vi.fn(),
        resolve: () => 'blob:original',
        release
      },
      {
        resolve: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
        release: releaseFailure
      }
    );
    const shapes = renderer.create(imageNode(), context);
    await Promise.resolve();
    TestImage.instances[0].onerror!();
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(renderer.getState('image')).toEqual({ status: 'failed', reason: 'decode-failed' });
    expect(renderer.retry(['image'])).toEqual(['image']);
    await Promise.resolve();
    TestImage.instances[1].onload!();
    finish('blob:late-fallback');
    await vi.waitFor(() => expect(releaseFailure).toHaveBeenCalledExactlyOnceWith('blob:late-fallback'));
    expect((shapes[2] as Rect).fill).toMatchObject({ url: 'blob:original' });
    expect(renderer.getState('image')).toEqual({ status: 'ready' });
    renderer.destroy(shapes);
    expect(release).toHaveBeenCalledTimes(2);
    shapes.forEach((shape) => shape.destroy());
    engine.destroy();
  });

  it('整体替换相同节点 ID 立即取消重试，下一帧前迟到结果仅释放', async () => {
    vi.stubGlobal('Image', TestImage);
    let finish!: (url: string) => void;
    let signal!: AbortSignal;
    let retrying = false;
    const release = vi.fn();
    const engine = new SkyNoteEngine({
      assets: {
        upload: vi.fn(),
        resolve: (_src, options) => {
          if (!retrying) throw new Error('offline');
          signal = options.signal;
          return new Promise<string>((resolve) => {
            finish = resolve;
          });
        },
        release
      }
    });
    engine.nodeTypes.register({ type: 'image', label: '图片', defaultData: {}, opacityBehavior: 'renderer-defined' });
    engine.documentStore.commit({
      patches: [
        { op: 'set', path: ['assets', 'first'], value: { id: 'first', src: 'memory:first', mimeType: 'image/png' } }
      ]
    });
    engine.documentStore.addNode(imageNode());
    const renderer = new LeaferRenderer(engine, document.createElement('div'));
    expect(renderer.images.getState('image')?.status).toBe('failed');
    retrying = true;
    renderer.images.retry(['image']);
    const before = structuredClone(engine.documentStore.getView());
    engine.documentStore.replaceContent({ nodes: { image: imageNode() }, connectors: {} });
    expect(signal.aborted).toBe(true);
    expect(renderer.images.getState('image')).toBeUndefined();
    finish('blob:late');
    await Promise.resolve();
    expect(release).toHaveBeenCalledExactlyOnceWith('memory:first', 'blob:late');
    expect(TestImage.instances).toHaveLength(0);
    expect(engine.documentStore.getView().content).toEqual(before.content);
    renderer.destroy();
    engine.destroy();
  });

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
