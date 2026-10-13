import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import type { AssetAdapter, NodeEntity } from '@skynote/core';
import type { Rect } from 'leafer';
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
