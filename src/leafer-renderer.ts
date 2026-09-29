/**
 * @file leafer-renderer.ts
 * @description SkyNote LeaferJS 高性能交互渲染适配器 (LeaferRenderer)
 * 
 * 遵守 AGENTS.md 准则与性能军规：
 * 1. 纯事务与单向数据流：仅消费 DocumentStore 广播的增量变更集，同一帧内的多次提交合并为一次 rAF 渲染；
 * 7. 帧开销与画布规模无关：每帧只处理视锥内实体与本帧删除的实体，离屏图元从场景树摘除，
 *    Leafer 自身遍历成本同样只随可见规模增长；离屏缓存按 LRU 限额淘汰，内存不随浏览过的画布面积无限增长。
 * 2. 双版本号守卫：几何变化仅更新变换矩阵，内容变化就地修改图元属性，零无谓 GC 掉帧；
 * 3. 视锥裁剪：通过 Core 的 spatialIndex 仅绘制视口范围内节点；
 * 4. 顶层瞬态通道与自动兜底守护：0 DOM 瞬态图元绘制通道，Blur 与 Escape 时 100% 自动清空无残留；
 * 5. 全链路闭环：Resize 自动感知、视口双向同步、全实体碰撞拾取、自适应 LOD 与帧性能度量深度串联；
 * 6. 单一事实源：视口与选区直连引擎的本地会话状态 (engine.session)，渲染器不持有副本；
 * 8. LOD 降级：缩放过小或渲染压力过大时，节点降级为纯色占位块 (跳过排版与 compose)，极限档位不绘制连线；
 * 9. 单节点崩溃防白屏：节点渲染异常被局部捕获并降级为占位框，直到其数据再次变化才重试；
 * 10. 主题驱动配色：全部缺省色取自 engine.session.theme，compose() 图元经 applyThemeToPrimitives 统一解析，
 *     本文件不含任何写死色值；主题切换后视锥内实体逐个重建，离屏实体进入视野时再重建。
 */

import { Leafer, Group } from 'leafer';
import type {
  SkyNoteEngine,
  NodeEntity,
  ConnectorEntity,
  Point,
  CanvasPrimitive,
  RectBounds,
  NodeFill,
  CanvasWheelEvent,
  CanvasTheme
} from '@skynote/core';
import { applyThemeToPrimitives, resolveThemeColor } from '@skynote/core';
import type {
  LeaferRendererOptions,
  NodeRenderCache,
  ConnectorRenderCache,
  LeaferRenderContext,
  HitEntityResult
} from './types';
import {
  screenToWorld,
  worldToScreen,
  getViewportWorldBounds,
  distanceToPolyline,
  type ViewportState
} from './viewport/viewport-transform';
import { reconcileLeaferShapes } from './primitives/primitive-mapper';
import { EphemeralChannel } from './ephemeral/ephemeral-channel';
import { renderConnector } from './connector/connector-renderer';
import { DOMHostBridge } from './bridge/host-bridge';
import { LeaferNodeRendererRegistry } from './registry/leafer-node-renderer-registry';
import { LeaferConnectorRendererRegistry } from './registry/leafer-connector-renderer-registry';
import { FrameCommitScheduler } from './scheduler/frame-commit-scheduler';
import {
  AdaptiveLodController,
  DEFAULT_ADAPTIVE_LOD_OPTIONS,
  type SkyNoteLodLevel,
  type SkyNoteAdaptiveLodState
} from './scheduler/adaptive-lod';
import {
  compareHierarchicalNodes,
  resolveConnectorLayerAnchor,
  compareContentLayerEntries,
  type ContentLayerOrderEntry
} from './layering/content-layer-order';

const EPHEMERAL_ESCAPE_SCOPE_ID = 'renderer:ephemeral-escape';
const DEFAULT_OFFSCREEN_CACHE_LIMIT = 2000;

/** 本帧要求的节点细节档位 */
type NodeRenderDetail = 'full' | 'placeholder';

/** 渐变填充在占位与兜底矩形中退化为首个色标 */
function resolveNodeFill(fill: NodeFill | undefined, theme: CanvasTheme, fallback: string): string {
  const color = typeof fill === 'object' ? fill.stops[0]?.color : fill;
  return resolveThemeColor(color, theme, fallback)!;
}

