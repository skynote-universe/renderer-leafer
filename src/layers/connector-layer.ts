/**
 * @file connector-layer.ts
 * @description 连线图层：按引擎路由绘制视锥内连线，摘除离屏连线并按 LRU 淘汰缓存
 *
 * 设计考量 (Why):
 * 1. 挂载容器 (ADR-114)：连线挂在两端节点的公共祖先容器中 (见 layering/content-layer-order)，
 *    挂载位置只随层叠关系变化，按连线缓存，文档层级变化 (orderChanged) 时整体失效。
 * 2. 路由保持世界坐标：连线图元设为容器世界矩阵的逆，抵消容器的平移与旋转；
 *    容器移动时路由本就会重算，无需把路由点换算到各容器的局部坐标。
 */

import type { Group } from 'leafer';
import type { SkyNoteEngine, CanvasTheme, NodeEntity } from '@skynote/core';
import type { LayerSyncResult } from '../types';
import { ConnectorView } from '../connector/connector-view';
import { resolveConnectorLayerPlacement, type ConnectorLayerPlacement } from '../layering/content-layer-order';
import { VisibilityTracker } from './visibility-tracker';

export interface ConnectorLayerOptions {
  engine: SkyNoteEngine;
  offscreenCacheLimit: number;
}

export class ConnectorLayer {
  private readonly views = new Map<string, ConnectorView>();
  private readonly visibility: VisibilityTracker;
  private readonly placements = new Map<string, ConnectorLayerPlacement>();
  /** 祖先链只随 parentId 变化，与挂载位置同时失效 */
  private readonly chainCache = new Map<string, NodeEntity[]>();

  constructor(private readonly options: ConnectorLayerOptions) {
    this.visibility = new VisibilityTracker(options.offscreenCacheLimit);
  }

  /** 当前持有的图元缓存数 (含离屏保留) */
  get cacheCount(): number {
    return this.views.size;
  }

  /** 当前挂载在内容层上的连线 */
  get shownIds(): ReadonlySet<string> {
    return this.visibility.shownIds;
  }

  getGroup(connectorId: string): Group | undefined {
    return this.views.get(connectorId)?.group;
  }

  /** 文档层叠关系变化 (zIndex / parentId / 端点 / 增删) 后调用，挂载位置在下次读取时重新求解 */
  invalidatePlacements(): void {
    this.placements.clear();
    this.chainCache.clear();
  }

  /** 连线的挂载容器与伴生锚点；连线不存在时返回 undefined */
  getPlacement(connectorId: string): ConnectorLayerPlacement | undefined {
    let placement = this.placements.get(connectorId);
    if (!placement) {
      const { entityStore } = this.options.engine;
      const connector = entityStore.getConnector(connectorId)?.entity;
      if (!connector) return undefined;
      placement = resolveConnectorLayerPlacement(connector, (id) => entityStore.getNode(id)?.entity, this.chainCache);
      this.placements.set(connectorId, placement);
    }
    return placement;
  }

  /**
   * 绘制本帧视锥内连线 (路由、数据版本、主题与容器矩阵未变时走 Fast Path 零开销)
   * 只对新进入场景的连线计时，用于校准分帧调度器
   * @param resolveContainer 挂载容器节点 id → 其子容器图元 (节点图层已在本帧挂载)；undefined 为根内容层
   */
  sync(
    visibleIds: readonly string[],
    isCommitted: (id: string) => boolean,
    theme: CanvasTheme,
    resolveContainer: (containerId: string | undefined) => Group
  ): LayerSyncResult {
    const { engine } = this.options;
    const shown = this.visibility.shownIds;
    const result: LayerSyncResult = { entered: 0, enterMs: 0, left: 0 };

    this.visibility.beginFrame();
    for (let i = 0; i < visibleIds.length; i++) {
      const connectorId = visibleIds[i];
      if (!isCommitted(connectorId)) continue;
      const runtimeConnector = engine.entityStore.getConnector(connectorId);
      if (!runtimeConnector || runtimeConnector.entity.style?.strokeWidth === 0) continue;
      const route = engine.getConnectorRoute(connectorId);
      if (!route) continue;

      const entering = !shown.has(connectorId);
      const start = entering ? performance.now() : 0;
      const { containerId } = this.getPlacement(connectorId)!;
      const container = resolveContainer(containerId);
      let view = this.views.get(connectorId);
      if (!view) {
        view = new ConnectorView();
        this.views.set(connectorId, view);
      }
      view.update({
        connector: runtimeConnector.entity,
        route,
        dataVersion: runtimeConnector.runtime.dataVersion,
        arrowMarkers: engine.arrowMarkers,
        theme
      });
      if (view.group.parent !== container) container.add(view.group);
      view.setContainerTransform(containerId === undefined ? null : engine.entityStore.getWorldTransform(containerId)!);

      this.visibility.markShown(connectorId);
      if (entering) {
        result.enterMs += performance.now() - start;
        result.entered++;
      }
    }
    this.visibility.endFrame(
      (connectorId) => {
        this.views.get(connectorId)?.group.remove();
        result.left++;
      },
      (connectorId) => this.destroy(connectorId)
    );
    return result;
  }

  destroy(connectorId: string): void {
    this.visibility.forget(connectorId);
    // 原生连线渲染器尚未接入，图元均由默认线型创建，直接随视图销毁
    this.views.get(connectorId)?.destroy();
    this.views.delete(connectorId);
  }

  destroyAll(): void {
    for (const connectorId of [...this.views.keys()]) {
      this.destroy(connectorId);
    }
  }
}
