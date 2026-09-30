/**
 * @file leafer-renderer.ts
 * @description Leafer 渲染器：场景树、宿主桥与帧循环的编排 (LeaferRenderer)
 *
 * 设计考量 (Why):
 * 1. 构造即挂载：容器在构造时给定，场景对象全部非空；销毁后实例作废，不支持重复挂载。
 * 2. 帧开销与画布规模无关：只处理视锥内实体与本帧删除的实体，离屏图元摘除并按 LRU 淘汰；
 *    同一帧内的多次提交、指针移动与滚轮合并为一次渲染。
 * 3. 单一事实源：视口、选区、主题与视口尺寸都在引擎会话中，渲染器只上报尺寸、不持有副本；
 *    视口交互 (滚轮、平移、缩放) 由视口导航插件负责，渲染器不处理。
 * 4. 像素对齐：开启 Leafer 画布的 pixelSnap，绘制时按屏幕像素对齐，1px 线条在任意缩放下都锐利。
 */

import { Leafer, Group } from 'leafer';
import type { CanvasRenderer, SkyNoteEngine } from '@skynote/core';
import { computeViewportWorldBounds, expandBounds } from '@skynote/core';
import type { LeaferRendererOptions, LeaferRenderContext } from './types';
import { LeaferOverlay } from './overlay/leafer-overlay';
import { DOMHostBridge } from './bridge/host-bridge';
import { LeaferNodeRendererRegistry } from './registry/leafer-node-renderer-registry';
import { FrameCommitScheduler } from './scheduler/frame-commit-scheduler';
import {
  AdaptiveLodController,
  DEFAULT_ADAPTIVE_LOD_OPTIONS,
  type SkyNoteAdaptiveLodState,
  type SkyNoteLodLevel
} from './scheduler/adaptive-lod';
import { NodeLayer } from './layers/node-layer';
import { ConnectorLayer } from './layers/connector-layer';
import { ContentOrderSync } from './layers/content-order-sync';

const OVERLAY_ESCAPE_SCOPE_ID = 'renderer:overlay-escape';
const DEFAULT_OFFSCREEN_CACHE_LIMIT = 2000;
/** 视锥缓冲边距：覆盖描边、箭头与路由外扩，避免边缘实体进出视野时闪烁 */
const FRUSTUM_PADDING = 100;

export class LeaferRenderer implements CanvasRenderer {
  readonly nodeRenderers = new LeaferNodeRendererRegistry();
  /** 底层装饰 (点阵、网格) */
  readonly backgroundLayer = new Group();
  /** 节点与连线按层级排列所在的内容层 */
  readonly contentLayer = new Group();

  private readonly leafer: Leafer;
  /** 承载视口变换的场景根 */
  private readonly scene = new Group();
  private readonly overlay: LeaferOverlay;
  private readonly bridge: DOMHostBridge;
  private readonly nodeLayer: NodeLayer;
  private readonly connectorLayer: ConnectorLayer;
  private readonly contentOrder: ContentOrderSync;
  private readonly frameScheduler: FrameCommitScheduler;
  private readonly lodController = new AdaptiveLodController();
  private readonly resizeObserver: ResizeObserver;
  /** 成对释放的订阅与监听 */
  private readonly disposers: Array<() => void> = [];

  private currentLod: SkyNoteLodLevel = 'full';
  private isInteracting = false;
  /** 文档层级发生变化 (或首帧)：下一帧需全量重排；平时只为新挂载的实体定位插入 */
  private layerOrderInvalidated = true;
  /** 自上一帧以来被删除、待销毁图元的实体 */
  private readonly pendingRemovedNodeIds = new Set<string>();
  private readonly pendingRemovedConnectorIds = new Set<string>();
  private scheduledFrame: number | null = null;
  private isFlushingInput = false;
  /** LOD 回升存在迟滞：等待期满后需主动补一帧，否则画面会停留在降级档位直到下一次交互 */
  private lodRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private isDestroyed = false;

