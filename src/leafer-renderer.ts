/**
 * @file leafer-renderer.ts
 * @description SkyNote LeaferJS 高性能交互渲染适配器 (LeaferRenderer)
 *
 * 本类只负责编排：场景树与宿主网关的挂载销毁、变更订阅、帧调度、视口、LOD 与拾取；
 * 节点与连线的绘制细节分别收敛在 layers/node-layer 与 layers/connector-layer。
 *
 * 遵守 AGENTS.md 准则与性能军规：
 * 1. 纯事务与单向数据流：仅消费 DocumentStore 广播的增量变更集，同一帧内的多次提交合并为一次 rAF 渲染；
 * 2. 帧开销与画布规模无关：每帧只处理视锥内实体与本帧删除的实体，离屏图元从场景树摘除，离屏缓存按 LRU 限额淘汰；
 * 3. 单一事实源：视口、选区与主题直连引擎的本地会话状态 (engine.session)，渲染器不持有副本；
 * 4. LOD 降级：缩放过小或渲染压力过大时，节点降级为纯色占位块，极限档位不绘制连线；
 * 5. 顶层瞬态通道：失焦与 Esc (经 ADR-005 焦点栈) 时自动清空，杜绝蚂蚁线框残留。
 */

import { Leafer, Group } from 'leafer';
import type {
  SkyNoteEngine,
  NodeEntity,
  ConnectorEntity,
  Point,
  RectBounds,
  CanvasWheelEvent
} from '@skynote/core';
import { isPointInNode } from '@skynote/core';
import type { LeaferRendererOptions, LeaferRenderContext, HitEntityResult } from './types';
import {
  screenToWorld,
  worldToScreen,
  getViewportWorldBounds,
  distanceToPolyline,
  type ViewportState
} from './viewport/viewport-transform';
import { EphemeralChannel } from './ephemeral/ephemeral-channel';
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
import { compareHierarchicalNodes } from './layering/content-layer-order';
import { NodeLayer } from './layers/node-layer';
import { ConnectorLayer } from './layers/connector-layer';
import { ContentOrderSync } from './layers/content-order-sync';

const EPHEMERAL_ESCAPE_SCOPE_ID = 'renderer:ephemeral-escape';
const DEFAULT_OFFSCREEN_CACHE_LIMIT = 2000;
/** 视锥缓冲边距：覆盖描边、箭头与路由外扩，避免边缘实体进出视野时闪烁 */
const FRUSTUM_PADDING = 100;

export class LeaferRenderer {
  readonly engine: SkyNoteEngine;
  readonly nodeRenderers = new LeaferNodeRendererRegistry();
  readonly connectorRenderers = new LeaferConnectorRendererRegistry();

  private container: HTMLElement | null = null;
  private leaferApp: Leafer | null = null;
  private sceneGroup: Group | null = null;
  private backgroundLayer: Group | null = null;
  private contentLayer: Group | null = null;
  private nodeLayer: NodeLayer | null = null;
  private connectorLayer: ConnectorLayer | null = null;
  private contentOrder: ContentOrderSync | null = null;
  private ephemeralChannel: EphemeralChannel | null = null;
  private hostBridge: DOMHostBridge | null = null;

  private readonly dpr: number;
  private readonly offscreenCacheLimit: number;
  private readonly frameScheduler: FrameCommitScheduler;
  private readonly lodController: AdaptiveLodController;
  private isInteracting = false;
  private currentLodLevel: SkyNoteLodLevel = 'full';
  /** 文档层级发生变化 (或首帧)：下一帧需全量重排；平时只为新挂载的实体定位插入 */
  private layerOrderInvalidated = true;
  /** 自上一帧以来被删除、待销毁图元缓存的实体 */
  private readonly pendingRemovedNodeIds = new Set<string>();
  private readonly pendingRemovedConnectorIds = new Set<string>();

  private scheduledRafId: number | null = null;
  /** LOD 回升存在迟滞：等待期满后需主动补一帧，否则画面会停留在降级档位直到下一次交互 */
  private lodRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribeDoc: (() => void) | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private unregisterDefaultWheel: (() => void) | null = null;
  private readonly abortController = new AbortController();
  private isDestroyed = false;