export class LeaferRenderer {
  readonly engine: SkyNoteEngine;
  readonly nodeRenderers = new LeaferNodeRendererRegistry();
  readonly connectorRenderers = new LeaferConnectorRendererRegistry();

  private container: HTMLElement | null = null;
  private leaferApp: Leafer | null = null;
  private sceneGroup: Group | null = null;
  private backgroundLayer: Group | null = null;
  private contentLayer: Group | null = null;
  private ephemeralGroup: Group | null = null;
  private hostBridge: DOMHostBridge | null = null;

  private dpr: number = 1;
  private isInteracting: boolean = false;
  private currentLodLevel: SkyNoteLodLevel = 'full';

  private readonly nodeCaches = new Map<string, NodeRenderCache>();
  private readonly connectorCaches = new Map<string, ConnectorRenderCache>();
  private ephemeralChannel: EphemeralChannel | null = null;
  private readonly frameScheduler: FrameCommitScheduler;
  private readonly lodController: AdaptiveLodController;
  private resizeObserver: ResizeObserver | null = null;
  private scheduledRafId: number | null = null;
  private contentOrderDirty = true;
  /** 当前挂载在内容层上的实体 (视锥内且已提交)；每帧只与新视锥结果做差集 */
  private shownNodeIds = new Set<string>();
  private shownConnectorIds = new Set<string>();
  /** 自上一帧以来被删除、待销毁图元缓存的实体 */
  private readonly pendingRemovedNodeIds = new Set<string>();
  private readonly pendingRemovedConnectorIds = new Set<string>();
  /**
   * 离屏但仍保留图元缓存的实体，Set 的插入序即 LRU 序 (最早离开视野者在前)
   * 回到视野时移出，超出上限时从头部淘汰，每次操作 O(1)
   */
  private readonly offscreenNodeIds = new Set<string>();
  private readonly offscreenConnectorIds = new Set<string>();
  private readonly offscreenCacheLimit: number;
  /** 实体首次渲染时分配的稳定序号，作为层级完全并列时的确定性排序依据 */
  private readonly stableOrders = new Map<string, number>();
  private stableOrderSeq = 0;

  private unsubscribeDoc: (() => void) | null = null;
  private unsubscribeSession: (() => void) | null = null;
  /** LOD 回升存在迟滞：等待期满后需主动补一帧，否则画面会停留在降级档位直到下一次交互 */
  private lodRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private unregisterDefaultWheel: (() => void) | null = null;
  private abortController = new AbortController();
  private isDestroyed = false;

  constructor(engine: SkyNoteEngine, options?: LeaferRendererOptions) {
    this.engine = engine;
    this.dpr = options?.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

    if (options?.initialViewport) {
      engine.session.setViewport(options.initialViewport);
    }

    this.offscreenCacheLimit = Math.max(0, options?.offscreenCacheLimit ?? DEFAULT_OFFSCREEN_CACHE_LIMIT);

    // 闭环注入 enableFrameScheduler 配置
    this.frameScheduler = new FrameCommitScheduler({
      enabled: options?.enableFrameScheduler !== false
    });
    this.lodController = new AdaptiveLodController();

    if (options?.container) {
      this.mount(options.container);
    }
  }

