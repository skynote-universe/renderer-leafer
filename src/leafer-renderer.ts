/**
 * @file leafer-renderer.ts
 * @description SkyNote LeaferJS 高性能交互渲染适配器 (LeaferRenderer)
 * 
 * 遵守 AGENTS.md 准则与性能军规：
 * 1. 纯事务与单向数据流：通过订阅 engine.documentStore 与 commitPatch 调度增量更新；
 * 2. 双版本号守卫：几何变化仅更新变换矩阵，内容变化就地修改图元属性，零无谓 GC 掉帧；
 * 3. 视锥裁剪：通过 Core 的 spatialIndex 仅绘制视口范围内节点；
 * 4. 顶层瞬态通道与自动兜底守护：0 DOM 瞬态图元绘制通道，Blur 与 Escape 时 100% 自动清空无残留；
 * 5. 全链路闭环：Resize 自动感知、视口双向同步、全实体碰撞拾取、自适应 LOD 与帧性能度量深度串联；
 * 6. 单一事实源：杜绝类内部冗余字段，选区与视口直连 DocumentStore。
 */

import { Leafer, Group } from 'leafer';
import type {
  SkyNoteEngine,
  NodeEntity,
  ConnectorEntity,
  Point,
  CanvasPatch,
  CanvasPrimitive,
  RectBounds,
  NodeFill,
  CanvasWheelEvent
} from '@skynote/core';
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
import { AdaptiveLodController, type SkyNoteLodLevel } from './scheduler/adaptive-lod';

function resolveSolidFill(fill?: NodeFill): string {
  if (!fill) return '#FFFFFF';
  if (typeof fill === 'string') return fill;
  return fill.stops[0]?.color ?? '#FFFFFF';
}

export class LeaferRenderer {
  readonly engine: SkyNoteEngine;
  readonly nodeRenderers = new LeaferNodeRendererRegistry();
  readonly connectorRenderers = new LeaferConnectorRendererRegistry();

  private container: HTMLElement | null = null;
  private leaferApp: Leafer | null = null;
  private sceneGroup: Group | null = null;
  private nodesLayer: Group | null = null;
  private connectorsLayer: Group | null = null;
  private ephemeralGroup: Group | null = null;
  private hostBridge: DOMHostBridge | null = null;

  private viewport: ViewportState = { x: 0, y: 0, zoom: 1 };
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

  private unsubscribeDoc: (() => void) | null = null;
  private unregisterDefaultWheel: (() => void) | null = null;
  private abortController = new AbortController();
  private isSyncingViewport = false;
  private isDestroyed = false;

  constructor(engine: SkyNoteEngine, options?: LeaferRendererOptions) {
    this.engine = engine;
    this.dpr = options?.dpr ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

    // 优先采用 DocumentStore 当前视口，其次采用 options.initialViewport
    const storeViewport = engine.documentStore.getView().viewport;
    this.viewport = {
      x: options?.initialViewport?.x ?? storeViewport.x ?? 0,
      y: options?.initialViewport?.y ?? storeViewport.y ?? 0,
      zoom: options?.initialViewport?.zoom ?? storeViewport.zoom ?? 1
    };

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

    // 1. 初始化 Leafer 根应用
    this.leaferApp = new Leafer({
      view: container,
      width,
      height,
      pixelRatio: this.dpr
    });

    // 2. 建立场景树分层结构
    this.sceneGroup = new Group({
      x: this.viewport.x,
      y: this.viewport.y,
      scaleX: this.viewport.zoom,
      scaleY: this.viewport.zoom
    });
    this.connectorsLayer = new Group();
    this.nodesLayer = new Group();
    this.ephemeralGroup = new Group();

    this.sceneGroup.add(this.connectorsLayer);
    this.sceneGroup.add(this.nodesLayer);
    this.sceneGroup.add(this.ephemeralGroup);
    this.leaferApp.add(this.sceneGroup);

    // 3. 挂载瞬态渲染通道
    this.ephemeralChannel = new EphemeralChannel(this.ephemeralGroup, this.dpr);

    // 4. 初始化宿主事件网桥并接入交互态感知闭环
    this.hostBridge = new DOMHostBridge({
      container,
      engine: this.engine,
      getViewport: () => this.viewport,
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
    this.unsubscribeDoc = this.engine.documentStore.subscribe(() => {
      const docView = this.engine.documentStore.getView();
      if (!this.isSyncingViewport) {
        const dv = docView.viewport;
        if (dv.x !== this.viewport.x || dv.y !== this.viewport.y || dv.zoom !== this.viewport.zoom) {
          this.setViewport(dv, false);
        }
      }
      this.renderFrame();
    });

    // 7. 挂载全局失焦与 Esc 兜底守护，杜绝瞬态蚂蚁线框残留
    if (typeof window !== 'undefined') {
      const { signal } = this.abortController;
      window.addEventListener('blur', () => this.ephemeralChannel?.clearAll(), { signal });
      window.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') {
          this.ephemeralChannel?.clearAll();
        }
      }, { signal });
    }

