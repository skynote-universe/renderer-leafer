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

import { Leafer, Group } from 'leafer-ui';
import type { CanvasRenderer, SkyNoteEngine, CanvasExportRequest, CanvasExportResult, RectBounds } from '@skynote/core';
import {
  applyMatrix,
  computeViewportWorldBounds,
  doBoundsIntersect,
  expandBounds,
  invertMatrix,
  type Point
} from '@skynote/core';
import type { LeaferRendererOptions, LeaferRenderContext } from './types';
import { LeaferOverlay } from './overlay/leafer-overlay';
import { PrimitiveMapper } from './primitives/primitive-mapper';
import { LeaferFontMeasurer } from './text/leafer-font-measurer';
import { DOMHostBridge } from './bridge/host-bridge';
import { LeaferNodeRendererRegistry } from './registry/leafer-node-renderer-registry';
import { FrameCommitScheduler } from './scheduler/frame-commit-scheduler';
import { AdaptiveLodController } from './scheduler/adaptive-lod';
import type { SkyNoteLodLevel } from './scheduler/adaptive-lod';
import { NodeLayer } from './layers/node-layer';
import { ConnectorLayer } from './layers/connector-layer';
import { ContentOrderSync } from './layers/content-order-sync';
import { ImageNodeRenderer } from './node/image-node-renderer';
import { VideoPosterRenderer } from './node/video-poster-renderer';
import { WebLinkCoverRenderer } from './node/web-link-cover-renderer';
import { ContentPreviews, createDefaultPreviewRegistry } from './overlay/content-previews';
import type { PreviewRendererRegistry } from './overlay/preview-registry';
import { readWebLink } from './overlay/web-link-preview';
import { getVideoAsset, getVideoFields, videoCardPlayRadius } from './node/video-fields';
import { exportScene, LEAFER_EXPORT_FORMATS } from './export/scene-export';

const OVERLAY_ESCAPE_SCOPE_ID = 'renderer:overlay-escape';
const CONTENT_PREVIEW_SCOPE_ID = 'renderer:content-preview';
const DEFAULT_OFFSCREEN_CACHE_LIMIT = 2000;
/** 视锥缓冲边距：覆盖描边、箭头与路由外扩，避免边缘实体进出视野时闪烁 */
const FRUSTUM_PADDING = 100;

export class LeaferRenderer implements CanvasRenderer {
  readonly nodeRenderers = new LeaferNodeRendererRegistry();
  readonly previewRenderers: PreviewRendererRegistry;
  /** 底层装饰 (点阵、网格) */
  readonly backgroundLayer = new Group();
  /** 节点与连线按层级排列所在的内容层 */
  readonly contentLayer = new Group();
  /** 覆盖层 (选中框、控制柄、框选与参考线)；存在可见 DOM 预览时按需提升至顶层透明 Canvas */
  readonly overlayLayer = new Group();
  readonly images: ImageNodeRenderer;
  readonly exportFormats = LEAFER_EXPORT_FORMATS;

  private readonly leafer: Leafer;
  private overlayLeafer?: Leafer;
  private overlayHost?: HTMLDivElement;
  private readonly previousContainerPosition?: string;
  private readonly previousContainerIsolation?: string;
  /** 承载视口变换的场景根 */
  private readonly scene = new Group();
  /** 顶层覆盖层场景根（随 overlayLeafer 按需创建与销毁，避免复用已销毁的 Group） */
  private overlayScene?: Group;
  private readonly overlay: LeaferOverlay;
  private readonly assetRenderers: readonly ImageNodeRenderer[];
  private contentPreviews?: ContentPreviews;
  private readonly previewIds = new Set<string>();
  private viewportTransformPending = false;
  private readonly bridge: DOMHostBridge;
  private readonly nodeLayer: NodeLayer;
  private readonly connectorLayer: ConnectorLayer;
  private readonly contentOrder: ContentOrderSync;
  private readonly frameScheduler: FrameCommitScheduler;
  private readonly lodController: AdaptiveLodController | undefined;
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
  private lodRecoveryAt: number | undefined;
  private isDestroyed = false;