  /**
   * 挂载至指定 DOM 容器并初始化 Leafer 场景树
   */
  mount(container: HTMLElement): void {
    if (this.isDestroyed || this.container) return;

    this.container = container;
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    // 1. 初始化 Leafer 根应用，画布底色取自主题
    this.leaferApp = new Leafer({
      view: container,
      width,
      height,
      pixelRatio: this.dpr,
      fill: this.engine.session.theme.background
    });

    // 2. 建立场景树分层结构 (底层背景层 backgroundLayer -> 统一内容层 contentLayer -> 顶层瞬态交互层 ephemeralGroup)
    const { viewport } = this.engine.session;
    this.sceneGroup = new Group({
      x: viewport.x,
      y: viewport.y,
      scaleX: viewport.zoom,
      scaleY: viewport.zoom
    });
    this.backgroundLayer = new Group();
    this.contentLayer = new Group();
    this.ephemeralGroup = new Group();

    this.sceneGroup.add(this.backgroundLayer);
    this.sceneGroup.add(this.contentLayer);
    this.sceneGroup.add(this.ephemeralGroup);
    this.leaferApp.add(this.sceneGroup);

    // 3. 挂载瞬态渲染通道
    this.ephemeralChannel = new EphemeralChannel(this.ephemeralGroup, this.dpr);

    // 4. 初始化宿主事件网桥并接入交互态感知闭环
    this.hostBridge = new DOMHostBridge({
      container,
      engine: this.engine,
      getViewport: () => this.engine.session.viewport,
      hitTest: (point: Point) => this.hitTest(point),
      onInteractionChange: (isInteracting: boolean) => {
        this.isInteracting = isInteracting;
      }
    });

    // 5. 注册底座默认滚轮与缩放交互 (优先级 -100，允许上层交互优先拦截)
    this.unregisterDefaultWheel = this.engine.pointer.register(
      'renderer:viewport-wheel',
      {
        onWheel: (e: CanvasWheelEvent) => {
          this.handleDefaultWheel(e);
        }
      },
      -100
    );

    // 6. 订阅 DocumentStore 状态变更 (支持外部撤销重做与视口同步)
    this.unsubscribeDoc = this.engine.documentStore.subscribe((_docView, _record, changes) => {
      for (const id of changes.nodes.removed) this.pendingRemovedNodeIds.add(id);
      for (const id of changes.connectors.removed) this.pendingRemovedConnectorIds.add(id);
      if (changes.orderChanged) this.contentOrderDirty = true;
      this.requestRender();
    });

    // 视口变换矩阵立即生效 (平移缩放零延迟跟手)，视锥与选中态重绘合并到下一帧
    this.unsubscribeSession = this.engine.session.subscribe((change) => {
      if (change.viewportChanged) this.applyViewportTransform();
      if (change.themeChanged && this.leaferApp) this.leaferApp.fill = this.engine.session.theme.background;
      this.requestRender();
    });

    // 7. 失焦与 Esc 兜底清空瞬态蚂蚁线框：Esc 经 ADR-005 焦点栈以最低优先级消费，
    //    上层交互 (如取消拖拽) 先行处理；不消费事件，保留其他作用域与宿主的默认行为
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', () => this.ephemeralChannel?.clearAll(), { signal: this.abortController.signal });
    }
    this.engine.inputScopes.pushScope({
      id: EPHEMERAL_ESCAPE_SCOPE_ID,
      priority: -100,
      onKeyDown: (e) => {
        if (e.key === 'Escape') this.ephemeralChannel?.clearAll();
      }
    });