  constructor(
    readonly engine: SkyNoteEngine,
    container: HTMLElement,
    options?: LeaferRendererOptions
  ) {
    const { session } = engine;
    const offscreenCacheLimit = Math.max(0, options?.offscreenCacheLimit ?? DEFAULT_OFFSCREEN_CACHE_LIMIT);
    this.frameScheduler = new FrameCommitScheduler({ enabled: options?.enableFrameScheduler !== false });

    // 场景树分层：背景层 → 内容层 → 覆盖层
    this.leafer = new Leafer({
      view: container,
      width: container.clientWidth,
      height: container.clientHeight,
      pixelRatio: options?.pixelRatio ?? window.devicePixelRatio,
      pixelSnap: true,
      fill: session.theme.background
    });
    const overlayLayer = new Group();
    this.scene.add([this.backgroundLayer, this.contentLayer, overlayLayer]);
    this.leafer.add(this.scene);
    this.applyViewportTransform();
    session.setViewportSize({ width: container.clientWidth, height: container.clientHeight });

    this.overlay = new LeaferOverlay(overlayLayer);
    this.nodeLayer = new NodeLayer({
      contentLayer: this.contentLayer,
      engine,
      renderers: this.nodeRenderers,
      offscreenCacheLimit
    });
    this.connectorLayer = new ConnectorLayer({ engine, offscreenCacheLimit });
    this.contentOrder = new ContentOrderSync(this.nodeLayer, this.connectorLayer, engine.entityStore);
    this.bridge = new DOMHostBridge({
      container,
      engine,
      overlay: this.overlay,
      requestFrame: () => this.requestRender(),
      onInteractionChange: (isInteracting) => {
        this.isInteracting = isInteracting;
      }
    });

    this.disposers.push(
      // 宿主能力 (光标、指针捕获、覆盖层) 挂到引擎上，交互插件经插件上下文使用
      engine.attachHost(this.bridge),
      // 文档增量变更：登记待销毁实体与层级脏标记，合并到下一帧
      engine.documentStore.subscribe((_view, _record, changes) => {
        for (const id of changes.nodes.removed) this.pendingRemovedNodeIds.add(id);
        for (const id of changes.connectors.removed) this.pendingRemovedConnectorIds.add(id);
        if (changes.orderChanged) this.layerOrderInvalidated = true;
        this.requestRender();
      }),
      // 视口变换立即生效 (平移缩放零延迟跟手)，视锥、选中态与主题重绘合并到下一帧
      session.subscribe((change) => {
        if (change.viewportChanged) this.applyViewportTransform();
        if (change.themeChanged) this.leafer.fill = session.theme.background;
        this.requestRender();
      })
    );

    // 失焦与 Esc 兜底清空瞬态图元：Esc 经焦点栈以最低优先级消费，上层交互 (如取消拖拽) 先行处理
    const clearTransient = () => this.overlay.clearTransient();
    window.addEventListener('blur', clearTransient);
    engine.inputScopes.pushScope({
      id: OVERLAY_ESCAPE_SCOPE_ID,
      priority: -100,
      onKeyDown: (e) => {
        if (e.key === 'Escape') clearTransient();
      }
    });
    this.disposers.push(
      () => window.removeEventListener('blur', clearTransient),
      () => engine.inputScopes.popScope(OVERLAY_ESCAPE_SCOPE_ID)
    );

    this.resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width <= 0 || height <= 0) return;
      this.leafer.resize({ width, height });
      session.setViewportSize({ width, height });
    });
    this.resizeObserver.observe(container);

    this.renderFrame();
  }

  /** 当前自适应 LOD 档位 */
  get lodLevel(): SkyNoteLodLevel {
    return this.currentLod;
  }

  /** 申请在下一动画帧渲染：同一帧内的多次提交 (拖拽、滚轮连发) 只渲染一次 */
  requestRender(): void {
    // 帧开始冲刷输入时引发的提交会在本帧随后渲染，无需再申请下一帧
    if (this.isDestroyed || this.scheduledFrame !== null || this.isFlushingInput) return;
    this.scheduledFrame = requestAnimationFrame(() => {
      this.scheduledFrame = null;
      this.renderFrame();
    });
  }

  /**
   * 立即渲染一帧：冲刷合并的输入 → 销毁已删除实体 → 视锥检索 → LOD 与分帧 → 图层增量同步 → 层级同步
   * 开销只与视锥内实体数和本帧删除数相关，与画布总规模无关
   */
  renderFrame(): void {
    if (this.isDestroyed) return;
    if (this.scheduledFrame !== null) {
      cancelAnimationFrame(this.scheduledFrame);
      this.scheduledFrame = null;
    }

    // 先冲刷本帧合并的指针移动与滚轮，交互产生的提交与视口变化在同一帧内呈现
    this.isFlushingInput = true;
    try {
      this.bridge.flushPendingInput();
    } finally {
      this.isFlushingInput = false;
    }

    const frameStart = performance.now();
    const { engine, nodeLayer, connectorLayer } = this;
    const { entityStore, session } = engine;

    for (const id of this.pendingRemovedNodeIds) nodeLayer.destroy(id);
    this.pendingRemovedNodeIds.clear();
    for (const id of this.pendingRemovedConnectorIds) connectorLayer.destroy(id);
    this.pendingRemovedConnectorIds.clear();

    const frustum = expandBounds(computeViewportWorldBounds(session.viewport, session.viewportSize), FRUSTUM_PADDING);
    const visibleNodeIds = engine.spatialIndex.search(frustum);
    const connectorCandidateIds = engine.connectorSpatialIndex.search(frustum);

    // 自适应 LOD：reduced 起节点降级为占位块，minimal 不再绘制连线
    const lod = this.lodController.evaluate({
      now: frameStart,
      zoom: session.viewport.zoom,
      documentNodes: entityStore.nodeCount,
      documentConnectors: entityStore.connectorCount,
      visibleNodes: visibleNodeIds.length,
      visibleConnectors: connectorCandidateIds.length,
      nodeObjects: nodeLayer.cacheCount,
      connectorObjects: connectorLayer.cacheCount,
      isInteracting: this.isInteracting
    });
    this.currentLod = lod.level;
    this.scheduleLodRecovery(lod);
    const visibleConnectorIds = lod.level === 'minimal' ? [] : connectorCandidateIds;

    // 分帧提交：实体超载时分帧缓冲，选中实体优先
    const frame = this.frameScheduler.reconcileAndCommit({
      nodeIds: visibleNodeIds,
      nodePriorityIds: session.selectedNodeIds,
      connectorIds: visibleConnectorIds,
      connectorPriorityIds: session.selectedConnectorIds
    });

    // 连线挂在公共祖先容器中 (ADR-114)，所需容器即使不在视锥内也要先由节点图层挂载
    if (this.layerOrderInvalidated) connectorLayer.invalidatePlacements();
    const connectorContainerIds = new Set<string>();
    for (const connectorId of visibleConnectorIds) {
      if (!frame.committedConnectorIds.has(connectorId)) continue;
      const containerId = connectorLayer.getPlacement(connectorId)?.containerId;
      if (containerId !== undefined) connectorContainerIds.add(containerId);
    }
    const context: LeaferRenderContext = {
      viewport: session.viewport,
      isInteracting: this.isInteracting,
      theme: session.theme
    };
    const nodeSync = nodeLayer.sync(
      visibleNodeIds,
      (id) => frame.committedNodeIds.has(id),
      context,
      lod.level === 'full' ? 'full' : 'placeholder',
      connectorContainerIds
    );
    const connectorSync = connectorLayer.sync(
      visibleConnectorIds,
      (id) => frame.committedConnectorIds.has(id),
      session.theme,
      (containerId) => (containerId === undefined ? this.contentLayer : nodeLayer.getChildrenContainer(containerId)!)
    );
    // 以实测挂载成本校准分帧调度器：慢设备自动缩小每帧提交量，快设备减少不必要的分帧
    this.frameScheduler.recordNodePhase(nodeSync.enterMs, nodeSync.entered);
    this.frameScheduler.recordConnectorPhase(connectorSync.enterMs, connectorSync.entered);

    // 层级同步：文档层级变化时全量排序并最少移动，否则剔除离场实体、插入新挂载的实体
    const mountChanged = nodeSync.entered + nodeSync.left + connectorSync.entered + connectorSync.left > 0;
    if (this.layerOrderInvalidated || mountChanged) {
      this.contentOrder.sync(this.layerOrderInvalidated);
      this.layerOrderInvalidated = false;
    }

    this.lodController.recordFrame(performance.now() - frameStart, frameStart);
    // 分帧队列未清空时继续调度
    if (frame.state.active) this.requestRender();
  }

  /** 销毁渲染器，成对释放全部订阅、监听与图元 */
  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    if (this.scheduledFrame !== null) cancelAnimationFrame(this.scheduledFrame);
    if (this.lodRecoveryTimer !== null) clearTimeout(this.lodRecoveryTimer);
    this.resizeObserver.disconnect();
    for (const dispose of this.disposers) dispose();
    this.bridge.destroy();
    this.overlay.destroy();
    this.nodeLayer.destroyAll();
    this.connectorLayer.destroyAll();
    this.nodeRenderers.clear();
    this.leafer.destroy();
  }

  private applyViewportTransform(): void {
    const { x, y, zoom } = this.engine.session.viewport;
    this.scene.set({ x, y, scaleX: zoom, scaleY: zoom });
  }

  private scheduleLodRecovery(lod: SkyNoteAdaptiveLodState): void {
    if (lod.level === lod.desiredLevel || this.lodRecoveryTimer !== null) return;
    this.lodRecoveryTimer = setTimeout(() => {
      this.lodRecoveryTimer = null;
      this.requestRender();
    }, DEFAULT_ADAPTIVE_LOD_OPTIONS.recoveryDelayMs + 50);
  }
}