  constructor(
    readonly engine: SkyNoteEngine,
    private readonly container: HTMLElement,
    private readonly options?: LeaferRendererOptions
  ) {
    const { session } = engine;
    const offscreenCacheLimit = Math.max(0, options?.offscreenCacheLimit ?? DEFAULT_OFFSCREEN_CACHE_LIMIT);
    this.frameScheduler = new FrameCommitScheduler({ enabled: options?.enableFrameScheduler !== false });
    this.lodController = options?.lod === false ? undefined : new AdaptiveLodController(options?.lod);

    this.previewRenderers = createDefaultPreviewRegistry(options?.previews);
    // 平时单 Canvas 承载全部三层（0 额外显存）；存在可见 DOM 预览时再按需把 overlayLayer 提升至顶层透明 Canvas
    const pixelRatio = options?.pixelRatio ?? window.devicePixelRatio;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const doc = container.ownerDocument;
    const computedStyle = doc.defaultView?.getComputedStyle(container);
    if (computedStyle?.position === 'static') {
      this.previousContainerPosition = container.style.position;
      container.style.position = 'relative';
    }
    // 建立独立层叠上下文，防止内部预览层 (zIndex: 1) 与按需顶层覆盖层 (zIndex: 2) 越界遮挡宿主工具栏
    if (computedStyle?.isolation !== 'isolate') {
      this.previousContainerIsolation = container.style.isolation;
      container.style.isolation = 'isolate';
    }
    this.leafer = new Leafer({
      view: container,
      width,
      height,
      pixelRatio,
      pixelSnap: true,
      fill: session.theme.background
    });
    this.scene.add([this.backgroundLayer, this.contentLayer, this.overlayLayer]);
    this.leafer.add(this.scene);
    this.applyViewportTransform();
    session.setViewportSize({ width, height });

    // 绘制文字必须用 Leafer 自己的测量 (与画出的字形一致)，不借用引擎上可能被替换的测量器
    const mapper = new PrimitiveMapper(new LeaferFontMeasurer());
    this.images = new ImageNodeRenderer(
      (assetId) => {
        const asset = engine.documentStore.getView().assets?.[assetId];
        return asset ? { src: asset.src } : undefined;
      },
      engine.assets,
      options?.imageFailure,
      (id) => engine.entityStore.getNode(id)?.entity
    );
    const videoPosters = new VideoPosterRenderer((id) => engine.documentStore.getView().assets?.[id], engine.assets, {
      getNode: (id) => engine.entityStore.getNode(id)?.entity
    });
    this.assetRenderers = [
      this.images,
      videoPosters,
      new WebLinkCoverRenderer(engine, mapper, options?.previews?.enableWebLinkPreviews)
    ];
    for (const renderer of this.assetRenderers) this.nodeRenderers.register(renderer);
    this.indexContentPreviews();
    this.overlay = new LeaferOverlay(this.overlayLayer, mapper, () => session.theme);
    this.nodeLayer = new NodeLayer({
      contentLayer: this.contentLayer,
      engine,
      renderers: this.nodeRenderers,
      mapper,
      offscreenCacheLimit
    });
    this.connectorLayer = new ConnectorLayer({ engine, mapper, offscreenCacheLimit });
    this.contentOrder = new ContentOrderSync(this.nodeLayer, this.connectorLayer, engine.entityStore);
    this.bridge = new DOMHostBridge({
      container,
      engine,
      overlay: this.overlay,
      requestFrame: () => this.requestRender(),
      flushRender: () => this.renderFrame(),
      resolveTapTarget: (point, previewId) => {
        if (previewId) return this.contentPreviews?.canFocus(previewId) ? previewId : undefined;
        return this.mediaCardAt(point);
      },
      onTap: (id, previewId) => {
        if (previewId) this.contentPreviews?.focus(id);
        else {
          const node = engine.entityStore.getNode(id)?.entity;
          if (node) engine.events.emit('node:activate', { nodeId: id, nodeType: node.nodeType, trigger: 'pointer' });
        }
      },
      onInteractionChange: (isInteracting) => {
        this.isInteracting = isInteracting;
      }
    });

    this.disposers.push(
      // 宿主能力 (光标、指针捕获、覆盖层) 挂到引擎上，交互插件经插件上下文使用
      engine.attachHost(this.bridge),
      this.previewRenderers.onChange(() => {
        this.indexContentPreviews();
        this.requestRender();
      }),
      // 文档增量变更：登记待销毁实体与层级脏标记，合并到下一帧
      engine.documentStore.subscribe((_view, _record, changes) => {
        this.nodeLayer.recordChanges(changes);
        if (changes.contentReplaced) {
          this.contentPreviews?.clear();
          this.indexContentPreviews();
          this.nodeLayer.destroyAll();
        } else {
          for (const id of changes.nodes.removed) this.previewIds.delete(id);
          for (const id of changes.nodes.added) this.indexPreview(id);
          for (const id of changes.nodes.data) this.indexPreview(id);
          for (const renderer of this.assetRenderers) {
            renderer.reconcile(changes.nodes.removed);
            renderer.reconcile(changes.nodes.data);
            if (changes.assets.size) renderer.reconcileAssets(changes.assets);
          }
          this.contentPreviews?.reconcilePlayback(changes);
        }
        this.nodeLayer.invalidateAssets(changes.assets);
        for (const id of changes.nodes.removed) this.pendingRemovedNodeIds.add(id);
        for (const id of changes.connectors.removed) this.pendingRemovedConnectorIds.add(id);
        if (changes.orderChanged) this.layerOrderInvalidated = true;
        this.requestRender();
      }),
      // 节点类型晚于文档注册或被卸载时，使对应类型的节点视图失效并申请重绘
      engine.nodeTypes.onChange((type) => {
        this.nodeLayer.invalidateNodeType(type);
        this.requestRender();
      }),
      // 布局能力晚注册/卸载可能只改变折叠可见性，并不产生几何补丁。
      engine.layouts.onChange(() => this.requestRender()),
      // 视口变换立即生效 (平移缩放零延迟跟手)，视锥、选中态与主题重绘合并到下一帧；进入维护冻结时清除瞬态预览
      session.subscribe((change) => {
        if (change.viewportChanged) {
          if (this.contentPreviews?.hasVisiblePreview) this.viewportTransformPending = true;
          else this.applyViewportTransform();
        }
        if (change.themeChanged) this.leafer.fill = session.theme.background;
        if (change.maintenanceChanged && session.inMaintenance) {
          this.overlay.clearTransient();
          this.contentPreviews?.clear();
        }
        this.requestRender();
      })
    );

    // 失焦与 Esc 兜底清空瞬态图元：Esc 经焦点栈以最低优先级消费，上层交互 (如取消拖拽) 先行处理
    const clearTransient = () => this.overlay.clearTransient();
    window.addEventListener('blur', clearTransient);
    engine.inputScopes.pushScope({
      id: CONTENT_PREVIEW_SCOPE_ID,
      priority: 90,
      onKeyDown: (event) => {
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !this.contentPreviews) return;
        if (event.key === 'Escape' && this.contentPreviews.exitFocus()) {
          event.preventDefault();
          return true;
        }
        if (event.key !== 'Enter' || this.isInteracting || session.textEditing || session.selectedNodeIds.size !== 1)
          return;
        const id = session.selectedNodeIds.values().next().value;
        if (id !== undefined && this.contentPreviews.focus(id)) {
          event.preventDefault();
          return true;
        }
      }
    });
    engine.inputScopes.pushScope({
      id: OVERLAY_ESCAPE_SCOPE_ID,
      priority: -100,
      onKeyDown: (e) => {
        if (e.key === 'Escape') clearTransient();
      }
    });
    this.disposers.push(
      () => window.removeEventListener('blur', clearTransient),
      () => engine.inputScopes.popScope(CONTENT_PREVIEW_SCOPE_ID),
      () => engine.inputScopes.popScope(OVERLAY_ESCAPE_SCOPE_ID)
    );

