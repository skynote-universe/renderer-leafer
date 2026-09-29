/**
 * @file viewport-transform.ts
 * @description 视口坐标双向变换纯函数与像素对齐工具
 *
 * 遵守 AGENTS.md 准则：
 * 1. 纯函数设计：严禁就地篡改入参对象，必须返回新对象；
 * 2. 渲染端物理像素对齐：按设备像素比 DPR 做整数化对齐，确保线条像刀锋般锐利。
 */

import type { Point, RectBounds } from '@skynote/core';

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

/**
 * 屏幕/视口像素坐标 -> 世界逻辑坐标
 */
export function screenToWorld(screenPoint: Point, viewport: ViewportState): Point {
  const zoom = viewport.zoom === 0 ? 1 : viewport.zoom;
  return {
    x: (screenPoint.x - viewport.x) / zoom,
    y: (screenPoint.y - viewport.y) / zoom
  };
}

/**
 * 世界逻辑坐标 -> 屏幕/视口像素坐标
 */
export function worldToScreen(worldPoint: Point, viewport: ViewportState): Point {
  return {
    x: worldPoint.x * viewport.zoom + viewport.x,
    y: worldPoint.y * viewport.zoom + viewport.y
  };
}

/**
 * 计算当前视口在世界逻辑坐标系下的可视包围盒 (AABB)
 */
export function getViewportWorldBounds(viewport: ViewportState, viewWidth: number, viewHeight: number): RectBounds {
  const topLeft = screenToWorld({ x: 0, y: 0 }, viewport);
  const bottomRight = screenToWorld({ x: viewWidth, y: viewHeight }, viewport);
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;

  return {
    left: topLeft.x,
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y,
    width,
    height
  };
}

/**
 * 物理像素对齐：根据设备像素比 DPR 进行整数化吸附，防止 1px 细线模糊发虚
 */
export function snapToDevicePixel(value: number, dpr = 1): number {
  if (dpr <= 0) return Math.round(value);
  return Math.round(value * dpr) / dpr;
}

/**
 * 1px 线条居中半像素对齐：在奇数像素描边时微调 0.5px 确保落在硬件像素栅格正中
 */
export function snapHalfPixel(value: number, strokeWidth = 1, dpr = 1): number {
  const isOddStroke = Math.round(strokeWidth * dpr) % 2 === 1;
  const snapped = snapToDevicePixel(value, dpr);
  return isOddStroke ? snapped + 0.5 / dpr : snapped;
}

/**
 * 点到线段的几何欧氏距离纯函数 (用于连线拾取判定)
 */
export function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    return Math.sqrt(px * px + py * py);
  }

  // 投影比例 t 限制在 [0, 1]
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  const projX = start.x + t * dx;
  const projY = start.y + t * dy;
  const distDx = point.x - projX;
  const distDy = point.y - projY;

  return Math.sqrt(distDx * distDx + distDy * distDy);
}

/**
 * 点到连续折线段序列的最小距离纯函数
 */
export function distanceToPolyline(point: Point, points: readonly Point[]): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) {
    const dx = point.x - points[0].x;
    const dy = point.y - points[0].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  let minDistance = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distanceToSegment(point, points[i], points[i + 1]);
    if (d < minDistance) {
      minDistance = d;
    }
  }

  return minDistance;
}
