/**
 * @file connector-renderer.ts
 * @description 连线与端点标记原生渲染器 (ConnectorRenderer)
 *
 * 遵守核心架构分层与性能军规：
 * 1. 路由由 core 引擎统一求解 (engine.getConnectorRoute)，本文件只负责绘制，箭头定义来自 ArrowMarkerRegistry；
 * 2. 引用守卫 (Fast Path)：路由对象、数据版本与主题均未变化时直接复用缓存，0 运算 0 GC；
 * 3. 端点箭头后撤 (lineOffset)：根据切线方向计算端点后撤向量，彻底解决粗线条穿透箭头尖端的问题；
 * 4. 就地复用：连线 Line 与两端 Path 箭头采用对象池化覆写，杜绝无谓 GC 掉帧。
 */

import type {
  ConnectorEntity,
  ComputedRoute,
  Point,
  StrokeCap,
  ArrowMarkerFillRule,
  ArrowMarkerRegistry,
  ArrowMarkerDefinition,
  CanvasTheme
} from '@skynote/core';
import { resolveThemeColor } from '@skynote/core';
import { Group, Line, Path } from 'leafer';
import type { ConnectorRenderCache } from '../types';

export interface ConnectorRenderOptions {
  connector: ConnectorEntity;
  /** 引擎求解的当前路由 (连线自身或两端节点几何变化时整体替换) */
  route: ComputedRoute;
  dataVersion: number;
  arrowMarkers: ArrowMarkerRegistry;
  existingCache?: ConnectorRenderCache;
  /** 当前主题：未设置描边色的连线取 connectorStroke，空心箭头取画布底色 */
  theme: CanvasTheme;
}

type LeaferStrokeCap = 'round' | 'square' | 'none';

function toLeaferStrokeCap(cap?: StrokeCap): LeaferStrokeCap | undefined {
  if (!cap) return undefined;
  if (cap === 'butt') return 'none';
  return cap as LeaferStrokeCap;
}

/**
 * 解析端点箭头 Marker 定义
 */
function resolveMarker(
  arrowValue: boolean | string | undefined,
  registry: ArrowMarkerRegistry
): ArrowMarkerDefinition | undefined {
  if (!arrowValue) return undefined;
  const markerId = typeof arrowValue === 'string' ? arrowValue : 'standard:arrow';
  return registry.get(markerId);
}

/**
 * 解析箭头填充颜色 (严格遵循 ArrowMarkerFillRule 规范)
 */
function resolveMarkerFill(
  rule: ArrowMarkerFillRule | undefined,
  strokeColor: string,
  backgroundColor: string
): string | undefined {
  if (rule === 'none') return undefined;
  if (rule === 'match-background') return backgroundColor;
  return strokeColor;
}

/**
 * 创建或就地更新连线图元与端点箭头
 */
