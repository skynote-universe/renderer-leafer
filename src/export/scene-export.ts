import { Group, Leafer } from 'leafer-ui';
import type { CanvasExportRequest, CanvasExportResult, SkyNoteEngine } from '@skynote/core';
import { NodeLayer } from '../layers/node-layer';
import { ConnectorLayer } from '../layers/connector-layer';
import { ContentOrderSync } from '../layers/content-order-sync';
import { PrimitiveMapper } from '../primitives/primitive-mapper';
import { LeaferFontMeasurer } from '../text/leafer-font-measurer';
import { LeaferNodeRendererRegistry } from '../registry/leafer-node-renderer-registry';
import { ImageNodeRenderer } from '../node/image-node-renderer';
import type { LeaferNodeRendererRegistry as SourceRegistry } from '../registry/leafer-node-renderer-registry';

const MIME_TYPES = new Map<string, string>([
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp']
]);
export const LEAFER_EXPORT_FORMATS: readonly string[] = Object.freeze([...MIME_TYPES.keys()]);

/** 原生编码/读取无法中止底层任务；取消时停止等待并丢弃迟到结果。 */
function waitAbortable<T>(
  signal: AbortSignal,
  start: (resolve: (value: T) => void, reject: (reason: unknown) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      complete();
    };
    const abort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      start(
        (value) => finish(() => resolve(value)),
        (reason) => finish(() => reject(reason))
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/** 新建隔离场景：不依赖视锥、LOD、分帧队列或正在显示的图元。 */
export async function exportScene(
  engine: SkyNoteEngine,
  source: SourceRegistry,
  request: CanvasExportRequest,
  builtinImages?: ImageNodeRenderer
): Promise<CanvasExportResult> {
  const { bounds, scale, signal } = request;
  signal.throwIfAborted();
  const mimeType = MIME_TYPES.get(request.format);
  if (!mimeType) throw new Error(`不支持导出格式：${request.format}`);
  if (
    request.quality !== undefined &&
    (!Number.isFinite(request.quality) || request.quality < 0 || request.quality > 1)
  )
    throw new Error('导出质量必须在0到1之间');
  if (mimeType === 'image/jpeg' && request.background === 'transparent')
    throw new Error('JPEG不支持透明背景，请使用画布背景');
  const pixelWidth = Math.ceil((bounds.right - bounds.left) * scale);
  const pixelHeight = Math.ceil((bounds.bottom - bounds.top) * scale);
  if (
    ![bounds.left, bounds.top, bounds.right, bounds.bottom, scale].every(Number.isFinite) ||
    scale <= 0 ||
    pixelWidth <= 0 ||
    pixelHeight <= 0 ||
    pixelWidth > 8192 ||
    pixelHeight > 8192 ||
    pixelWidth * pixelHeight > 16_777_216
  )
    throw new Error('导出尺寸超出限制');
  const nodeIds = engine.spatialIndex.search(bounds);
  for (const id of nodeIds) {
    const type = engine.entityStore.getNode(id)!.entity.nodeType;
    const renderer = source.get(type);
    if (renderer && (type !== 'image' || renderer !== builtinImages))
      throw new Error(`节点类型${type}暂不支持独立图片导出`);
  }
  const connectorIds = engine.connectorSpatialIndex.search(bounds);
  const canvas = document.createElement('canvas');
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const leafer = new Leafer({
    view: canvas,
    width,
    height,
    pixelRatio: scale,
    fill: request.background === 'canvas' ? engine.session.theme.background : undefined
  });
  const content = new Group({ x: -bounds.left, y: -bounds.top });
  leafer.add(content);
  const registry = new LeaferNodeRendererRegistry();
  const images = new ImageNodeRenderer((id) => engine.documentStore.getView().assets?.[id], engine.assets);
  registry.register(images);
  const mapper = new PrimitiveMapper(new LeaferFontMeasurer());
  const nodes = new NodeLayer({ engine, contentLayer: content, renderers: registry, mapper, offscreenCacheLimit: 0 });
  const connectors = new ConnectorLayer({ engine, mapper, offscreenCacheLimit: 0 });
  try {
    const containers = new Set<string>();
    for (const id of connectorIds) {
      const parent = connectors.getPlacement(id)?.containerId;
      if (parent !== undefined) containers.add(parent);
    }
    nodes.sync(
      nodeIds,
      () => true,
      {
        viewport: { x: -bounds.left, y: -bounds.top, zoom: 1 },
        isInteracting: false,
        theme: engine.session.theme,
        textEditing: null
      },
      'full',
      containers
    );
    connectors.sync(
      connectorIds,
      () => true,
      engine.session.theme,
      null,
      (id) => (id === undefined ? content : nodes.getChildrenContainer(id)!)
    );
    new ContentOrderSync(nodes, connectors, engine.entityStore).sync(true);
    // 图片URL解析/预加载和Leafer实际纹理加载都完成后再编码；取消/超时及时释放离屏资源。
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('图片加载超时，请稍后重试')), 30_000);
      let stopImages = () => {};
      let waiting = false;
      let settled = false;
      const abort = () => finish(signal.reason ?? new Error('已取消导出'));
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stopImages();
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        let loading = false;
        for (const id of nodeIds) {
          const state = images.getState(id);
          if (state?.status === 'failed') {
            finish(new Error('存在无法加载的图片，请修复后再导出'));
            return;
          }
          if (state?.status === 'loading') loading = true;
        }
        if (loading) return;
        if (!waiting) {
          waiting = true;
          leafer.forceRender(undefined, true);
          leafer.waitViewCompleted(() => finish());
        }
      };
      stopImages = images.subscribe(check);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
    signal.throwIfAborted();
    leafer.forceRender(undefined, true);
    const blob = await waitAbortable<Blob>(signal, (resolve, reject) => {
      try {
        canvas.toBlob(
          (value) => {
            if (!value) reject(new Error('图片编码失败'));
            else if (value.type !== mimeType) reject(new Error(`当前环境不支持导出格式：${request.format}`));
            else resolve(value);
          },
          mimeType,
          request.quality
        );
      } catch {
        reject(new Error('图片不允许跨域导出，请检查图片来源'));
      }
    });
    signal.throwIfAborted();
    const buffer = await waitAbortable<ArrayBuffer>(signal, (resolve, reject) => {
      void blob.arrayBuffer().then(resolve, reject);
    });
    const data = new Uint8Array(buffer);
    signal.throwIfAborted();
    return {
      data,
      mimeType: blob.type,
      width: canvas.width,
      height: canvas.height
    };
  } finally {
    connectors.destroyAll();
    nodes.destroyAll();
    images.dispose();
    registry.clear();
    leafer.destroy();
    canvas.width = canvas.height = 0;
  }
}
