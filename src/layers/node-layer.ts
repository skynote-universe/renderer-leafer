/**
 * @file node-layer.ts
 * @description 节点图层：节点图元的创建、就地更新、LOD 占位、崩溃降级与离屏缓存淘汰
 *
 * 设计考量 (Why):
 * 1. 双版本号守卫：几何版本变化只更新外层变换，数据版本、主题或细节档位变化才重建内容；
 *    选中态不参与 (选中效果由覆盖层绘制)，框选上千节点不触发任何内容重建。
 * 2. 单节点崩溃防白屏：内容渲染异常局部捕获并降级为占位框，直到数据再次变化才重试，避免每帧重复抛错。
 * 3. 主题驱动配色：缺省色取自主题，compose() 图元经 applyThemeToPrimitives 统一解析，本文件不含写死色值。
 */

import { Group } from 'leafer';
import type { SkyNoteEngine, NodeEntity, CanvasPrimitive, NodeFill, CanvasTheme } from '@skynote/core';
import { applyThemeToPrimitives, resolveThemeColor } from '@skynote/core';
import type { NodeRenderCache, LeaferRenderContext, LayerSyncResult } from '../types';
import { reconcileLeaferShapes } from '../primitives/primitive-mapper';
import type { LeaferNodeRendererRegistry } from '../registry/leafer-node-renderer-registry';
import { VisibilityTracker } from './visibility-tracker';

/** 本帧要求的节点细节档位 */
export type NodeRenderDetail = 'full' | 'placeholder';

/** 渐变填充在占位与兜底矩形中退化为首个色标 */
function resolveNodeFill(fill: NodeFill | undefined, theme: CanvasTheme, fallback: string): string {
  const color = typeof fill === 'object' ? fill.stops[0]?.color : fill;
  return resolveThemeColor(color, theme, fallback)!;
}

export interface NodeLayerOptions {
  contentLayer: Group;
  engine: SkyNoteEngine;
  renderers: LeaferNodeRendererRegistry;
  dpr: number;
  offscreenCacheLimit: number;
}

export class NodeLayer {
  private readonly caches = new Map<string, NodeRenderCache>();
  private readonly visibility: VisibilityTracker;

  constructor(private readonly options: NodeLayerOptions) {
    this.visibility = new VisibilityTracker(options.offscreenCacheLimit);
  }

  /** 当前持有的图元缓存数 (含离屏保留) */
  get cacheCount(): number {
    return this.caches.size;
  }

  /** 当前挂载在内容层上的节点 */
  get shownIds(): ReadonlySet<string> {
    return this.visibility.shownIds;
  }

  getGroup(nodeId: string): Group | undefined {
    return this.caches.get(nodeId)?.outerGroup;
  }

  /**
   * 渲染本帧视锥内节点，摘除离开视野者并按 LRU 淘汰超额缓存
   * 只对新进入场景的节点计时：已挂载节点多为版本号命中的空转，计入会把单个挂载成本估得虚高
   */
  sync(
    visibleIds: readonly string[],
    isCommitted: (id: string) => boolean,
    context: LeaferRenderContext,
    detail: NodeRenderDetail
  ): LayerSyncResult {
    const entityStore = this.options.engine.entityStore;
    const shown = this.visibility.shownIds;
    const result: LayerSyncResult = { entered: 0, enterMs: 0 };

    this.visibility.beginFrame();
    for (let i = 0; i < visibleIds.length; i++) {
      const nodeId = visibleIds[i];
      if (!isCommitted(nodeId)) continue;
      const runtimeNode = entityStore.getNode(nodeId);
      if (!runtimeNode || runtimeNode.entity.style?.opacity === 0) continue;

      const entering = !shown.has(nodeId);
      const start = entering ? performance.now() : 0;
      this.renderOrUpdate(
        runtimeNode.entity,
        runtimeNode.runtime.geomVersion,
        runtimeNode.runtime.dataVersion,
        context,
        detail
      );
      this.visibility.markShown(nodeId);
      if (entering) {
        result.enterMs += performance.now() - start;
        result.entered++;
      }
    }
    this.visibility.endFrame(
      (nodeId) => this.caches.get(nodeId)?.outerGroup.remove(),
      (nodeId) => this.destroy(nodeId)
    );
    return result;
  }

  /** 销毁节点图元缓存，原生渲染器资源成对释放 */
  destroy(nodeId: string): void {
    this.visibility.forget(nodeId);
    const cache = this.caches.get(nodeId);
    if (!cache) return;
    this.options.renderers.get(cache.node.nodeType)?.destroy?.(cache.shapes, cache.node);
    cache.outerGroup.remove();
    this.caches.delete(nodeId);
  }

  destroyAll(): void {
    for (const nodeId of [...this.caches.keys()]) {
      this.destroy(nodeId);
    }
  }