export function renderConnector(parentGroup: Group, options: ConnectorRenderOptions): ConnectorRenderCache {
  const { connector, route, dataVersion, arrowMarkers, existingCache, theme } = options;

  // 极速快慢分支 (Fast Path)：路由、属性与主题均未变化时直接复用已有图元
  if (
    existingCache &&
    existingCache.route === route &&
    existingCache.dataVersion === dataVersion &&
    existingCache.theme === theme
  ) {
    return existingCache;
  }

  const rawStart = route.points[0];
  const rawEnd = route.points[route.points.length - 1];
  // 箭头后撤会改写两端点，复制一份绘制用点集，保持路由缓存不可变
  const computedPoints: Point[] = route.points.map((p) => ({ x: p.x, y: p.y }));

  const strokeColor = resolveThemeColor(connector.style?.stroke, theme, theme.connectorStroke)!;
  const strokeWidth = connector.style?.strokeWidth ?? 2;
  const strokeDashArray = connector.style?.strokeDashArray;

  // 2. 端点箭头解析与切线后撤计算 (Line Offset)
  const startMarker = resolveMarker(connector.style?.startArrow, arrowMarkers);
  const endMarker = resolveMarker(connector.style?.endArrow, arrowMarkers);

  let startMarkerAngle = 0;
  if (startMarker && computedPoints.length >= 2) {
    const p0 = computedPoints[0];
    const p1 = computedPoints[1];
    const dx = p0.x - p1.x;
    const dy = p0.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    startMarkerAngle = (Math.atan2(dy, dx) * 180) / Math.PI;

    if (len > startMarker.lineOffset && startMarker.lineOffset > 0) {
      computedPoints[0] = {
        x: p0.x - (dx / len) * startMarker.lineOffset,
        y: p0.y - (dy / len) * startMarker.lineOffset
      };
    }
  }

  let endMarkerAngle = 0;
  if (endMarker && computedPoints.length >= 2) {
    const lastIdx = computedPoints.length - 1;
    const pn = computedPoints[lastIdx];
    const prev = computedPoints[lastIdx - 1];
    const dx = pn.x - prev.x;
    const dy = pn.y - prev.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    endMarkerAngle = (Math.atan2(dy, dx) * 180) / Math.PI;

    if (len > endMarker.lineOffset && endMarker.lineOffset > 0) {
      computedPoints[lastIdx] = {
        x: pn.x - (dx / len) * endMarker.lineOffset,
        y: pn.y - (dy / len) * endMarker.lineOffset
      };
    }
  }

  // 扁平化折线点序列
  const flatPoints: number[] = [];
  for (let i = 0; i < computedPoints.length; i++) {
    flatPoints.push(computedPoints[i].x, computedPoints[i].y);
  }

  // 3. 就地复用已有图元
  if (existingCache && existingCache.lineShape instanceof Line) {
    existingCache.group.visible = true;
    existingCache.lineShape.set({
      points: flatPoints,
      stroke: strokeColor,
      strokeWidth,
      strokeDashArray,
      strokeCap: toLeaferStrokeCap(connector.style?.strokeCap),
      strokeJoin: connector.style?.strokeJoin,
      cornerRadius: connector.style?.cornerRadius
    });

    // 起点箭头复用/更新
    if (startMarker) {
      const fill = resolveMarkerFill(startMarker.fillRule, strokeColor, theme.background);
      if (existingCache.startMarkerShape instanceof Path) {
        existingCache.startMarkerShape.visible = true;
        existingCache.startMarkerShape.set({
          x: rawStart.x,
          y: rawStart.y,
          rotation: startMarkerAngle,
          d: startMarker.d,
          fill,
          stroke: strokeColor,
          strokeWidth
        });
      } else {
        const marker = new Path({
          x: rawStart.x,
          y: rawStart.y,
          rotation: startMarkerAngle,
          d: startMarker.d,
          fill,
          stroke: strokeColor,
          strokeWidth
        });
        existingCache.group.add(marker);
        existingCache.startMarkerShape = marker;
      }
    } else if (existingCache.startMarkerShape) {
      existingCache.startMarkerShape.visible = false;
    }

    // 终点箭头复用/更新
    if (endMarker) {
      const fill = resolveMarkerFill(endMarker.fillRule, strokeColor, theme.background);
      if (existingCache.endMarkerShape instanceof Path) {
        existingCache.endMarkerShape.visible = true;
        existingCache.endMarkerShape.set({
          x: rawEnd.x,
          y: rawEnd.y,
          rotation: endMarkerAngle,
          d: endMarker.d,
          fill,
          stroke: strokeColor,
          strokeWidth
        });
      } else {
        const marker = new Path({
          x: rawEnd.x,
          y: rawEnd.y,
          rotation: endMarkerAngle,
          d: endMarker.d,
          fill,
          stroke: strokeColor,
          strokeWidth
        });
        existingCache.group.add(marker);
        existingCache.endMarkerShape = marker;
      }
    } else if (existingCache.endMarkerShape) {
      existingCache.endMarkerShape.visible = false;
    }

    existingCache.route = route;
    existingCache.dataVersion = dataVersion;
    existingCache.computedPoints = computedPoints;
    existingCache.connector = connector;
    existingCache.theme = theme;
    return existingCache;
  }

  // 4. 全新创建连线容器
  const group = new Group();
  const lineShape = new Line({
    points: flatPoints,
    stroke: strokeColor,
    strokeWidth,
    strokeDashArray,
    strokeCap: toLeaferStrokeCap(connector.style?.strokeCap),
    strokeJoin: connector.style?.strokeJoin,
    cornerRadius: connector.style?.cornerRadius
  });
  group.add(lineShape);

  let startMarkerShape: Path | undefined;
  if (startMarker) {
    startMarkerShape = new Path({
      x: rawStart.x,
      y: rawStart.y,
      rotation: startMarkerAngle,
      d: startMarker.d,
      fill: resolveMarkerFill(startMarker.fillRule, strokeColor, theme.background),
      stroke: strokeColor,
      strokeWidth
    });
    group.add(startMarkerShape);
  }

  let endMarkerShape: Path | undefined;
  if (endMarker) {
    endMarkerShape = new Path({
      x: rawEnd.x,
      y: rawEnd.y,
      rotation: endMarkerAngle,
      d: endMarker.d,
      fill: resolveMarkerFill(endMarker.fillRule, strokeColor, theme.background),
      stroke: strokeColor,
      strokeWidth
    });
    group.add(endMarkerShape);
  }

  parentGroup.add(group);

  return {
    group,
    lineShape,
    startMarkerShape,
    endMarkerShape,
    route,
    dataVersion,
    computedPoints,
    connector,
    theme,
    containerTransform: null
  };
}
