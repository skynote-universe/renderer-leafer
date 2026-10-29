import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Leafer } from 'leafer-ui';
import { SkyNoteEngine } from '@skynote/core';
import { exportScene } from '../src/export/scene-export';
import { LeaferNodeRendererRegistry } from '../src/registry/leafer-node-renderer-registry';
import { NodeLayer } from '../src/layers/node-layer';
import { LeaferRenderer } from '../src/leafer-renderer';
import { ImageNodeRenderer } from '../src/node/image-node-renderer';

afterEach(() => vi.restoreAllMocks());

describe('独立导出场景', () => {
  it.each(['encode', 'read'] as const)('%s阶段取消立即释放资源并忽略迟到结果', async (phase) => {
    const engine = new SkyNoteEngine();
    const controller = new AbortController();
    const reason = new Error('停止导出');
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    let finishEncoding: BlobCallback | undefined;
    let failReading: ((reason: unknown) => void) | undefined;
    const read = vi.spyOn(blob, 'arrayBuffer').mockImplementation(
      () =>
        new Promise<ArrayBuffer>((_resolve, reject) => {
          failReading = reject;
        })
    );
    const create = document.createElement.bind(document);
    let canvas!: HTMLCanvasElement;
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = create(tag);
      if (tag === 'canvas') {
        canvas = element as HTMLCanvasElement;
        canvas.toBlob = (callback) => {
          finishEncoding = callback;
          if (phase === 'read') callback(blob);
        };
      }
      return element;
    }) as typeof document.createElement);
    let settled = false;
    const exporting = exportScene(engine, new LeaferNodeRendererRegistry(), {
      format: 'png',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      scale: 1,
      background: 'canvas',
      signal: controller.signal
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await vi.waitFor(() => expect(phase === 'encode' ? finishEncoding : failReading).toBeDefined());
      controller.abort(reason);
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(await exporting).toBe(reason);
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
      if (phase === 'encode') {
        finishEncoding!(blob);
        await Promise.resolve();
        expect(read).not.toHaveBeenCalled();
      } else {
        failReading!(new Error('迟到的读取失败'));
        await Promise.resolve();
      }
    } finally {
      controller.abort(reason);
      finishEncoding?.(null);
      failReading?.(reason);
      await exporting;
      engine.destroy();
    }
  });

  it.each([false, true])('公共导出区分内置和被替换的图片渲染器：覆盖=%s', async (overridden) => {
    const engine = new SkyNoteEngine();
    engine.nodeTypes.register({
      type: 'image',
      label: '图片',
      defaultData: {},
      createContent: () => ({ width: 50, height: 50 })
    });
    engine.documentStore.createNode({ nodeType: 'image', x: 0, y: 0 });
    const renderer = new LeaferRenderer(engine, document.createElement('div'));
    const renderImage = vi.spyOn(ImageNodeRenderer.prototype, 'create').mockReturnValue([]);
    if (overridden) renderer.nodeRenderers.register({ nodeType: 'image', create: () => [], update: () => {} });
    const create = document.createElement.bind(document);
    const allocation = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = create(tag);
      if (tag === 'canvas')
        (element as HTMLCanvasElement).toBlob = (callback) =>
          callback(new Blob([new Uint8Array([1])], { type: 'image/png' }));
      return element;
    }) as typeof document.createElement);
    try {
      const exporting = renderer.export({
        format: 'png',
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        scale: 1,
        background: 'canvas',
        signal: new AbortController().signal
      });
      if (overridden) {
        await expect(exporting).rejects.toThrow('节点类型image暂不支持独立图片导出');
        expect(allocation).not.toHaveBeenCalled();
        expect(renderImage).not.toHaveBeenCalled();
      } else {
        await expect(exporting).resolves.toMatchObject({ mimeType: 'image/png' });
        expect(renderImage).toHaveBeenCalled();
      }
    } finally {
      renderer.destroy();
      engine.destroy();
    }
  });

  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp']
  ])('根据入参%s选择编码器并返回实际MIME', async (format, mimeType) => {
    const engine = new SkyNoteEngine();
    const registry = new LeaferNodeRendererRegistry();
    const encode = vi.fn((callback: BlobCallback, type?: string) =>
      callback(new Blob([new Uint8Array([1, 2, 3])], { type }))
    );
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = create(tag);
      if (tag === 'canvas') (element as HTMLCanvasElement).toBlob = encode;
      return element;
    }) as typeof document.createElement);
    try {
      const result = await exportScene(engine, registry, {
        format,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        scale: 1,
        background: 'canvas',
        quality: 0.8,
        signal: new AbortController().signal
      });
      expect(encode).toHaveBeenCalledWith(expect.any(Function), mimeType, 0.8);
      expect(result.mimeType).toBe(mimeType);
    } finally {
      engine.destroy();
    }
  });

  it('编码器静默回退PNG时拒绝错误格式，并释放离屏资源', async () => {
    const engine = new SkyNoteEngine();
    const registry = new LeaferNodeRendererRegistry();
    const create = document.createElement.bind(document);
    let canvas!: HTMLCanvasElement;
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = create(tag);
      if (tag === 'canvas') {
        canvas = element as HTMLCanvasElement;
        canvas.toBlob = (callback) => callback(new Blob([new Uint8Array([1])], { type: 'image/png' }));
      }
      return element;
    }) as typeof document.createElement);
    try {
      await expect(
        exportScene(engine, registry, {
          format: 'webp',
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          scale: 1,
          background: 'canvas',
          signal: new AbortController().signal
        })
      ).rejects.toThrow('不支持导出格式');
      expect(canvas.width).toBe(0);
    } finally {
      engine.destroy();
    }
  });

  it.each([
    { format: 'svg', background: 'canvas', quality: 0.8 },
    { format: 'png', background: 'canvas', quality: Number.NaN },
    { format: 'jpeg', background: 'transparent', quality: 0.8 }
  ] as const)('无效格式或参数在创建画布前拒绝：$format/$background', async (options) => {
    const engine = new SkyNoteEngine();
    const registry = new LeaferNodeRendererRegistry();
    const create = vi.spyOn(document, 'createElement');
    try {
      await expect(
        exportScene(engine, registry, {
          ...options,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          scale: 1,
          signal: new AbortController().signal
        })
      ).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
    } finally {
      engine.destroy();
    }
  });

  it('渲染器销毁后拒绝公共导出调用', async () => {
    const engine = new SkyNoteEngine();
    const renderer = new LeaferRenderer(engine, document.createElement('div'));
    try {
      renderer.destroy();
      await expect(
        renderer.export({
          format: 'png',
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          scale: 1,
          background: 'canvas',
          signal: new AbortController().signal
        })
      ).rejects.toThrow('渲染器已销毁');
    } finally {
      renderer.destroy();
      engine.destroy();
    }
  });

  it('编码失败释放离屏图层与画布，取消等待也会及时结束', async () => {
    const engine = new SkyNoteEngine();
    const registry = new LeaferNodeRendererRegistry();
    const create = document.createElement.bind(document);
    let canvas!: HTMLCanvasElement;
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = create(tag);
      if (tag === 'canvas') {
        canvas = element as HTMLCanvasElement;
        canvas.toBlob = (callback) => callback(null);
      }
      return element;
    }) as typeof document.createElement);
    const destroy = vi.spyOn(Leafer.prototype, 'destroy');
    const request = {
      format: 'png',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      scale: 1,
      background: 'canvas' as const,
      signal: new AbortController().signal
    };
    try {
      await expect(exportScene(engine, registry, request)).rejects.toThrow('图片编码失败');
      expect(destroy).toHaveBeenCalled();
      expect(canvas.width).toBe(0);
      const controller = new AbortController();
      vi.spyOn(Leafer.prototype, 'waitViewCompleted').mockImplementation(() => {});
      const exporting = exportScene(engine, registry, { ...request, signal: controller.signal });
      const rejected = expect(exporting).rejects.toBeDefined();
      controller.abort();
      await rejected;
      expect(destroy).toHaveBeenCalledTimes(2);
    } finally {
      engine.destroy();
    }
  });

  it('绘制全部离屏节点而不修改视口，并释放临时场景', async () => {
    const engine = new SkyNoteEngine();
    engine.nodeTypes.register({
      type: 'unknown',
      label: '测试',
      defaultData: {},
      createContent: () => ({ width: 100, height: 100 }),
      compose: (node) => [{ kind: 'rect', x: 0, y: 0, width: node.width, height: node.height, fill: '#123456' }]
    });
    const registry = new LeaferNodeRendererRegistry();
    const first = engine.documentStore.createNode({
      nodeType: 'unknown',
      x: -1000,
      y: -1000,
      width: 100,
      height: 100
    })!;
    const second = engine.documentStore.createNode({ nodeType: 'unknown', x: 1000, y: 1000, width: 100, height: 100 })!;
    engine.session.setViewport({ x: 25, y: 55, zoom: 0.5 });
    const sync = vi.spyOn(NodeLayer.prototype, 'sync');
    const destroy = vi.spyOn(Leafer.prototype, 'destroy');
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = create(tag);
      if (tag === 'canvas')
        (element as HTMLCanvasElement).toBlob = (callback) =>
          callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
      return element;
    }) as typeof document.createElement);
    try {
      const result = await exportScene(engine, registry, {
        format: 'png',
        bounds: { left: -1100, top: -1100, right: 1200, bottom: 1200 },
        scale: 1,
        background: 'transparent',
        signal: new AbortController().signal
      });
      expect(sync.mock.calls[0][0]).toEqual([first, second]);
      expect(result.data).toEqual(new Uint8Array([137, 80, 78, 71]));
      expect(result.mimeType).toBe('image/png');
      expect(engine.session.viewport).toEqual({ x: 25, y: 55, zoom: 0.5 });
      expect(destroy).toHaveBeenCalled();
    } finally {
      engine.destroy();
    }
  });

  it('取消或超大范围在分配画布前拒绝', async () => {
    const engine = new SkyNoteEngine();
    const registry = new LeaferNodeRendererRegistry();
    const controller = new AbortController();
    controller.abort();
    const create = vi.spyOn(document, 'createElement');
    const request = {
      format: 'png',
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      scale: 1,
      background: 'canvas' as const,
      signal: controller.signal
    };
    try {
      await expect(exportScene(engine, registry, request)).rejects.toBeDefined();
      await expect(
        exportScene(engine, registry, { ...request, signal: new AbortController().signal, scale: 1000 })
      ).rejects.toThrow('尺寸');
      expect(create).not.toHaveBeenCalled();
    } finally {
      engine.destroy();
    }
  });
});
