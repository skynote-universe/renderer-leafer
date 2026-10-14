/**
 * @file image-node-renderer.ts
 * @description 图片资产解析与 Leafer 图元生命周期
 *
 * 设计考量 (Why):
 * 图片二进制由宿主适配器持有；视图只在可见期间解析显示地址，并在节点离开渲染缓存时释放。
 */

import { Rect, Text } from 'leafer';
import type { IUIInputData } from 'leafer';
import type { AssetAdapter, NodeEntity, NodeFill } from '@skynote/core';
import { resolveThemeColor } from '@skynote/core';
import type { LeaferNodeLifecycleRenderer } from '../registry/leafer-node-renderer-registry';
import type { ImageFailureAppearance, LeaferRenderContext, LeaferShape } from '../types';

interface ImageNodeState {
  readonly assetId: string;
  readonly src: string;
  readonly fit: string;
  readonly controller: AbortController;
  url?: string;
  preloader?: HTMLImageElement;
}

type ImageNodeEntity = Omit<NodeEntity, 'image'> & {
  image?: { assetId?: string; fit?: 'fill' | 'cover' | 'contain' | 'none' };
};

const IMAGE_FITS = ['fill', 'cover', 'contain', 'none'] as const;

interface FailureState {
  readonly controller: AbortController;
  url?: string;
  preloader?: HTMLImageElement;
  loaded?: boolean;
}

export class ImageNodeRenderer implements LeaferNodeLifecycleRenderer {
  readonly nodeType = 'image';
  private readonly states = new Map<Rect, ImageNodeState>();
  private readonly failures = new Map<Rect, FailureState>();

  constructor(
    private readonly getAsset: (assetId: string) => { src: string } | undefined,
    private readonly assets: AssetAdapter | undefined,
    private readonly failureAppearance?: ImageFailureAppearance
  ) {}

  create(node: NodeEntity, context: LeaferRenderContext): LeaferShape[] {
    const background = new Rect();
    const placeholder = new Rect({
      x: 0,
      y: 0,
      width: node.width,
      height: node.height,
      fill: context.theme.placeholderFill
    });
    const image = new Rect({ x: 0, y: 0, width: node.width, height: node.height, opacity: node.style?.opacity ?? 1 });
    const border = new Rect();
    const status = new Text({
      textAlign: 'center',
      verticalAlign: 'middle',
      fontSize: 12,
      padding: 8,
      textOverflow: 'hide',
      hittable: false
    });
    const shapes = [background, placeholder, image, border, status];
    this.updateStyle(shapes, node, context);
    this.load(node, placeholder, image, status);
    return shapes;
  }

  update(shapes: LeaferShape[], node: NodeEntity, context: LeaferRenderContext): void {
    const background = shapes[0] as Rect;
    const placeholder = shapes[1] as Rect;
    const image = shapes[2] as Rect;
    const border = shapes[3] as Rect;
    const status = shapes[4] as Text;
    this.updateStyle([background, placeholder, image, border, status], node, context);
    const state = this.states.get(image);
    const assetId = (node as ImageNodeEntity).image?.assetId;
    const src = assetId ? this.getAsset(assetId)?.src : undefined;
    if (state?.assetId !== assetId || state?.fit !== resolveFit(node as ImageNodeEntity) || state?.src !== src)
      this.load(node, placeholder, image, status);
  }

  destroy(shapes: LeaferShape[]): void {
    const image = shapes[2] as Rect | undefined;
    if (!image) return;
    this.releaseFailure(image);
    const state = this.states.get(image);
    if (!state) return;
    this.releaseState(state);
    this.states.delete(image);
  }

  private updateStyle(shapes: readonly (Rect | Text)[], node: NodeEntity, context: LeaferRenderContext): void {
    const [background, placeholder, image, border, status] = shapes;
    const style = node.style;
    const fill = resolveImageFill(style?.fill, context);
    const stroke = resolveThemeColor(style?.stroke, context.theme, context.theme.nodeStroke);
    const size = { width: node.width, height: node.height, cornerRadius: style?.radius };
    const backgroundFill =
      fill !== undefined && style?.fillOpacity !== undefined
        ? { type: 'solid', color: fill, opacity: style.fillOpacity }
        : fill;
    const borderStroke =
      style?.stroke === 'transparent'
        ? undefined
        : style?.strokeOpacity !== undefined
          ? { type: 'solid', color: stroke, opacity: style.strokeOpacity }
          : stroke;
    background.set({ ...size, fill: backgroundFill as IUIInputData['fill'], opacity: 1, stroke: undefined });
    // 仅在加载状态切换时调整占位层透明度；样式更新不能让它重新盖住图片与填充底色。
    placeholder.set({ ...size, fill: context.theme.placeholderFill });
    image.set({ ...size, opacity: this.failures.get(image)?.loaded ? 1 : (style?.opacity ?? 1) });
    status.set({ width: node.width, height: node.height, fill: context.theme.textColor });
    border.set({
      ...size,
      fill: undefined,
      opacity: 1,
      stroke: borderStroke as IUIInputData['stroke'],
      strokeWidth: style?.strokeWidth ?? 0,
      dashPattern: style?.strokeDashArray
    });
  }