    // 8. 挂载容器尺寸监听 (ResizeObserver 自动响应)
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(entries => {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const newWidth = Math.floor(entry.contentRect.width);
          const newHeight = Math.floor(entry.contentRect.height);
          if (newWidth > 0 && newHeight > 0 && this.leaferApp) {
            this.leaferApp.resize({ width: newWidth, height: newHeight });
            this.requestRender();
          }
        }
      });
      this.resizeObserver.observe(container);
    }

    // 首帧渲染
    this.renderFrame();
  }

  /**
   * 获取瞬态图元渲染通道 (用于拉出蚂蚁线框、对齐吸附线)
   */
  get ephemeral(): EphemeralChannel {
    if (!this.ephemeralChannel) {
      throw new Error('[LeaferRenderer] 渲染器尚未 mount 到 DOM 容器，无法使用瞬态通道');
    }
    return this.ephemeralChannel;
  }

  /**
   * 申请在下一动画帧渲染：同一帧内的多次提交 (拖拽、滚轮连发) 只渲染一次
   * 无 rAF 的宿主 (Node / Worker 离屏) 退化为同步渲染
   */
  requestRender(): void {
    if (this.isDestroyed || this.scheduledRafId !== null) return;
    if (typeof requestAnimationFrame === 'undefined') {
      this.renderFrame();
      return;
    }
    this.scheduledRafId = requestAnimationFrame(() => {
      this.scheduledRafId = null;
      this.renderFrame();
    });
  }

  /**
   * 立即执行一帧渲染并冲刷所有待处理变更 (视锥剔除 + 双版本号局部更新 + 自适应 LOD 与分帧调度)
   * 开销只与视锥内实体数和本帧删除数相关，与画布总规模无关
   */
  renderFrame(): void {
    if (this.isDestroyed || !this.sceneGroup || !this.contentLayer) return;
    if (this.scheduledRafId !== null) {
      cancelAnimationFrame(this.scheduledRafId);
      this.scheduledRafId = null;
    }

    const frameStartTime = performance.now();
    const containerWidth = this.container?.clientWidth || 800;
    const containerHeight = this.container?.clientHeight || 600;
    const entityStore = this.engine.entityStore;
    const session = this.engine.session;
    const viewport = session.viewport;

    // 1. 销毁已删除实体的图元缓存
    for (const id of this.pendingRemovedNodeIds) {
      this.destroyNodeCache(id);
    }
    this.pendingRemovedNodeIds.clear();
    for (const id of this.pendingRemovedConnectorIds) {
      this.destroyConnectorCache(id);
    }
    this.pendingRemovedConnectorIds.clear();

    // 2. 计算视口在世界逻辑坐标系下的裁剪包围盒 (Frustum Culling)，扩展缓冲边距覆盖路由外扩与描边
    const worldBounds = getViewportWorldBounds(viewport, containerWidth, containerHeight);
    const padding = 100;
    const expandedBounds: RectBounds = {
      left: worldBounds.left - padding,
      top: worldBounds.top - padding,
      right: worldBounds.right + padding,
      bottom: worldBounds.bottom + padding,
      width: worldBounds.width + padding * 2,
      height: worldBounds.height + padding * 2
    };
    const visibleNodeIds = this.engine.spatialIndex.search(expandedBounds);
    const connectorCandidateIds = this.engine.connectorSpatialIndex.search(expandedBounds);

    // 3. 自适应 LOD 性能度量与降级评估：reduced 起节点降级为占位块，minimal 不再绘制连线
    const lodState = this.lodController.evaluate({
      now: frameStartTime,
      zoom: viewport.zoom,
      documentNodes: entityStore.nodeCount,
      documentConnectors: entityStore.connectorCount,
      visibleNodes: visibleNodeIds.length,
      visibleConnectors: connectorCandidateIds.length,
      nodeObjects: this.nodeCaches.size,
      connectorObjects: this.connectorCaches.size,
      isInteracting: this.isInteracting
    });
    this.currentLodLevel = lodState.level;
    this.scheduleLodRecovery(lodState);
    const nodeDetail: NodeRenderDetail = lodState.level === 'full' ? 'full' : 'placeholder';
    const visibleConnectorIds = lodState.level === 'minimal' ? [] : connectorCandidateIds;

    const context: LeaferRenderContext = {
      viewport,
      isInteracting: this.isInteracting,
      selectedNodeIds: session.selectedNodeIds,
      selectedConnectorIds: session.selectedConnectorIds,
      theme: session.theme
    };

    // 4. 分帧提交调度器判定：大量节点超载时进行分帧缓冲
    const frameResult = this.frameScheduler.reconcileAndCommit({
      nodeIds: visibleNodeIds,
      nodePriorityIds: Array.from(session.selectedNodeIds),
      connectorIds: visibleConnectorIds,
      connectorPriorityIds: Array.from(session.selectedConnectorIds)
    });

    // 5. 渲染或更新视锥内节点 (未变更节点仅做版本号、选中态与细节档位比较)
    const nextShownNodeIds = new Set<string>();
    for (let i = 0; i < visibleNodeIds.length; i++) {
      const nodeId = visibleNodeIds[i];
      if (!frameResult.committedNodeIds.has(nodeId)) continue;
      const runtimeNode = entityStore.getNode(nodeId);
      if (!runtimeNode || runtimeNode.entity.style?.opacity === 0) continue;

      this.renderOrUpdateNode(
        runtimeNode.entity,
        runtimeNode.runtime.geomVersion,
        runtimeNode.runtime.dataVersion,
        this.nodeCaches.get(nodeId),
        context,
        nodeDetail
      );
      nextShownNodeIds.add(nodeId);
      this.offscreenNodeIds.delete(nodeId);
      if (!this.shownNodeIds.has(nodeId)) this.contentOrderDirty = true;
    }
    // 离开视锥的节点从场景树摘除，缓存保留以便回到视野时就地复用，并进入 LRU 队尾
    for (const nodeId of this.shownNodeIds) {
      if (nextShownNodeIds.has(nodeId)) continue;
      this.nodeCaches.get(nodeId)?.outerGroup.remove();
      this.offscreenNodeIds.add(nodeId);
    }
    this.shownNodeIds = nextShownNodeIds;
    while (this.offscreenNodeIds.size > this.offscreenCacheLimit) {
      this.destroyNodeCache(this.offscreenNodeIds.values().next().value!);
    }

    // 6. 渲染视锥内连线与端点标记 (接入端点几何签名与 Fast Path 守卫)
    const nextShownConnectorIds = new Set<string>();
    for (let i = 0; i < visibleConnectorIds.length; i++) {
      const connectorId = visibleConnectorIds[i];
      if (!frameResult.committedConnectorIds.has(connectorId)) continue;
      const runtimeConnector = entityStore.getConnector(connectorId);
      if (!runtimeConnector || runtimeConnector.entity.style?.strokeWidth === 0) continue;

      const route = this.engine.getConnectorRoute(connectorId);
      if (!route) continue;

      const updated = renderConnector(this.contentLayer, {
        connector: runtimeConnector.entity,
        route,
        dataVersion: runtimeConnector.runtime.dataVersion,
        arrowMarkers: this.engine.arrowMarkers,
        existingCache: this.connectorCaches.get(connectorId),
        theme: session.theme
      });
      if (updated.group.parent !== this.contentLayer) this.contentLayer.add(updated.group);
      this.connectorCaches.set(connectorId, updated);

      nextShownConnectorIds.add(connectorId);
      this.offscreenConnectorIds.delete(connectorId);
      if (!this.shownConnectorIds.has(connectorId)) this.contentOrderDirty = true;
    }
    for (const connectorId of this.shownConnectorIds) {
      if (nextShownConnectorIds.has(connectorId)) continue;
      this.connectorCaches.get(connectorId)?.group.remove();
      this.offscreenConnectorIds.add(connectorId);
    }
    this.shownConnectorIds = nextShownConnectorIds;
    while (this.offscreenConnectorIds.size > this.offscreenCacheLimit) {
      this.destroyConnectorCache(this.offscreenConnectorIds.values().next().value!);
    }

    // 7. 拓扑同步图元层级（伴生锚定与父子关系）
    if (this.contentOrderDirty) {
      this.syncContentOrder();
    }

    // 8. 闭环记录帧耗时度量
    const frameDuration = performance.now() - frameStartTime;
    this.lodController.recordFrame(frameDuration, frameStartTime);

    // 9. 若分帧队列中尚有未提交的实体，自动调度下一帧
    if (frameResult.state.active) {
      this.requestRender();
    }
  }

  private destroyNodeCache(nodeId: string): void {
    // 先清理索引集合：即便缓存已不存在也必须出队，否则 LRU 淘汰循环无法前进
    this.shownNodeIds.delete(nodeId);
    this.offscreenNodeIds.delete(nodeId);
    this.stableOrders.delete(nodeId);
    const cache = this.nodeCaches.get(nodeId);
    if (!cache) return;
    this.nodeRenderers.get(cache.node.nodeType)?.destroy?.(cache.shapes, cache.node);
    cache.outerGroup.remove();
    this.nodeCaches.delete(nodeId);
  }

  private destroyConnectorCache(connectorId: string): void {
    // 先清理索引集合：即便缓存已不存在也必须出队，否则 LRU 淘汰循环无法前进
    this.shownConnectorIds.delete(connectorId);
    this.offscreenConnectorIds.delete(connectorId);
    this.stableOrders.delete(connectorId);
    const cache = this.connectorCaches.get(connectorId);
    if (!cache) return;
    this.connectorRenderers.get(cache.connector.connectorType)?.destroy?.([cache.lineShape], cache.connector);
    cache.group.remove();
    this.connectorCaches.delete(connectorId);
  }

  private applyViewportTransform(): void {
    if (!this.sceneGroup) return;
    const { viewport } = this.engine.session;
    this.sceneGroup.set({
      x: viewport.x,
      y: viewport.y,
      scaleX: viewport.zoom,
      scaleY: viewport.zoom
    });
  }

  private scheduleLodRecovery(lodState: SkyNoteAdaptiveLodState): void {
    if (lodState.level === lodState.desiredLevel || this.lodRecoveryTimer !== null) return;
    this.lodRecoveryTimer = setTimeout(() => {
      this.lodRecoveryTimer = null;
      this.requestRender();
    }, DEFAULT_ADAPTIVE_LOD_OPTIONS.recoveryDelayMs + 50);
  }

  private getStableOrder(id: string): number {
    let order = this.stableOrders.get(id);
    if (order === undefined) {
      order = ++this.stableOrderSeq;
      this.stableOrders.set(id, order);
    }
    return order;
  }

  /**
   * 单个节点的就地复用：几何版本变化只更新变换，数据版本、选中态或细节档位变化才重建内容
   */
  private renderOrUpdateNode(
    node: NodeEntity,
    geomVersion: number,
    dataVersion: number,
    cache: NodeRenderCache | undefined,
    context: LeaferRenderContext,
    detail: NodeRenderDetail
  ): void {
    if (!this.contentLayer) return;
    const selected = context.selectedNodeIds.has(node.id);

    if (cache) {
      cache.node = node;
      if (cache.outerGroup.parent !== this.contentLayer) this.contentLayer.add(cache.outerGroup);

      if (cache.geomVersion !== geomVersion) {
        cache.outerGroup.set({
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          rotation: node.rotation ?? 0
        });
        cache.geomVersion = geomVersion;
      }

      // 已崩溃降级的节点视同占位档位，只在数据或选中态变化时重试，避免每帧重复抛错
      const renderedDetail = cache.detail === 'broken' ? detail : cache.detail;
      if (
        cache.dataVersion === dataVersion &&
        cache.selected === selected &&
        cache.theme === context.theme &&
        renderedDetail === detail
      ) {
        return;
      }

      cache.dataVersion = dataVersion;
      cache.selected = selected;
      cache.theme = context.theme;
      this.updateNodeContent(cache, node, context, detail);
      return;
    }

    // 首次渲染，全新构建节点图元包装 Group
    const outerGroup = new Group({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation ?? 0
    });
    const contentGroup = new Group();
    outerGroup.add(contentGroup);
    this.contentLayer.add(outerGroup);

    const newCache: NodeRenderCache = {
      outerGroup,
      contentGroup,
      geomVersion,
      dataVersion,
      selected,
      detail,
      theme: context.theme,
      shapes: [],
      node
    };

    this.nodeCaches.set(node.id, newCache);
    this.updateNodeContent(newCache, node, context, detail);
  }

  /**
   * 更新节点内部内容 (占位块 / 原生渲染器 / 声明式图元 IR)，异常局部捕获并降级为占位框
   */
  private updateNodeContent(
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
      const nativeRenderer = this.nodeRenderers.get(node.nodeType);
      if (nativeRenderer) {
        if (cache.detail !== 'full' || cache.shapes.length === 0) {
          this.discardNodeShapes(cache, node);
          cache.shapes = nativeRenderer.create(node, context);
          cache.shapes.forEach(shape => cache.contentGroup.add(shape));
        } else {
          nativeRenderer.update(cache.shapes, node, context);
        }
        cache.detail = 'full';
        return;
      }

      // 2. Core NodeTypeRegistry 的声明式 compose() 图元 IR，未注册类型兜底为基础矩形
      const nodeDef = this.engine.nodeTypes.get(node.nodeType);
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

      if (cache.detail !== 'full') this.discardNodeShapes(cache, node);
      cache.shapes = reconcileLeaferShapes(cache.contentGroup, cache.shapes, primitives, this.dpr);
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
    if (cache.detail === 'full') this.discardNodeShapes(cache, node);
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
      this.dpr
    );
  }

  /** 切换内容来源前释放现有图元，原生渲染器的资源成对 destroy */
  private discardNodeShapes(cache: NodeRenderCache, node: NodeEntity): void {
    if (cache.detail === 'full') {
      this.nodeRenderers.get(node.nodeType)?.destroy?.(cache.shapes, node);
    }
    for (let i = 0; i < cache.shapes.length; i++) {
      cache.shapes[i].remove();
    }
    cache.shapes = [];
  }

  /**
   * 拓扑同步图元层级（伴生锚定与父子关系），仅在层级脏标记置位时执行，开销 O(V log V)
   * 规则：
   * 1. 伴生锚定：连线跟随两端层级较高者伴生；
   * 2. 紧贴下层：同伴生节点时连线严格排在节点紧下方 (-1)；
   * 3. 只排序已挂载实体：离屏图元已从场景树摘除，重新进入视野时会再次置脏。
   */
  private syncContentOrder(): void {
    if (!this.contentLayer) return;

    const entityStore = this.engine.entityStore;
    const chainCache = new Map<string, NodeEntity[]>();
    const getNode = (id: string) => entityStore.getNode(id)?.entity;
    const compareNodes = (left: NodeEntity, right: NodeEntity) =>
      compareHierarchicalNodes(left, right, getNode, chainCache);

    const ordered: ContentLayerOrderEntry<Group>[] = [];

    for (const nodeId of this.shownNodeIds) {
      const cache = this.nodeCaches.get(nodeId);
      const node = getNode(nodeId);
      if (!cache || !node) continue;
      ordered.push({
        kind: 'node',
        node,
        group: cache.outerGroup,
        stableOrder: this.getStableOrder(nodeId)
      });
    }

    for (const connectorId of this.shownConnectorIds) {
      const cache = this.connectorCaches.get(connectorId);
      const connector = entityStore.getConnector(connectorId)?.entity;
      if (!cache || !connector) continue;
      ordered.push({
        kind: 'connector',
        connector,
        group: cache.group,
        anchorNode: resolveConnectorLayerAnchor(connector, getNode, compareNodes),
        stableOrder: this.getStableOrder(connectorId)
      });
    }

    ordered.sort((left, right) =>
      compareContentLayerEntries(left, right, compareNodes)
    );

    // 快速脏检查：仅当顺序与 contentLayer.children 当前顺序不一致时才重新挂载
    const currentChildren = this.contentLayer.children;
    let needReorder = currentChildren.length !== ordered.length;
    for (let i = 0; !needReorder && i < ordered.length; i++) {
      needReorder = currentChildren[i] !== ordered[i].group;
    }

    if (needReorder) {
      for (let i = 0; i < ordered.length; i++) {
        this.contentLayer.add(ordered[i].group);
      }
    }

    this.contentOrderDirty = false;
  }

  /**
   * 节点空间碰撞拾取：在命中候选中按层级规则取最上层者 (忽略不可见节点)
   * 空间索引的返回顺序与层叠无关，必须显式比较层级，否则重叠时会拾取到被遮挡的节点
   */
  hitTest(point: Point): NodeEntity | undefined {
    const entityStore = this.engine.entityStore;
    const chainCache = new Map<string, NodeEntity[]>();
    const getNode = (id: string) => entityStore.getNode(id)?.entity;

    let top: NodeEntity | undefined;
    const candidateIds = this.engine.spatialIndex.hitTest(point);
    for (let i = 0; i < candidateIds.length; i++) {
      const node = getNode(candidateIds[i]);
      if (!node || node.style?.opacity === 0) continue;
      if (!top) {
        top = node;
        continue;
      }
      const order = compareHierarchicalNodes(node, top, getNode, chainCache);
      if (order > 0 || (order === 0 && this.getStableOrder(node.id) > this.getStableOrder(top.id))) {
        top = node;
      }
    }

    return top;
  }

  /**
   * 连线几何碰撞拾取 (当点击在连线附近 6px 范围内判定命中)
   * 先经连线空间索引粗筛，再对候选做折线距离精判
   */
  hitTestConnector(point: Point, tolerance = 6): ConnectorEntity | undefined {
    const worldTolerance = tolerance / this.engine.session.viewport.zoom;
    const candidateIds = this.engine.connectorSpatialIndex.search({
      left: point.x - worldTolerance,
      top: point.y - worldTolerance,
      right: point.x + worldTolerance,
      bottom: point.y + worldTolerance,
      width: worldTolerance * 2,
      height: worldTolerance * 2
    });

    for (let i = candidateIds.length - 1; i >= 0; i--) {
      const runtimeConnector = this.engine.entityStore.getConnector(candidateIds[i]);
      if (!runtimeConnector || runtimeConnector.entity.style?.strokeWidth === 0) continue;

      // 按引擎路由精判：离屏或尚未绘制的连线同样可拾取
      const route = this.engine.getConnectorRoute(candidateIds[i]);
      if (!route) continue;

      if (distanceToPolyline(point, route.points) <= worldTolerance) {
        return runtimeConnector.entity;
      }
    }

    return undefined;
  }

  /**
   * 统一全景实体碰撞拾取：先命中上层节点，若空白则检测连线
   */
  hitTestEntity(point: Point): HitEntityResult | undefined {
    const node = this.hitTest(point);
    if (node) {
      return { type: 'node', entity: node };
    }

    const connector = this.hitTestConnector(point);
    if (connector) {
      return { type: 'connector', entity: connector };
    }

    return undefined;
  }

  /**
   * 更新视口：写入引擎会话状态，变换矩阵与重绘由会话订阅统一驱动
   */
  setViewport(viewport: Partial<ViewportState>): void {
    if (this.isDestroyed) return;
    this.engine.session.setViewport(viewport);
  }

  /**
   * 获取当前视口状态副本
   */
  getViewport(): ViewportState {
    return { ...this.engine.session.viewport };
  }

  /**
   * 获取当前自适应 LOD 等级
   */
  getLodLevel(): SkyNoteLodLevel {
    return this.currentLodLevel;
  }

  /**
   * 获取底层背景渲染层 Group (用于挂载点阵背景、坐标网格、底色填充等底层装饰)
   */
  getBackgroundLayer(): Group | null {
    return this.backgroundLayer;
  }

  /**
   * 获取统一内容层 Group (所有卡片节点与连线拓扑排序所在层)
   */
  getContentLayer(): Group | null {
    return this.contentLayer;
  }

  /**
   * 坐标转换便捷代理
   */
  screenToWorld(screenPoint: Point): Point {
    return screenToWorld(screenPoint, this.engine.session.viewport);
  }

  worldToScreen(worldPoint: Point): Point {
    return worldToScreen(worldPoint, this.engine.session.viewport);
  }

  /**
   * 默认底座滚轮缩放与双指平移闭环处理
   */
  private handleDefaultWheel(e: CanvasWheelEvent): void {
    if (e.deltaZoom !== 0) {
      // 以滚轮所在世界坐标为中心进行缩放
      const viewport = this.engine.session.viewport;
      const oldZoom = viewport.zoom;
      const newZoom = Math.max(0.1, Math.min(10, oldZoom * (1 + e.deltaZoom)));

      const newX = viewport.x + e.centerPoint.x * (oldZoom - newZoom);
      const newY = viewport.y + e.centerPoint.y * (oldZoom - newZoom);

      this.setViewport({ x: newX, y: newY, zoom: newZoom });
    } else if (e.deltaPan.x !== 0 || e.deltaPan.y !== 0) {
      // 触控板/滚轮平移
      const viewport = this.engine.session.viewport;
      this.setViewport({
        x: viewport.x + e.deltaPan.x,
        y: viewport.y + e.deltaPan.y
      });
    }
  }

  /**
   * 销毁渲染器实例，成对清理所有引用与监听
   */
  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    if (this.scheduledRafId !== null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.scheduledRafId);
      this.scheduledRafId = null;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.abortController.abort();

    this.unsubscribeDoc?.();
    this.unsubscribeDoc = null;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    if (this.lodRecoveryTimer !== null) {
      clearTimeout(this.lodRecoveryTimer);
      this.lodRecoveryTimer = null;
    }

    this.unregisterDefaultWheel?.();
    this.unregisterDefaultWheel = null;
    this.engine.inputScopes.popScope(EPHEMERAL_ESCAPE_SCOPE_ID);

    this.hostBridge?.destroy();
    this.hostBridge = null;

    this.ephemeralChannel?.destroy();
    this.ephemeralChannel = null;

    for (const cache of this.nodeCaches.values()) {
      this.nodeRenderers.get(cache.node.nodeType)?.destroy?.(cache.shapes, cache.node);
      cache.outerGroup.remove();
    }
    this.nodeCaches.clear();

    for (const cache of this.connectorCaches.values()) {
      this.connectorRenderers.get(cache.connector.connectorType)?.destroy?.([cache.lineShape], cache.connector);
      cache.group.remove();
    }
    this.connectorCaches.clear();
    this.nodeRenderers.clear();
    this.connectorRenderers.clear();

    if (this.backgroundLayer) {
      this.backgroundLayer.clear();
      this.backgroundLayer = null;
    }

    if (this.contentLayer) {
      this.contentLayer.clear();
      this.contentLayer = null;
    }

    if (this.leaferApp) {
      this.leaferApp.destroy();
      this.leaferApp = null;
    }
    this.container = null;
  }
}

/**
 * 辅助工厂函数
 */
export function createLeaferRenderer(
  engine: SkyNoteEngine,
  options?: LeaferRendererOptions
): LeaferRenderer {
  return new LeaferRenderer(engine, options);
}
