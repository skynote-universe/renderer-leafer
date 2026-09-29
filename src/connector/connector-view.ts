/**
 * @file connector-view.ts
 * @description 单条连线的原生图元：折线与两端箭头，按需就地更新
 *
 * 设计考量 (Why):
 * 1. 路由由 core 引擎统一求解 (engine.getConnectorRoute)，这里只负责绘制，箭头定义来自 ArrowMarkerRegistry；
 * 2. 引用守卫 (Fast Path)：路由对象、数据版本与主题均未变化时直接跳过，0 运算 0 GC；
 * 3. 端点箭头后撤 (lineOffset)：沿切线方向把线端点收回，避免粗线条穿透箭头尖端；
 * 4. 就地复用：折线与箭头图元创建后只覆写属性，箭头取消时隐藏而非销毁，再次启用时直接复用。
 */

import type {
  ArrowMarkerDefinition,
  ArrowMarkerFillRule,
  ArrowMarkerRegistry,
  CanvasTheme,
  ComputedRoute,
  ConnectorEntity,
  Matrix2D,
  Point,
  StrokeCap
} from '@skynote/core';
import { invertMatrix, resolveThemeColor } from '@skynote/core';
import { Group, Line, Path } from 'leafer';

export interface ConnectorViewInput {
  connector: ConnectorEntity;
  /** 引擎求解的当前路由 (连线自身或两端节点几何变化时整体替换) */
  route: ComputedRoute;
  dataVersion: number;
  arrowMarkers: ArrowMarkerRegistry;
  /** 未设置描边色的连线取 connectorStroke，空心箭头取画布底色 */
  theme: CanvasTheme;
}

type MarkerEnd = 'start' | 'end';

interface StrokePaint {
  color: string;
  width: number;
  background: string;
}

const LEAFER_STROKE_CAP: Record<StrokeCap, 'round' | 'square' | 'none'> = {
  round: 'round',
  square: 'square',
  butt: 'none'
};

function resolveMarkerFill(rule: ArrowMarkerFillRule | undefined, paint: StrokePaint): string | undefined {
  if (rule === 'none') return undefined;
  return rule === 'match-background' ? paint.background : paint.color;
}

export class ConnectorView {
  readonly group = new Group();
  readonly line = new Line();
  private readonly markers: Record<MarkerEnd, Path | null> = { start: null, end: null };
  private drawnPoints: readonly Point[] = [];
  private route: ComputedRoute | null = null;
  private dataVersion = -1;
  private theme: CanvasTheme | null = null;
  /** undefined 表示尚未设置过，与 null (挂在根内容层) 区分 */
  private containerTransform: Matrix2D | null | undefined = undefined;

  constructor() {
    this.group.add(this.line);
  }

  /** 实际绘制的折线点集 (两端已按箭头后撤) */
  get points(): readonly Point[] {
    return this.drawnPoints;
  }

  get startMarker(): Path | null {
    return this.markers.start;
  }

  get endMarker(): Path | null {
    return this.markers.end;
  }

  /** @returns 是否实际重绘 (Fast Path 命中时为 false) */
  update(input: ConnectorViewInput): boolean {
    const { connector, route, dataVersion, arrowMarkers, theme } = input;
    if (route === this.route && dataVersion === this.dataVersion && theme === this.theme) return false;

    const style = connector.style;
    const paint: StrokePaint = {
      color: resolveThemeColor(style?.stroke, theme, theme.connectorStroke)!,
      width: style?.strokeWidth ?? 2,
      background: theme.background
    };
    // 箭头后撤会改写两端点，复制一份绘制用点集，保持路由缓存不可变
    const points = route.points.map((p) => ({ x: p.x, y: p.y }));
    const last = points.length - 1;
    points[0] = this.syncMarker('start', style?.startArrow, arrowMarkers, points[0], points[1], paint);
    points[last] = this.syncMarker('end', style?.endArrow, arrowMarkers, points[last], points[last - 1], paint);

    const flatPoints: number[] = [];
    for (const p of points) flatPoints.push(p.x, p.y);
    this.line.set({
      points: flatPoints,
      stroke: paint.color,
      strokeWidth: paint.width,
      strokeDashArray: style?.strokeDashArray,
      strokeCap: style?.strokeCap && LEAFER_STROKE_CAP[style.strokeCap],
      strokeJoin: style?.strokeJoin,
      cornerRadius: style?.cornerRadius
    });

    this.drawnPoints = points;
    this.route = route;
    this.dataVersion = dataVersion;
    this.theme = theme;
    return true;
  }

  /**
   * 挂载容器的世界矩阵变化时调用 (按引用比较)；null 表示挂在根内容层
   * 图元设为容器世界矩阵的逆，抵消容器变换，路由点因此保持世界坐标
   */
  setContainerTransform(transform: Matrix2D | null): void {
    if (transform === this.containerTransform) return;
    const inverse = transform && invertMatrix(transform);
    this.group.set(
      inverse
        ? { x: inverse.e, y: inverse.f, rotation: (Math.atan2(inverse.b, inverse.a) * 180) / Math.PI }
        : { x: 0, y: 0, rotation: 0 }
    );
    this.containerTransform = transform;
  }

  destroy(): void {
    this.group.destroy();
  }

  /**
   * 放置一端箭头，尖端落在路由端点、朝向沿末段切线
   * @returns 该端折线应绘制到的点 (有箭头时后撤 lineOffset)
   */
  private syncMarker(
    end: MarkerEnd,
    arrow: boolean | string | undefined,
    registry: ArrowMarkerRegistry,
    tip: Point,
    neighbor: Point | undefined,
    paint: StrokePaint
  ): Point {
    const marker: ArrowMarkerDefinition | undefined = arrow
      ? registry.get(typeof arrow === 'string' ? arrow : 'standard:arrow')
      : undefined;
    const existing = this.markers[end];
    if (!marker || !neighbor) {
      if (existing) existing.visible = false;
      return tip;
    }

    const dx = tip.x - neighbor.x;
    const dy = tip.y - neighbor.y;
    const props = {
      visible: true,
      x: tip.x,
      y: tip.y,
      rotation: (Math.atan2(dy, dx) * 180) / Math.PI,
      d: marker.d,
      fill: resolveMarkerFill(marker.fillRule, paint),
      stroke: paint.color,
      strokeWidth: paint.width
    };
    if (existing) {
      existing.set(props);
    } else {
      const created = new Path(props);
      this.group.add(created);
      this.markers[end] = created;
    }

    const len = Math.sqrt(dx * dx + dy * dy);
    const offset = marker.lineOffset;
    if (offset <= 0 || len <= offset) return tip;
    return { x: tip.x - (dx / len) * offset, y: tip.y - (dy / len) * offset };
  }
}