    this.resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width <= 0 || height <= 0) return;
      this.leafer.resize({ width, height });
      this.overlayLeafer?.resize({ width, height });
      session.setViewportSize({ width, height });
    });
    this.resizeObserver.observe(container);

    // 未固定像素比时跟随设备像素比变化 (浏览器缩放、窗口移到缩放比例不同的屏幕)，否则画面发虚或只绘出一部分：
    // Leafer 自带的跟随在显式配置像素比时关闭，且只在 window resize 时检查 (换屏不一定触发)，这里用 matchMedia 监听当前像素比失配
    if (options?.pixelRatio === undefined) {
      let query: MediaQueryList;
      const onPixelRatioChange = (): void => {
        const size = {
          width: container.clientWidth,
          height: container.clientHeight,
          pixelRatio: window.devicePixelRatio
        };
        this.leafer.resize(size);
        this.overlayLeafer?.resize(size);
        watchPixelRatio();
      };
      const watchPixelRatio = (): void => {
        query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        query.addEventListener('change', onPixelRatioChange, { once: true });
      };
      watchPixelRatio();
      this.disposers.push(() => query.removeEventListener('change', onPixelRatioChange));
    }

    this.renderFrame();
  }

  /** 当前自适应 LOD 档位 */
  get lodLevel(): SkyNoteLodLevel {
    return this.currentLod;
  }

  /** 隔离导出不复用交互场景，格式由当前渲染器声明并处理。 */
  async export(request: CanvasExportRequest): Promise<CanvasExportResult> {
    if (this.isDestroyed) throw new Error('渲染器已销毁');
    return exportScene(this.engine, this.nodeRenderers, request, this.assetRenderers);
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
    if (this.viewportTransformPending) this.applyViewportTransform();

    if (this.pendingRemovedNodeIds.size) nodeLayer.destroyMany(this.pendingRemovedNodeIds);
    this.pendingRemovedNodeIds.clear();
    if (this.pendingRemovedConnectorIds.size) connectorLayer.destroyMany(this.pendingRemovedConnectorIds);
    this.pendingRemovedConnectorIds.clear();

    const viewport = computeViewportWorldBounds(session.viewport, session.viewportSize);
    const frustum = expandBounds(viewport, FRUSTUM_PADDING);
    const visibleNodeIds = engine.spatialIndex.search(frustum);
    const connectorCandidateIds = engine.connectorSpatialIndex.search(frustum);

    // 自适应 LOD：reduced 起节点降级为占位块，minimal 不再绘制连线
    const gateLimit = this.lodController?.viewportNodesAbove;
    const interactionLimit = this.lodController?.viewportInteractionNodesAbove;
    const viewportGatePassed =
      gateLimit === undefined || this.hasViewportNodesAbove(visibleNodeIds, viewport, gateLimit);
    const lod = this.lodController?.evaluate({
      now: frameStart,
      zoom: session.viewport.zoom,
      documentNodes: entityStore.nodeCount,
      documentConnectors: entityStore.connectorCount,
      visibleNodes: visibleNodeIds.length,
      visibleConnectors: connectorCandidateIds.length,
      nodeObjects: nodeLayer.cacheCount,
      connectorObjects: connectorLayer.cacheCount,
      isInteracting: this.isInteracting,
      viewportGatePassed,
      viewportInteractionPressure:
        viewportGatePassed &&
        this.isInteracting &&
        interactionLimit !== undefined &&
        (interactionLimit === gateLimit || this.hasViewportNodesAbove(visibleNodeIds, viewport, interactionLimit))
    });
    this.currentLod = lod?.level ?? 'full';
    this.scheduleLodRecovery(this.lodController?.recoveryAt);
    const visibleConnectorIds = this.currentLod === 'minimal' ? [] : connectorCandidateIds;

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
      theme: session.theme,
      textEditing: session.textEditing
    };
    const nodeSync = nodeLayer.sync(
      visibleNodeIds,
      (id) => frame.committedNodeIds.has(id),
      context,
      this.currentLod === 'full' ? 'full' : 'placeholder',
      connectorContainerIds
    );
    const connectorSync = connectorLayer.sync(
      visibleConnectorIds,
      (id) => frame.committedConnectorIds.has(id),
      session.theme,
      session.textEditing,
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

    if (this.previewIds.size || this.contentPreviews?.hasVisiblePreview) {
      const previewIds = visibleNodeIds.filter((id) => this.previewIds.has(id) && frame.committedNodeIds.has(id));
      if (previewIds.length || this.contentPreviews?.hasVisiblePreview) {
        // 提交这帧的 Leafer 局部绘制后再更新 DOM，避免两套调度各自采用不同版本的坐标。
        if (this.leafer.renderer.changed) this.leafer.renderer.render();
        this.contentPreviews ??= new ContentPreviews(engine, this.container, this.previewRenderers, () =>
          this.requestRender()
        );
      }
      this.contentPreviews?.updateViewport();
      this.contentPreviews?.sync(previewIds, this.isInteracting);
    } else this.contentPreviews?.clear();

    if (this.contentPreviews?.hasVisiblePreview) this.ensureOverlayElevated();
    if (this.overlayLeafer?.renderer.changed) this.overlayLeafer.renderer.render();

    this.lodController?.recordFrame(performance.now() - frameStart, frameStart);
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
    this.contentPreviews?.destroy();
    this.overlay.destroy();
    this.nodeLayer.destroyAll();
    for (const renderer of this.assetRenderers) renderer.dispose();
    this.connectorLayer.destroyAll();
    this.nodeRenderers.clear();
    this.previewRenderers.clear();
    if (this.overlayLeafer) {
      this.overlayLeafer.destroy();
      this.overlayLeafer = undefined;
      this.overlayScene = undefined;
    }
    if (this.overlayHost) {
      if (this.overlayHost.parentNode) this.overlayHost.parentNode.removeChild(this.overlayHost);
      else this.overlayHost.remove?.();
      this.overlayHost = undefined;
    }
    this.leafer.destroy();
    if (this.previousContainerPosition !== undefined && this.container.style.position === 'relative')
      this.container.style.position = this.previousContainerPosition;
    if (this.previousContainerIsolation !== undefined && this.container.style.isolation === 'isolate')
      this.container.style.isolation = this.previousContainerIsolation;
  }

  /** 首次出现可见 DOM 预览时将覆盖层提升至独立顶层透明 Canvas，创建后常驻至销毁，避免交互期间反复创建与销毁 */
  private ensureOverlayElevated(): void {
    if (this.overlayLeafer) return;
    const doc = this.container.ownerDocument;
    const host = doc.createElement('div');
    host.className = 'skynote-overlay-layer';
    Object.assign(host.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '2',
      pointerEvents: 'none',
      overflow: 'hidden'
    });
    this.container.appendChild(host);
    const { width, height } = this.engine.session.viewportSize;
    const overlayLeafer = new Leafer({
      view: host,
      width: width || this.container.clientWidth,
      height: height || this.container.clientHeight,
      pixelRatio: this.options?.pixelRatio ?? window.devicePixelRatio,
      pixelSnap: true,
      // 必须关闭 hittable，否则 Leafer 会给内部 canvas 写入 pointer-events: auto 拦截下层 DOM 预览点击
      hittable: false
    });
    if (overlayLeafer.canvas?.view) overlayLeafer.canvas.view.style.pointerEvents = 'none';
    const overlayScene = new Group();
    const { x, y, zoom } = this.engine.session.viewport;
    overlayScene.set({ x, y, scaleX: zoom, scaleY: zoom });
    overlayScene.add(this.overlayLayer);
    overlayLeafer.add(overlayScene);
    this.overlayScene = overlayScene;
    this.overlayHost = host;
    this.overlayLeafer = overlayLeafer;
    if (this.leafer.renderer.changed) this.leafer.renderer.render();
  }

  private applyViewportTransform(): void {
    const { x, y, zoom } = this.engine.session.viewport;
    this.scene.set({ x, y, scaleX: zoom, scaleY: zoom });
    this.overlayScene?.set({ x, y, scaleX: zoom, scaleY: zoom });
    this.viewportTransformPending = false;
  }

  private indexPreview(id: string): void {
    const node = this.engine.entityStore.getNode(id)?.entity;
    const hasPreview =
      !!node && this.previewRenderers.get(node.nodeType)?.resolveSource(this.engine, node) !== undefined;
    if (hasPreview) this.previewIds.add(id);
    else this.previewIds.delete(id);
  }

  private indexContentPreviews(): void {
    this.previewIds.clear();
    const { nodes } = this.engine.documentStore.getView().content;
    for (const id in nodes) this.indexPreview(id);
  }

  private mediaCardAt(point: Point): string | undefined {
    const { engine } = this;
    if (engine.session.tool !== 'select' || engine.session.inMaintenance) return;
    const hit = engine.hitTest(point);
    if (hit?.kind !== 'node') return;
    const { node } = hit;
    const link = readWebLink(node);
    const isVideoCard = getVideoFields(node)?.displayMode !== 'preview' && getVideoAsset(engine, node);
    if (link?.preview || (!link && !isVideoCard)) return;
    const matrix = engine.entityStore.getWorldTransform(node.id);
    if (!matrix) return;
    const local = applyMatrix(invertMatrix(matrix), point.x, point.y);
    const inside = link
      ? local.x >= 0 && local.x <= node.width && local.y >= 0 && local.y <= node.height
      : Math.hypot(local.x - node.width / 2, local.y - node.height / 2) <= videoCardPlayRadius(node);
    return inside ? node.id : undefined;
  }

  private hasViewportNodesAbove(candidates: readonly string[], viewport: RectBounds, limit: number): boolean {
    if (candidates.length <= limit) return false;
    const spatialIndex = this.engine.spatialIndex;
    let remaining = limit;
    for (const id of candidates) {
      const bounds = spatialIndex.getBounds(id);
      if (bounds && doBoundsIntersect(bounds, viewport) && --remaining < 0) return true;
    }
    return false;
  }
  private scheduleLodRecovery(recoveryAt: number | undefined): void {
    if (recoveryAt === this.lodRecoveryAt) return;
    if (this.lodRecoveryTimer !== null) clearTimeout(this.lodRecoveryTimer);
    this.lodRecoveryAt = recoveryAt;
    this.lodRecoveryTimer =
      recoveryAt === undefined
        ? null
        : setTimeout(
            () => {
              this.lodRecoveryTimer = null;
              this.lodRecoveryAt = undefined;
              this.requestRender();
            },
            Math.max(0, Math.ceil(recoveryAt - performance.now()))
          );
  }
}