  private renderOrUpdate(
    node: NodeEntity,
    geomVersion: number,
    dataVersion: number,
    context: LeaferRenderContext,
    detail: NodeRenderDetail
  ): void {
    const { contentLayer } = this.options;
    const cache = this.caches.get(node.id);

    if (cache) {
      cache.node = node;
      if (cache.outerGroup.parent !== contentLayer) contentLayer.add(cache.outerGroup);

      if (cache.geomVersion !== geomVersion) {
        cache.outerGroup.set({
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          rotation: node.rotation ?? 0,
          origin: 'center'
        });
        cache.geomVersion = geomVersion;
      }

      // 已崩溃降级的节点视同占位档位，只在数据或主题变化时重试
      const renderedDetail = cache.detail === 'broken' ? detail : cache.detail;
      if (cache.dataVersion === dataVersion && cache.theme === context.theme && renderedDetail === detail) {
        return;
      }

      cache.dataVersion = dataVersion;
      cache.theme = context.theme;
      this.updateContent(cache, node, context, detail);
      return;
    }

    // 旋转约定：绕节点中心旋转，x / y 仍为未旋转框的左上角 (origin 不改变定位，around 会改变)
    const outerGroup = new Group({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation ?? 0,
      origin: 'center'
    });
    const contentGroup = new Group();
    outerGroup.add(contentGroup);
    contentLayer.add(outerGroup);

    const newCache: NodeRenderCache = {
      outerGroup,
      contentGroup,
      geomVersion,
      dataVersion,
      detail,
      theme: context.theme,
      shapes: [],
      node
    };
    this.caches.set(node.id, newCache);
    this.updateContent(newCache, node, context, detail);
  }

  /**
   * 更新节点内部内容 (占位块 / 原生渲染器 / 声明式图元 IR)，异常局部捕获并降级为占位框
   */
  private updateContent(
    cache: NodeRenderCache,
    node: NodeEntity,
    context: LeaferRenderContext,
    detail: NodeRenderDetail
  ): void {
    try {
      const { theme } = context;
      if (detail === 'placeholder') {
        this.renderPlaceholder(cache, node, theme);
        cache.detail = 'placeholder';
        return;
      }

      // 1. 专属原生自定义渲染器：从占位/崩溃态恢复时需整体重建
      const nativeRenderer = this.options.renderers.get(node.nodeType);
      if (nativeRenderer) {
        if (cache.detail !== 'full' || cache.shapes.length === 0) {
          this.discardShapes(cache, node);
          cache.shapes = nativeRenderer.create(node, context);
          cache.shapes.forEach((shape) => cache.contentGroup.add(shape));
        } else {
          nativeRenderer.update(cache.shapes, node, context);
        }
        cache.detail = 'full';
        return;
      }

      // 2. Core NodeTypeRegistry 的声明式 compose() 图元 IR，未注册类型兜底为基础矩形
      const nodeDef = this.options.engine.nodeTypes.get(node.nodeType);
      const primitives: CanvasPrimitive[] = nodeDef?.compose
        ? applyThemeToPrimitives(nodeDef.compose(node, { theme }), theme)
        : [
            {
              kind: 'rect',
              x: 0,
              y: 0,
              width: node.width,
              height: node.height,
              fill: resolveNodeFill(node.style?.fill, theme, theme.nodeFill),
              stroke: resolveThemeColor(node.style?.stroke, theme, theme.nodeStroke),
              strokeWidth: node.style?.strokeWidth ?? 1,
              radius: node.style?.radius
            }
          ];

      if (cache.detail !== 'full') this.discardShapes(cache, node);
      cache.shapes = reconcileLeaferShapes(cache.contentGroup, cache.shapes, primitives, this.options.dpr);
      cache.detail = 'full';
    } catch (err) {
      console.error(`[LeaferRenderer] 节点 ${node.id} (${node.nodeType}) 渲染失败，已降级为占位框:`, err);
      try {
        this.renderPlaceholder(cache, node, context.theme);
      } catch {
        // 占位框本身失败时保留空内容，保证渲染循环继续
      }
      cache.detail = 'broken';
    }
  }

  /**
   * 纯色占位块：跳过文本排版与 compose，仅按节点填充色 (未设置时取主题占位色) 绘制一个矩形
   */
  private renderPlaceholder(cache: NodeRenderCache, node: NodeEntity, theme: CanvasTheme): void {
    if (cache.detail === 'full') this.discardShapes(cache, node);
    cache.shapes = reconcileLeaferShapes(
      cache.contentGroup,
      cache.shapes,
      [
        {
          kind: 'rect',
          x: 0,
          y: 0,
          width: node.width,
          height: node.height,
          fill: resolveNodeFill(node.style?.fill, theme, theme.placeholderFill),
          radius: node.style?.radius
        }
      ],
      this.options.dpr
    );
  }

  /** 切换内容来源前释放现有图元，原生渲染器的资源成对 destroy */
  private discardShapes(cache: NodeRenderCache, node: NodeEntity): void {
    if (cache.detail === 'full') {
      this.options.renderers.get(node.nodeType)?.destroy?.(cache.shapes, node);
    }
    for (let i = 0; i < cache.shapes.length; i++) {
      cache.shapes[i].remove();
    }
    cache.shapes = [];
  }
}
