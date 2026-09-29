/**
 * @file connector-layer.ts
 * @description 连线图层：按引擎路由绘制视锥内连线，摘除离屏连线并按 LRU 淘汰缓存
 */

import type { Group } from 'leafer';
import type { SkyNoteEngine, CanvasTheme } from '@skynote/core';
import type { ConnectorRenderCache } from '../types';
import { renderConnector } from '../connector/connector-renderer';
import { VisibilityTracker } from './visibility-tracker';
import type { StableOrder } from './stable-order';

export interface ConnectorLayerOptions {
  contentLayer: Group;
  engine: SkyNoteEngine;
  stableOrder: StableOrder;
  offscreenCacheLimit: number;
}

export class ConnectorLayer {
  private readonly caches = new Map<string, ConnectorRenderCache>();
  private readonly visibility: VisibilityTracker;

  constructor(private readonly options: ConnectorLayerOptions) {
    this.visibility = new VisibilityTracker(options.offscreenCacheLimit);
  }

  /** 当前持有的图元缓存数 (含离屏保留) */
  get cacheCount(): number {
    return this.caches.size;
  }

  /** 当前挂载在内容层上的连线 */
  get shownIds(): ReadonlySet<string> {
    return this.visibility.shownIds;
  }

  getGroup(connectorId: string): Group | undefined {
    return this.caches.get(connectorId)?.group;
  }

  /**
   * 绘制本帧视锥内连线 (路由、数据版本与主题未变时走 Fast Path 零开销)
   * @returns 是否有连线新进入场景 (需要重排层级)
   */
  sync(visibleIds: readonly string[], isCommitted: (id: string) => boolean, theme: CanvasTheme): boolean {
    const { engine, contentLayer } = this.options;
    let entered = false;

    this.visibility.beginFrame();
    for (let i = 0; i < visibleIds.length; i++) {
      const connectorId = visibleIds[i];
      if (!isCommitted(connectorId)) continue;
      const runtimeConnector = engine.entityStore.getConnector(connectorId);
      if (!runtimeConnector || runtimeConnector.entity.style?.strokeWidth === 0) continue;
      const route = engine.getConnectorRoute(connectorId);
      if (!route) continue;

      const updated = renderConnector(contentLayer, {
        connector: runtimeConnector.entity,
        route,
        dataVersion: runtimeConnector.runtime.dataVersion,
        arrowMarkers: engine.arrowMarkers,
        existingCache: this.caches.get(connectorId),
        theme
      });
      if (updated.group.parent !== contentLayer) contentLayer.add(updated.group);
      this.caches.set(connectorId, updated);

      if (this.visibility.markShown(connectorId)) entered = true;
    }
    this.visibility.endFrame(
      (connectorId) => this.caches.get(connectorId)?.group.remove(),
      (connectorId) => this.destroy(connectorId)
    );
    return entered;
  }

  destroy(connectorId: string): void {
    this.visibility.forget(connectorId);
    this.options.stableOrder.release(connectorId);
    // 原生连线渲染器尚未接入，缓存中的图元均由默认线型创建，不交给原生 destroy 释放
    this.caches.get(connectorId)?.group.remove();
    this.caches.delete(connectorId);
  }

  destroyAll(): void {
    for (const connectorId of [...this.caches.keys()]) {
      this.destroy(connectorId);
    }
  }
}