  constructor(engine: SkyNoteEngine, options?: LeaferRendererOptions) {
    this.engine = engine;
    this.dpr = options?.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    this.offscreenCacheLimit = Math.max(0, options?.offscreenCacheLimit ?? DEFAULT_OFFSCREEN_CACHE_LIMIT);
    this.frameScheduler = new FrameCommitScheduler({ enabled: options?.enableFrameScheduler !== false });
    this.lodController = new AdaptiveLodController();

    if (options?.initialViewport) {
      engine.session.setViewport(options.initialViewport);
    }
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

    // 1. Leafer 根应用，画布底色取自主题
    this.leaferApp = new Leafer({
      view: container,
      width: container.clientWidth || 800,
      height: container.clientHeight || 600,
      pixelRatio: this.dpr,
      fill: this.engine.session.theme.background
    });

    // 2. 场景树分层：背景层 -> 统一内容层 -> 顶层瞬态交互层
    const { viewport } = this.engine.session;
    this.sceneGroup = new Group({ x: viewport.x, y: viewport.y, scaleX: viewport.zoom, scaleY: viewport.zoom });
    this.backgroundLayer = new Group();
    this.contentLayer = new Group();
    const ephemeralGroup = new Group();
    this.sceneGroup.add(this.backgroundLayer);
    this.sceneGroup.add(this.contentLayer);
    this.sceneGroup.add(ephemeralGroup);
    this.leaferApp.add(this.sceneGroup);

    this.ephemeralChannel = new EphemeralChannel(ephemeralGroup, this.dpr);
    this.nodeLayer = new NodeLayer({
      contentLayer: this.contentLayer,
      engine: this.engine,
      renderers: this.nodeRenderers,
      dpr: this.dpr,
      offscreenCacheLimit: this.offscreenCacheLimit
    });
    this.connectorLayer = new ConnectorLayer({
      contentLayer: this.contentLayer,
      engine: this.engine,
      offscreenCacheLimit: this.offscreenCacheLimit
    });

    this.contentOrder = new ContentOrderSync(this.contentLayer, this.nodeLayer, this.connectorLayer, this.engine.entityStore);

    // 3. 宿主事件网桥与交互态感知
    this.hostBridge = new DOMHostBridge({
      container,
      engine: this.engine,
      getViewport: () => this.engine.session.viewport,
      hitTest: (point: Point) => this.hitTest(point),
      onInteractionChange: (isInteracting: boolean) => {
        this.isInteracting = isInteracting;
      }
    });

    // 4. 底座默认滚轮缩放平移 (最低优先级，允许上层交互优先拦截)
    this.unregisterDefaultWheel = this.engine.pointer.register(
      'renderer:viewport-wheel',
      { onWheel: (e: CanvasWheelEvent) => this.handleDefaultWheel(e) },
      -100
    );

    // 5. 文档增量变更：登记待销毁实体与层级脏标记，合并到下一帧
    this.unsubscribeDoc = this.engine.documentStore.subscribe((_view, _record, changes) => {
      for (const id of changes.nodes.removed) this.pendingRemovedNodeIds.add(id);
      for (const id of changes.connectors.removed) this.pendingRemovedConnectorIds.add(id);
      if (changes.orderChanged) this.layerOrderInvalidated = true;
      this.requestRender();
    });

    // 6. 会话变更：视口变换矩阵立即生效 (平移缩放零延迟跟手)，视锥、选中态与主题重绘合并到下一帧
    this.unsubscribeSession = this.engine.session.subscribe((change) => {
      if (change.viewportChanged) this.applyViewportTransform();
      if (change.themeChanged && this.leaferApp) this.leaferApp.fill = this.engine.session.theme.background;
      this.requestRender();
    });

    // 7. 失焦与 Esc 兜底清空瞬态图元：Esc 经焦点栈以最低优先级消费，上层交互 (如取消拖拽) 先行处理
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

    // 8. 容器尺寸变化自动响应
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
          const width = Math.floor(entries[i].contentRect.width);
          const height = Math.floor(entries[i].contentRect.height);
          if (width > 0 && height > 0 && this.leaferApp) {
            this.leaferApp.resize({ width, height });
            this.requestRender();
          }
        }
      });
      this.resizeObserver.observe(container);
    }

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
   * 立即执行一帧渲染并冲刷所有待处理变更 (视锥剔除 + 增量更新 + 自适应 LOD 与分帧调度)
   * 开销只与视锥内实体数和本帧删除数相关，与画布总规模无关
   */
  renderFrame(): void {
    const { nodeLayer, connectorLayer, contentOrder } = this;
    if (this.isDestroyed || !nodeLayer || !connectorLayer || !contentOrder) return;
    if (this.scheduledRafId !== null) {
      cancelAnimationFrame(this.scheduledRafId);
      this.scheduledRafId = null;
    }

    const frameStartTime = performance.now();
    const { entityStore, session } = this.engine;
    const viewport = session.viewport;

    // 1. 销毁已删除实体的图元缓存
    for (const id of this.pendingRemovedNodeIds) nodeLayer.destroy(id);
    this.pendingRemovedNodeIds.clear();
    for (const id of this.pendingRemovedConnectorIds) connectorLayer.destroy(id);
    this.pendingRemovedConnectorIds.clear();

    // 2. 视锥检索
    const worldBounds = getViewportWorldBounds(
      viewport,
      this.container?.clientWidth || 800,
      this.container?.clientHeight || 600
    );
    const frustum: RectBounds = {
      left: worldBounds.left - FRUSTUM_PADDING,
      top: worldBounds.top - FRUSTUM_PADDING,
      right: worldBounds.right + FRUSTUM_PADDING,
      bottom: worldBounds.bottom + FRUSTUM_PADDING,
      width: worldBounds.width + FRUSTUM_PADDING * 2,
      height: worldBounds.height + FRUSTUM_PADDING * 2
    };
    const visibleNodeIds = this.engine.spatialIndex.search(frustum);
    const connectorCandidateIds = this.engine.connectorSpatialIndex.search(frustum);

    // 3. 自适应 LOD：reduced 起节点降级为占位块，minimal 不再绘制连线
    const lodState = this.lodController.evaluate({
      now: frameStartTime,
      zoom: viewport.zoom,
      documentNodes: entityStore.nodeCount,
      documentConnectors: entityStore.connectorCount,
      visibleNodes: visibleNodeIds.length,
      visibleConnectors: connectorCandidateIds.length,
      nodeObjects: nodeLayer.cacheCount,
      connectorObjects: connectorLayer.cacheCount,
      isInteracting: this.isInteracting
    });
    this.currentLodLevel = lodState.level;
    this.scheduleLodRecovery(lodState);
    const visibleConnectorIds = lodState.level === 'minimal' ? [] : connectorCandidateIds;

    // 4. 分帧提交调度：大量实体超载时分帧缓冲，选中实体优先
    const frameResult = this.frameScheduler.reconcileAndCommit({
      nodeIds: visibleNodeIds,
      nodePriorityIds: session.selectedNodeIds,
      connectorIds: visibleConnectorIds,
      connectorPriorityIds: session.selectedConnectorIds
    });

    // 5. 节点与连线图层增量同步，有实体新进入场景时需为其定位层级
    const context: LeaferRenderContext = {
      viewport,
      isInteracting: this.isInteracting,
      theme: session.theme
    };
    const nodeSync = nodeLayer.sync(
      visibleNodeIds,
      (id) => frameResult.committedNodeIds.has(id),
      context,
      lodState.level === 'full' ? 'full' : 'placeholder'
    );
    const connectorSync = connectorLayer.sync(
      visibleConnectorIds,
      (id) => frameResult.committedConnectorIds.has(id),
      session.theme
    );
    // 以实测挂载成本校准分帧调度器，慢设备自动缩小每帧提交量，快设备减少不必要的分帧
    this.frameScheduler.recordNodePhase(nodeSync.enterMs, nodeSync.entered);
    this.frameScheduler.recordConnectorPhase(connectorSync.enterMs, connectorSync.entered);

    // 6. 层级同步：文档层级变化时全量排序并最少移动，否则只插入新挂载的实体
    if (this.layerOrderInvalidated || nodeSync.entered > 0 || connectorSync.entered > 0) {
      contentOrder.sync(this.layerOrderInvalidated);
      this.layerOrderInvalidated = false;
    }

    // 7. 帧耗时度量，分帧队列未清空时继续调度
    this.lodController.recordFrame(performance.now() - frameStartTime, frameStartTime);
    if (frameResult.state.active) {
      this.requestRender();
    }
  }

  /**
   * 节点空间碰撞拾取：在命中候选中按层级规则取最上层者 (忽略不可见节点)
   * 空间索引按外接矩形粗筛，旋转节点须按实际框精判；返回顺序与层叠无关，必须显式比较层级
   */
  hitTest(point: Point): NodeEntity | undefined {
    const entityStore = this.engine.entityStore;
    const chainCache = new Map<string, NodeEntity[]>();
    const getNode = (id: string) => entityStore.getNode(id)?.entity;

    let top: NodeEntity | undefined;
    const candidateIds = this.engine.spatialIndex.hitTest(point);
    for (let i = 0; i < candidateIds.length; i++) {
      const node = getNode(candidateIds[i]);
      if (!node || node.style?.opacity === 0 || !isPointInNode(point, node)) continue;
      if (!top) {
        top = node;
        continue;
      }
      if (compareHierarchicalNodes(node, top, getNode, chainCache) > 0) {
        top = node;
      }
    }
    return top;
  }

  /**
   * 连线几何碰撞拾取 (点击在连线附近 tolerance 像素内判定命中)
   * 先经连线空间索引粗筛，再按引擎路由做折线距离精判，离屏或尚未绘制的连线同样可拾取
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
      const route = this.engine.getConnectorRoute(candidateIds[i]);
      if (route && distanceToPolyline(point, route.points) <= worldTolerance) {
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
    if (node) return { type: 'node', entity: node };
    const connector = this.hitTestConnector(point);
    if (connector) return { type: 'connector', entity: connector };
    return undefined;
  }

  /**
   * 更新视口：写入引擎会话状态，变换矩阵与重绘由会话订阅统一驱动
   */
  setViewport(viewport: Partial<ViewportState>): void {
    if (this.isDestroyed) return;
    this.engine.session.setViewport(viewport);
  }

  /** 获取当前视口状态副本 */
  getViewport(): ViewportState {
    return { ...this.engine.session.viewport };
  }

  /** 获取当前自适应 LOD 等级 */
  getLodLevel(): SkyNoteLodLevel {
    return this.currentLodLevel;
  }

  /** 获取底层背景渲染层 Group (用于挂载点阵背景、坐标网格等底层装饰) */
  getBackgroundLayer(): Group | null {
    return this.backgroundLayer;
  }

  /** 获取统一内容层 Group (所有节点与连线按层级排序所在层) */
  getContentLayer(): Group | null {
    return this.contentLayer;
  }

  screenToWorld(screenPoint: Point): Point {
    return screenToWorld(screenPoint, this.engine.session.viewport);
  }

  worldToScreen(worldPoint: Point): Point {
    return worldToScreen(worldPoint, this.engine.session.viewport);
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
    if (this.lodRecoveryTimer !== null) {
      clearTimeout(this.lodRecoveryTimer);
      this.lodRecoveryTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.abortController.abort();

    this.unsubscribeDoc?.();
    this.unsubscribeDoc = null;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.unregisterDefaultWheel?.();
    this.unregisterDefaultWheel = null;
    this.engine.inputScopes.popScope(EPHEMERAL_ESCAPE_SCOPE_ID);

    this.hostBridge?.destroy();
    this.hostBridge = null;
    this.ephemeralChannel?.destroy();
    this.ephemeralChannel = null;

    this.contentOrder = null;
    this.nodeLayer?.destroyAll();
    this.nodeLayer = null;
    this.connectorLayer?.destroyAll();
    this.connectorLayer = null;
    this.nodeRenderers.clear();
    this.connectorRenderers.clear();

    this.backgroundLayer?.clear();
    this.backgroundLayer = null;
    this.contentLayer?.clear();
    this.contentLayer = null;
    this.leaferApp?.destroy();
    this.leaferApp = null;
    this.container = null;
  }

  private applyViewportTransform(): void {
    if (!this.sceneGroup) return;
    const { viewport } = this.engine.session;
    this.sceneGroup.set({ x: viewport.x, y: viewport.y, scaleX: viewport.zoom, scaleY: viewport.zoom });
  }

  private scheduleLodRecovery(lodState: SkyNoteAdaptiveLodState): void {
    if (lodState.level === lodState.desiredLevel || this.lodRecoveryTimer !== null) return;
    this.lodRecoveryTimer = setTimeout(() => {
      this.lodRecoveryTimer = null;
      this.requestRender();
    }, DEFAULT_ADAPTIVE_LOD_OPTIONS.recoveryDelayMs + 50);
  }

  /**
   * 默认底座滚轮缩放与双指平移
   */
  private handleDefaultWheel(e: CanvasWheelEvent): void {
    const viewport = this.engine.session.viewport;
    if (e.deltaZoom !== 0) {
      // 以滚轮所在世界坐标为中心缩放
      const oldZoom = viewport.zoom;
      const newZoom = Math.max(0.1, Math.min(10, oldZoom * (1 + e.deltaZoom)));
      this.setViewport({
        x: viewport.x + e.centerPoint.x * (oldZoom - newZoom),
        y: viewport.y + e.centerPoint.y * (oldZoom - newZoom),
        zoom: newZoom
      });
    } else if (e.deltaPan.x !== 0 || e.deltaPan.y !== 0) {
      this.setViewport({ x: viewport.x + e.deltaPan.x, y: viewport.y + e.deltaPan.y });
    }
  }
}

/**
 * 辅助工厂函数
 */
export function createLeaferRenderer(engine: SkyNoteEngine, options?: LeaferRendererOptions): LeaferRenderer {
  return new LeaferRenderer(engine, options);
}