    // 8. 挂载容器尺寸监听 (ResizeObserver 自动响应)
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(entries => {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const newWidth = Math.floor(entry.contentRect.width);
          const newHeight = Math.floor(entry.contentRect.height);
          if (newWidth > 0 && newHeight > 0 && this.leaferApp) {
            this.leaferApp.resize({ width: newWidth, height: newHeight });
            this.renderFrame();
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
   * 接收上层提交的原子补丁
   */
  commitPatch(_patches: CanvasPatch[]): void {
    if (this.isDestroyed || !this.sceneGroup) return;
    this.renderFrame();
  }

  /**
   * 核心渲染帧执行函数 (视锥剔除 + 双版本号局部更新 + 自适应 LOD 与分帧调度)
   */
  renderFrame(): void {
    if (this.isDestroyed || !this.sceneGroup || !this.nodesLayer || !this.connectorsLayer) return;

    const frameStartTime = performance.now();
    const containerWidth = this.container?.clientWidth || 800;
    const containerHeight = this.container?.clientHeight || 600;

    // 1. 计算视口在世界逻辑坐标系下的裁剪包围盒 (Frustum Culling)
    const worldBounds = getViewportWorldBounds(this.viewport, containerWidth, containerHeight);

    // 扩展缓冲边距
    const padding = 100;
    const expandedBounds: RectBounds = {
      left: worldBounds.left - padding,
      top: worldBounds.top - padding,
      right: worldBounds.right + padding,
      bottom: worldBounds.bottom + padding,
      width: worldBounds.width + padding * 2,
      height: worldBounds.height + padding * 2
    };

    // 2. 利用 Core 的空间索引检索可视范围内的节点 ID 集合
    const visibleNodeIdsList = this.engine.spatialIndex.search(expandedBounds);
    const visibleNodeIds = new Set<string>(visibleNodeIdsList);

    const allNodes = this.engine.entityStore.getAllNodes();
    const allConnectors = this.engine.entityStore.getAllConnectors();

    // 3. 自适应 LOD 性能度量与降级评估
    const lodState = this.lodController.evaluate({
      now: frameStartTime,
      zoom: this.viewport.zoom,
      documentNodes: allNodes.length,
      documentConnectors: allConnectors.length,
      visibleNodes: visibleNodeIds.size,
      visibleConnectors: allConnectors.length,
      nodeObjects: this.nodeCaches.size,
      connectorObjects: this.connectorCaches.size,
      isInteracting: this.isInteracting
    });
    this.currentLodLevel = lodState.level;

    // 从单一事实源 DocumentStore 读取实时选中态
    const docSelection = this.engine.documentStore.getView().selection;
    const selectedNodeIds = new Set<string>(docSelection.nodeIds);
    const selectedConnectorIds = new Set<string>(docSelection.connectorIds);

    // 4. 分帧提交调度器判定：大量节点超载时进行分帧缓冲
    const frameResult = this.frameScheduler.reconcileAndCommit({
      nodeIds: visibleNodeIdsList,
      nodePriorityIds: Array.from(selectedNodeIds),
      connectorIds: allConnectors.map(c => c.entity.id),
      connectorPriorityIds: Array.from(selectedConnectorIds)
    });

    const allowedNodeIds = frameResult.committedNodeIds;

    // 5. 渲染或更新可视节点
    const currentDocNodeIds = new Set<string>();
    const context: LeaferRenderContext = {
      viewport: this.viewport,
      isInteracting: this.isInteracting,
      selectedNodeIds,
      selectedConnectorIds
    };

    for (let i = 0; i < allNodes.length; i++) {
      const runtimeNode = allNodes[i];
      const node = runtimeNode.entity;
      const nodeId = node.id;
      currentDocNodeIds.add(nodeId);

      const isVisible = visibleNodeIds.has(nodeId) && node.style?.opacity !== 0;
      const isCommitted = allowedNodeIds.has(nodeId);
      const cache = this.nodeCaches.get(nodeId);

      if (!isVisible || !isCommitted) {
        if (cache) {
          cache.outerGroup.visible = false;
        }
        continue;
      }

      this.renderOrUpdateNode(
        node,
        runtimeNode.runtime.geomVersion,
        runtimeNode.runtime.dataVersion,
        cache,
        context
      );
    }

    // 6. 清理已删除节点缓存并成对调用 destroy
    for (const [cachedId, cache] of this.nodeCaches) {
      if (!currentDocNodeIds.has(cachedId)) {
        if (cache.nodeType) {
          const nativeRenderer = this.nodeRenderers.get(cache.nodeType);
          nativeRenderer?.destroy?.(cache.shapes, { id: cachedId } as any);
        }
        cache.outerGroup.remove();
        this.nodeCaches.delete(cachedId);
      }
    }

    // 7. 渲染连线与端点标记 (接入端点几何签名与 Fast Path 守卫)
    const currentDocConnectorIds = new Set<string>();
    for (let i = 0; i < allConnectors.length; i++) {
      const runtimeConnector = allConnectors[i];
      const connector = runtimeConnector.entity;
      const connectorId = connector.id;
      currentDocConnectorIds.add(connectorId);

      const existing = this.connectorCaches.get(connectorId);
      if (connector.style?.strokeWidth === 0) {
        if (existing) {
          existing.group.visible = false;
        }
        continue;
      }

      const fromRuntime = connector.from.nodeId
        ? this.engine.entityStore.getNode(connector.from.nodeId)
        : undefined;
      const toRuntime = connector.to.nodeId
        ? this.engine.entityStore.getNode(connector.to.nodeId)
        : undefined;

      const fromNode = fromRuntime?.entity;
      const toNode = toRuntime?.entity;

      const updated = renderConnector(this.connectorsLayer, {
        connector,
        geomVersion: runtimeConnector.runtime.geomVersion,
        dataVersion: runtimeConnector.runtime.dataVersion,
        fromNode,
        toNode,
        fromNodeGeomVersion: fromRuntime?.runtime.geomVersion ?? 0,
        toNodeGeomVersion: toRuntime?.runtime.geomVersion ?? 0,
        routers: this.engine.routers,
        arrowMarkers: this.engine.arrowMarkers,
        existingCache: existing,
        dpr: this.dpr
      });

      this.connectorCaches.set(connectorId, updated);
    }

    // 清理已删除连线并成对调用 destroy
    for (const [cachedId, cache] of this.connectorCaches) {
      if (!currentDocConnectorIds.has(cachedId)) {
        if (cache.connectorType) {
          const nativeRenderer = this.connectorRenderers.get(cache.connectorType);
          nativeRenderer?.destroy?.([cache.lineShape], { id: cachedId } as any);
        }
        cache.group.remove();
        this.connectorCaches.delete(cachedId);
      }
    }

    // 8. 闭环记录帧耗时度量
    const frameDuration = performance.now() - frameStartTime;
    this.lodController.recordFrame(frameDuration, frameStartTime);

    // 9. 若分帧队列中尚有未提交的节点，自动调度下一帧 requestAnimationFrame
    if (frameResult.state.active && typeof requestAnimationFrame !== 'undefined') {
      if (this.scheduledRafId === null) {
        this.scheduledRafId = requestAnimationFrame(() => {
          this.scheduledRafId = null;
          this.renderFrame();
        });
      }
    }
  }

  /**
   * 单个节点的就地复用与版本号双重判定
   */
  private renderOrUpdateNode(
    node: NodeEntity,
    geomVersion: number,
    dataVersion: number,
    cache: NodeRenderCache | undefined,
    context: LeaferRenderContext
  ): void {
    if (!this.nodesLayer) return;

    // 存在缓存，优先检查几何版本号 (geomVersion)
    if (cache) {
      cache.outerGroup.visible = true;

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

      if (cache.dataVersion === dataVersion) {
        return;
      }

      cache.dataVersion = dataVersion;
      this.updateNodeContent(cache, node, context);
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
    this.nodesLayer.add(outerGroup);

    const newCache: NodeRenderCache = {
      outerGroup,
      contentGroup,
      geomVersion,
      dataVersion,
      shapes: [],
      nodeType: node.nodeType
    };

    this.nodeCaches.set(node.id, newCache);
    this.updateNodeContent(newCache, node, context);
  }

  /**
   * 更新节点内部内容 (原生渲染器 vs 声明式图元 IR)
   */
  private updateNodeContent(
    cache: NodeRenderCache,
    node: NodeEntity,
    context: LeaferRenderContext
  ): void {
    // 1. 检查是否存在专属原生自定义渲染器
    const nativeRenderer = this.nodeRenderers.get(node.nodeType);
    if (nativeRenderer) {
      if (cache.shapes.length === 0) {
        cache.shapes = nativeRenderer.create(node, context);
        cache.shapes.forEach(shape => cache.contentGroup.add(shape));
      } else {
        nativeRenderer.update(cache.shapes, node, context);
      }
      return;
    }

    // 2. 检查 Core NodeTypeRegistry 的声明式 compose() 图元 IR
    const nodeDef = this.engine.nodeTypes.get(node.nodeType);
    let primitives: CanvasPrimitive[] = [];

    if (nodeDef?.compose) {
      primitives = nodeDef.compose(node);
    } else {
      // 默认降级兜底：基础矩形
      primitives = [
        {
          kind: 'rect',
          x: 0,
          y: 0,
          width: node.width,
          height: node.height,
          fill: resolveSolidFill(node.style?.fill),
          stroke: node.style?.stroke ?? '#CBD5E1',
          strokeWidth: node.style?.strokeWidth ?? 1,
          radius: node.style?.radius
        }
      ];
    }

    // 3. 就地复用同步 Leafer 图元
    cache.shapes = reconcileLeaferShapes(
      cache.contentGroup,
      cache.shapes,
      primitives,
      this.dpr
    );
  }

  /**
  * 节点空间碰撞拾取：世界坐标下查找命中节点 (由顶到底遍历，忽略不可见节点)
  */
  hitTest(point: Point): NodeEntity | undefined {
    const candidateIds = this.engine.spatialIndex.hitTest(point);
    if (candidateIds.length > 0) {
      for (let i = candidateIds.length - 1; i >= 0; i--) {
        const topId = candidateIds[i];
        const node = this.engine.entityStore.getNode(topId)?.entity;
        if (node && node.style?.opacity !== 0) return node;
      }
    }

    return undefined;
  }

  /**
   * 连线几何碰撞拾取 (当点击在连线附近 6px 范围内判定命中)
   */
  hitTestConnector(point: Point, tolerance = 6): ConnectorEntity | undefined {
    const worldTolerance = tolerance / (this.viewport.zoom || 1);
    const connectors = this.engine.entityStore.getAllConnectors();

    for (let i = connectors.length - 1; i >= 0; i--) {
      const runtimeConnector = connectors[i];
      if (runtimeConnector.entity.style?.strokeWidth === 0) continue;

      const cache = this.connectorCaches.get(runtimeConnector.entity.id);
      if (!cache || !cache.computedPoints || cache.computedPoints.length < 2) continue;

      const dist = distanceToPolyline(point, cache.computedPoints);
      if (dist <= worldTolerance) {
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
   * 更新视口状态并应用平移与缩放矩阵
   * @param viewport 视口补丁
   * @param syncToStore 是否将视口变更同步至 DocumentStore
   */
  setViewport(viewport: Partial<ViewportState>, syncToStore = true): void {
    if (this.isDestroyed || !this.sceneGroup) return;

    this.viewport = {
      ...this.viewport,
      ...viewport
    };

    this.sceneGroup.set({
      x: this.viewport.x,
      y: this.viewport.y,
      scaleX: this.viewport.zoom,
      scaleY: this.viewport.zoom
    });

    if (syncToStore) {
      this.isSyncingViewport = true;
      try {
        this.engine.documentStore.setViewport(this.viewport, false);
      } finally {
        this.isSyncingViewport = false;
      }
    }

    this.renderFrame();
  }

  /**
   * 获取当前视口状态副本
   */
  getViewport(): ViewportState {
    return { ...this.viewport };
  }

  /**
   * 获取当前自适应 LOD 等级
   */
  getLodLevel(): SkyNoteLodLevel {
    return this.currentLodLevel;
  }

  /**
   * 坐标转换便捷代理
   */
  screenToWorld(screenPoint: Point): Point {
    return screenToWorld(screenPoint, this.viewport);
  }

  worldToScreen(worldPoint: Point): Point {
    return worldToScreen(worldPoint, this.viewport);
  }

  /**
   * 默认底座滚轮缩放与双指平移闭环处理
   */
  private handleDefaultWheel(e: CanvasWheelEvent): void {
    if (e.deltaZoom !== 0) {
      // 以滚轮所在世界坐标为中心进行缩放
      const oldZoom = this.viewport.zoom;
      const newZoom = Math.max(0.1, Math.min(10, oldZoom * (1 + e.deltaZoom)));

      const newX = this.viewport.x + e.centerPoint.x * (oldZoom - newZoom);
      const newY = this.viewport.y + e.centerPoint.y * (oldZoom - newZoom);

      this.setViewport({ x: newX, y: newY, zoom: newZoom });
    } else if (e.deltaPan.x !== 0 || e.deltaPan.y !== 0) {
      // 触控板/滚轮平移
      this.setViewport({
        x: this.viewport.x + e.deltaPan.x,
        y: this.viewport.y + e.deltaPan.y
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

    this.unregisterDefaultWheel?.();
    this.unregisterDefaultWheel = null;

    this.hostBridge?.destroy();
    this.hostBridge = null;

    this.ephemeralChannel?.destroy();
    this.ephemeralChannel = null;

    for (const [cachedId, cache] of this.nodeCaches) {
      if (cache.nodeType) {
        const nativeRenderer = this.nodeRenderers.get(cache.nodeType);
        nativeRenderer?.destroy?.(cache.shapes, { id: cachedId } as any);
      }
      cache.outerGroup.remove();
    }
    this.nodeCaches.clear();

    for (const [cachedId, cache] of this.connectorCaches) {
      if (cache.connectorType) {
        const nativeRenderer = this.connectorRenderers.get(cache.connectorType);
        nativeRenderer?.destroy?.([cache.lineShape], { id: cachedId } as any);
      }
      cache.group.remove();
    }
    this.connectorCaches.clear();
    this.nodeRenderers.clear();
    this.connectorRenderers.clear();

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
