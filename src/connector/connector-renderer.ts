/**
 * @file connector-renderer.ts
 * @description 连线与端点标记原生渲染器 (ConnectorRenderer)
 * 
 * 遵守核心架构分层与性能军规：
 * 1. 算法与路由收敛于 core 的 ConnectorRouterRegistry 与 ArrowMarkerRegistry；
 * 2. 双版本号与端点签名守卫 (Fast Path)：当连线属性及两端节点几何未变更时，直接返回已有缓存，0 运算 0 GC；
 * 3. 端点箭头后撤 (lineOffset)：根据切线方向计算端点后撤向量，彻底解决粗线条穿透箭头尖端的问题；
 * 4. 就地复用：连线 Line 与两端 Path 箭头采用对象池化覆写，杜绝无谓 GC 掉帧。
 */

import type {
  ConnectorEntity,
  NodeEntity,
  Point,
  StrokeCap,
  ArrowMarkerFillRule,
  ConnectorRouterRegistry,
  ArrowMarkerRegistry,
  ArrowMarkerDefinition,
  CanvasTheme
} from '@skynote/core';
import { resolveThemeColor } from '@skynote/core';
import { Group, Line, Path } from 'leafer';
import type { ConnectorRenderCache } from '../types';

export interface ConnectorRenderOptions {
  connector: ConnectorEntity;
  geomVersion: number;
  dataVersion: number;
  fromNode?: NodeEntity;
  toNode?: NodeEntity;
  fromNodeGeomVersion?: number;
  toNodeGeomVersion?: number;
  routers: ConnectorRouterRegistry;
  arrowMarkers: ArrowMarkerRegistry;
  existingCache?: ConnectorRenderCache;
  dpr?: number;
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
 * 求解端点世界坐标 (优先自由坐标，其次根据 anchorId 求解吸附点，兜底节点中心)
 */
function resolveEndpoint(
  endpoint: { position?: Point; nodeId?: string; anchorId?: string },
  node?: NodeEntity
): Point {
  if (endpoint.position) {
    return { ...endpoint.position };
  }
  if (node) {
    if (endpoint.anchorId && node.anchors && node.anchors.length > 0) {
      const anchor = node.anchors.find(a => a.id === endpoint.anchorId);
      if (anchor) {
        // 归一化比例 (0~1) 或绝对偏移解算
        const relX = anchor.x <= 1 && anchor.x >= 0 ? node.width * anchor.x : anchor.x;
        const relY = anchor.y <= 1 && anchor.y >= 0 ? node.height * anchor.y : anchor.y;
        return {
          x: node.x + relX,
          y: node.y + relY
        };
      }
    }
    return {
      x: node.x + node.width / 2,
      y: node.y + node.height / 2
    };
  }
  return { x: 0, y: 0 };
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
export function renderConnector(
  parentGroup: Group,
  options: ConnectorRenderOptions
): ConnectorRenderCache {
  const {
    connector,
    geomVersion,
    dataVersion,
    fromNode,
    toNode,
    fromNodeGeomVersion = 0,
    toNodeGeomVersion = 0,
    routers,
    arrowMarkers,
    existingCache,
    theme
  } = options;

  // 端点全景几何签名：涵盖节点 ID、锚点 ID、版本号及自由坐标，杜绝锚点切换时不触发重绘
  const currentSignature = `${connector.from.nodeId ?? ''}:${connector.from.anchorId ?? ''}:${fromNodeGeomVersion}:${connector.from.position?.x ?? ''},${connector.from.position?.y ?? ''}:${connector.to.nodeId ?? ''}:${connector.to.anchorId ?? ''}:${toNodeGeomVersion}:${connector.to.position?.x ?? ''},${connector.to.position?.y ?? ''}`;

  // 极速快慢分支 (Fast Path)：如果连线属性和两端点均未发生改变，直接复用已有图元
  if (
    existingCache &&
    existingCache.geomVersion === geomVersion &&
    existingCache.dataVersion === dataVersion &&
    existingCache.endpointsSignature === currentSignature &&
    existingCache.theme === theme
  ) {
    existingCache.group.visible = true;
    return existingCache;
  }

  const rawStart = resolveEndpoint(connector.from, fromNode);
  const rawEnd = resolveEndpoint(connector.to, toNode);

  // 1. 通过 Core 的 Router 求解连线路径
  const router = routers.get(connector.connectorType);
  let computedPoints: Point[] = [];

  if (router) {
    const routeResult = router.route({
      startPoint: rawStart,
      endPoint: rawEnd,
      controlPoints: connector.controlPoints,
      style: connector.style,
      connector
    });
    computedPoints = routeResult.points.map(p => ({ ...p }));
  } else if (connector.controlPoints && connector.controlPoints.length >= 2) {
    computedPoints = connector.controlPoints.map(p => ({ ...p }));
  } else {
    computedPoints = [{ ...rawStart }, { ...rawEnd }];
  }

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

    existingCache.geomVersion = geomVersion;
    existingCache.dataVersion = dataVersion;
    existingCache.endpointsSignature = currentSignature;
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
    geomVersion,
    dataVersion,
    endpointsSignature: currentSignature,
    computedPoints,
    connector,
    theme
  };
}
