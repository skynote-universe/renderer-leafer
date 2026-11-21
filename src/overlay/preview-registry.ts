/**
 * @file preview-registry.ts
 * @description DOM 原位预览渲染器协议与注册表 (PreviewRendererRegistry)
 *
 * 设计考量 (Why):
 * 1. 与 LeaferNodeRendererRegistry 对称：预览层只面向注册表调度定位、裁切、排序与焦点交接，
 *    不耦合具体节点类型（video / web-link / 未来自定义预览）。
 * 2. 外部开发者可按 nodeType 注册自定义 DOM 预览实现，无需修改渲染器内部代码。
 */

import type { NodeEntity, Point, SkyNoteEngine } from '@skynote/core';

/** 单个原位 DOM 预览实例协议 */
export interface ContentPreviewInstance {
  readonly element: HTMLElement;
  readonly source: string | undefined;
  readonly canInteract: boolean;
  /** 节点移出视口但仍处于活跃态（如播放中的视频）时，仅隐藏 DOM 而不销毁实例 */
  readonly keepAliveWhenOffscreen?: boolean;
  position(engine: SkyNoteEngine, node: Readonly<NodeEntity>, outline: readonly Point[]): void;
  setInteractive(interactive: boolean, showHint?: boolean): void;
  focus(): void;
  /** 节点可见时同步非源标识类的附属属性（如封面、标题） */
  update?(engine: SkyNoteEngine, node: Readonly<NodeEntity>): void;
  /** 节点离屏销毁前保存会话态（如播放进度、倍速、音量），下次回到视口时传回 */
  captureState?(): unknown;
  destroy(): void;
}

export interface ContentPreviewCreateContext {
  readonly doc: Document;
  readonly engine: SkyNoteEngine;
  readonly node: Readonly<NodeEntity>;
  readonly source: string | undefined;
  readonly savedState: unknown;
  readonly onExit: (restoreFocus?: boolean) => void;
  readonly requestRender: () => void;
}

/** 按节点类型注册的 DOM 原位预览工厂 */
export interface ContentPreviewRenderer {
  readonly nodeType: string;
  /** 返回 undefined 表示该节点当前不进入 DOM 预览层 */
  resolveSource(engine: SkyNoteEngine, node: Readonly<NodeEntity>): { readonly source: string | undefined } | undefined;
  create(context: ContentPreviewCreateContext): ContentPreviewInstance;
  /** 文档变更时判断已保存的离屏会话态是否仍有效；返回 false 时清除缓存 */
  shouldKeepSavedState?(engine: SkyNoteEngine, node: Readonly<NodeEntity> | undefined, savedState: unknown): boolean;
}

export class PreviewRendererRegistry {
  private readonly renderers = new Map<string, ContentPreviewRenderer>();
  private readonly listeners = new Set<() => void>();

  register(renderer: ContentPreviewRenderer): () => void {
    this.renderers.set(renderer.nodeType, renderer);
    this.notify();
    return () => {
      if (this.renderers.get(renderer.nodeType) === renderer) {
        this.renderers.delete(renderer.nodeType);
        this.notify();
      }
    };
  }

  unregister(nodeType: string): boolean {
    if (!this.renderers.delete(nodeType)) return false;
    this.notify();
    return true;
  }

  get(nodeType: string): ContentPreviewRenderer | undefined {
    return this.renderers.get(nodeType);
  }

  has(nodeType: string): boolean {
    return this.renderers.has(nodeType);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.renderers.clear();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