  private load(node: NodeEntity, placeholder: Rect, image: Rect, status: Text): void {
    this.releaseFailure(image);
    placeholder.set({ opacity: 1 });
    status.set({ text: '图片加载中', opacity: 1 });
    const previous = this.states.get(image);
    if (previous) {
      this.releaseState(previous);
      this.states.delete(image);
    }
    image.set({ fill: undefined });
    const imageNode = node as ImageNodeEntity;
    const assetId = imageNode.image?.assetId;
    const asset = assetId ? this.getAsset(assetId) : undefined;
    if (!assetId || !asset || !this.assets) {
      image.set({ fill: undefined });
      status.set({ text: !assetId || !asset ? '图片资产缺失' : '图片加载不可用' });
      this.showFailure(node, !assetId || !asset ? 'missing-asset' : 'unavailable', placeholder, image, status);
      return;
    }
    const controller = new AbortController();
    const fit = resolveFit(imageNode);
    const state: ImageNodeState = { assetId, src: asset.src, fit, controller };
    this.states.set(image, state);
    image.set({ cornerRadius: node.style?.radius, opacity: node.style?.opacity ?? 1 });
    let resolving: ReturnType<AssetAdapter['resolve']>;
    try {
      resolving = this.assets.resolve(asset.src, { signal: controller.signal });
    } catch {
      status.set({ text: '图片加载失败，请重新选择' });
      this.showFailure(node, 'load-failed', placeholder, image, status);
      return;
    }
    Promise.resolve(resolving)
      .then((url) => {
        if (controller.signal.aborted || this.states.get(image) !== state) {
          this.assets?.release?.(asset.src, url);
          return;
        }
        state.url = url;
        const preloader = new globalThis.Image();
        state.preloader = preloader;
        preloader.crossOrigin = 'anonymous';
        preloader.onload = () => {
          if (controller.signal.aborted || this.states.get(image) !== state) return;
          const mode = { fill: 'stretch', cover: 'cover', contain: 'fit', none: 'clip' }[fit];
          const fill = { type: 'image', url, mode } as unknown as IUIInputData['fill'];
          image.set({ fill });
          placeholder.set({ opacity: 0 });
          status.set({ opacity: 0 });
        };
        preloader.onerror = () => {
          if (!controller.signal.aborted && this.states.get(image) === state) {
            placeholder.set({ opacity: 1 });
            status.set({ text: '图片无法解码，请重新选择' });
            this.releaseState(state);
            state.url = undefined;
            this.showFailure(node, 'decode-failed', placeholder, image, status);
          }
        };
        preloader.src = url;
      })
      .catch(() => {
        if (!controller.signal.aborted && this.states.get(image) === state) {
          image.set({ fill: undefined });
          placeholder.set({ opacity: 1 });
          status.set({ text: '图片加载失败，请重新选择' });
          this.showFailure(node, 'load-failed', placeholder, image, status);
        }
      });
  }

  private releaseState(state: ImageNodeState): void {
    state.controller.abort();
    if (state.preloader) {
      state.preloader.onload = null;
      state.preloader.onerror = null;
      state.preloader.removeAttribute('src');
    }
    if (state.url) this.assets?.release?.(state.src, state.url);
  }

  private showFailure(
    node: NodeEntity,
    reason: Parameters<ImageFailureAppearance['resolve']>[1],
    placeholder: Rect,
    image: Rect,
    status: Text
  ): void {
    const appearance = this.failureAppearance;
    if (!appearance) return;
    this.releaseFailure(image);
    const state: FailureState = { controller: new AbortController() };
    this.failures.set(image, state);
    Promise.resolve()
      .then(() => {
        state.controller.signal.throwIfAborted();
        return appearance.resolve(node, reason, { signal: state.controller.signal });
      })
      .then((url) => {
        if (state.controller.signal.aborted || this.failures.get(image) !== state) {
          appearance.release?.(url);
          return;
        }
        state.url = url;
        const preloader = new globalThis.Image();
        state.preloader = preloader;
        preloader.onload = () => {
          if (state.controller.signal.aborted || this.failures.get(image) !== state) return;
          state.loaded = true;
          image.set({ fill: { type: 'image', url, mode: 'fit' } as IUIInputData['fill'], opacity: 1 });
          placeholder.set({ opacity: 0 });
          status.set({ opacity: 0 });
        };
        preloader.onerror = () => {
          if (this.failures.get(image) === state) this.releaseFailure(image);
        };
        preloader.src = url;
      })
      .catch(() => {
        if (this.failures.get(image) === state) this.releaseFailure(image);
      });
  }

  private releaseFailure(image: Rect): void {
    const state = this.failures.get(image);
    if (!state) return;
    this.failures.delete(image);
    state.controller.abort();
    if (state.preloader) {
      state.preloader.onload = null;
      state.preloader.onerror = null;
      state.preloader.removeAttribute('src');
    }
    if (state.url) this.failureAppearance?.release?.(state.url);
  }
}

function resolveImageFill(fill: NodeFill | undefined, context: LeaferRenderContext): string | undefined {
  if (fill === undefined) return undefined;
  const color = typeof fill === 'object' ? fill.stops[0]?.color : fill;
  return resolveThemeColor(color, context.theme, context.theme.nodeFill);
}

function resolveFit(node: ImageNodeEntity): (typeof IMAGE_FITS)[number] {
  const fit = node.image?.fit;
  return fit && IMAGE_FITS.includes(fit) ? fit : 'cover';
}
