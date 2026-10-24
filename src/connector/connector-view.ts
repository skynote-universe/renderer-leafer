/**
 * @file connector-view.ts
 * @description 单条连线的原生图元：折线与两端箭头，按需就地更新
 *
 * 设计考量 (Why):
 * 1. 路由由 core 引擎统一求解 (engine.getConnectorRoute)，这里只负责绘制，箭头定义来自 ArrowMarkerRegistry；
 * 2. 引用守卫 (Fast Path)：路由对象、数据版本与主题均未变化时直接跳过，0 运算 0 GC；
 * 3. 箭头随线宽放大；端点箭头后撤 (lineOffset，同比放大)：沿折线把线端收回，避免粗线条穿透箭头尖端；曲线的采样段很短，按路径长度回收而不是只看末段；
 * 4. 就地复用：折线与箭头图元创建后只覆写属性，箭头取消时隐藏而非销毁，再次启用时直接复用。
 * 5. 连线文字按路由中的排版绘制 (与拾取、编辑同一份)，底色遮住文字下面的线；编辑中的文字换成编辑视图
 *    (插入输入法组合文字、随输入伸展)，与节点文字的编辑同一函数。
 */

import type {
  ArrowMarkerDefinition,
  ArrowMarkerFillRule,
  ArrowMarkerRegistry,
  CanvasTheme,
  CanvasPrimitive,
  ComputedRoute,
  ConnectorStyle,
  FontMeasurer,
  Matrix2D,
  Point,
  TextEditingTarget
} from '@skynote/core';
import { applyThemeToPrimitives, displayedConnectorLabel, invertMatrix, resolveThemeColor } from '@skynote/core';
import { Group, Line, Path } from 'leafer-ui';
import { toLeaferStrokeCap, type PrimitiveMapper } from '../primitives/primitive-mapper';
import type { LeaferShape } from '../types';

export interface ConnectorViewInput {
  /** 生效样式 (路由器默认样式 < 连线自身样式，见 resolveConnectorStyle) */
  style: ConnectorStyle;
  /** 引擎求解的当前路由 (连线自身或两端节点几何变化时整体替换) */
  route: ComputedRoute;
  /** 连线实体的版本 (几何版本:数据版本)：样式、线型与文字变化时不一定改变路由，须按实体版本判断是否重画 */
  version: string;
  arrowMarkers: ArrowMarkerRegistry;
  /** 未设置描边色的连线取 connectorStroke，空心箭头取画布底色 */
  theme: CanvasTheme;
  /** 正在编辑的本连线文字；不是本连线时为 null */
  editing: TextEditingTarget | null;
  /** 编辑中文字的排版 (随输入伸展的底色)；未注入时按路由中的排版 */
  fonts: FontMeasurer | null;
}

/** 文字底色的圆角 */
const LABEL_RADIUS = 4;

type MarkerEnd = 'start' | 'end';

interface StrokePaint {
  color: string;
  width: number;
  background: string;
}

function resolveMarkerFill(rule: ArrowMarkerFillRule | undefined, paint: StrokePaint): string | undefined {
  if (rule === 'none') return undefined;
  return rule === 'match-background' ? paint.background : paint.color;
}

export class ConnectorView {
  readonly group = new Group();
  readonly line = new Line();
  /** 连线文字 (底色与文字)，在线之上 */
  readonly labels = new Group();
  private labelShapes: LeaferShape[] = [];
  private editing: TextEditingTarget | null = null;
  private readonly markers: Record<MarkerEnd, Path | null> = { start: null, end: null };
  private drawnPoints: readonly Point[] = [];
  private route: ComputedRoute | null = null;
  private version = '';
  private theme: CanvasTheme | null = null;
  /** undefined 表示尚未设置过，与 null (挂在根内容层) 区分 */
  private containerTransform: Matrix2D | null | undefined = undefined;

  constructor(private readonly mapper: PrimitiveMapper) {
    this.group.add(this.line);
    this.group.add(this.labels);
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
    const { style, route, version, arrowMarkers, theme, editing } = input;
    if (route === this.route && version === this.version && theme === this.theme && editing === this.editing) {
      return false;
    }

    const paint: StrokePaint = {
      color: resolveThemeColor(style.stroke, theme, theme.connectorStroke)!,
      width: style.strokeWidth ?? 2,
      background: theme.background
    };
    // 箭头后撤会裁掉两端，在副本上进行，保持路由缓存不可变
    let points: Point[] = route.points.map((p) => ({ x: p.x, y: p.y }));
    points = this.syncMarker('start', style.startArrow, arrowMarkers, points.slice().reverse(), paint).reverse();
    points = this.syncMarker('end', style.endArrow, arrowMarkers, points, paint);

    const flatPoints: number[] = [];
    for (const p of points) flatPoints.push(p.x, p.y);
    this.line.set({
      points: flatPoints,
      stroke: paint.color,
      strokeWidth: paint.width,
      dashPattern: style.strokeDashArray,
      strokeCap: toLeaferStrokeCap(style.strokeCap),
      strokeJoin: style.strokeJoin,
      cornerRadius: style.cornerRadius
    });

    this.labelShapes = this.mapper.reconcile(this.labels, this.labelShapes, this.labelPrimitives(input));

    this.drawnPoints = points;
    this.route = route;
    this.version = version;
    this.theme = theme;
    this.editing = editing;
    return true;
  }

  /** 每段文字：底色 + 文字；编辑中的那段按编辑视图排版，底色随输入伸展 */
  private labelPrimitives({ route, theme, editing, fonts }: ConnectorViewInput): CanvasPrimitive[] {
    const primitives: CanvasPrimitive[] = [];
    for (const label of route.labels) {
      const { primitive, bounds } = displayedConnectorLabel(label, editing, fonts);
      primitives.push(
        {
          kind: 'rect',
          x: bounds.left,
          y: bounds.top,
          width: bounds.right - bounds.left,
          height: bounds.bottom - bounds.top,
          fill: theme.background,
          radius: LABEL_RADIUS
        },
        primitive
      );
    }
    return applyThemeToPrimitives(primitives, theme);
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
   * 放置折线末端 (points 的最后一点) 的箭头：尖端落在端点，朝向取回退 lineOffset 处指向端点的方向
   * @returns 末端按 lineOffset 沿折线裁短后的点集；没有箭头时原样返回
   */
  private syncMarker(
    end: MarkerEnd,
    arrow: boolean | string | undefined,
    registry: ArrowMarkerRegistry,
    points: Point[],
    paint: StrokePaint
  ): Point[] {
    const marker: ArrowMarkerDefinition | undefined = arrow
      ? registry.get(typeof arrow === 'string' ? arrow : 'standard:arrow')
      : undefined;
    const existing = this.markers[end];
    if (!marker || points.length < 2) {
      if (existing) existing.visible = false;
      return points;
    }

    const tip = points[points.length - 1];
    // 箭头随线宽放大 (按 2 像素线设计)：粗线配小箭头会被线身淹没；描边宽度反向缩放，画出来仍与线身同宽
    const scale = Math.max(1, paint.width / 2);
    const trimmed = trimPolylineEnd(points, marker.lineOffset * scale);
    // 回退点与尖端重合 (无后撤或线太短) 时按末段定朝向
    let base = trimmed[trimmed.length - 1];
    if (base.x === tip.x && base.y === tip.y) base = points[points.length - 2];
    const props = {
      visible: true,
      x: tip.x,
      y: tip.y,
      rotation: (Math.atan2(tip.y - base.y, tip.x - base.x) * 180) / Math.PI,
      // Leafer 的路径属性名为 path (没有 d)
      path: marker.d,
      scaleX: scale,
      scaleY: scale,
      fill: resolveMarkerFill(marker.fillRule, paint),
      stroke: paint.color,
      strokeWidth: paint.width / scale,
      // 圆角接头：开放箭头的尖角在粗线下不会刺出端点
      strokeJoin: 'round' as const,
      strokeCap: 'round' as const
    };
    if (existing) {
      existing.set(props);
    } else {
      const created = new Path(props);
      this.group.add(created);
      this.markers[end] = created;
    }
    return trimmed;
  }
}

/** 沿折线从末端回收 distance 长度；整条线短于回收长度时保持原样 (线藏在箭头下) */
function trimPolylineEnd(points: readonly Point[], distance: number): Point[] {
  if (distance <= 0) return points.slice();
  let remaining = distance;
  for (let i = points.length - 1; i > 0; i--) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > remaining) {
      const t = (length - remaining) / length;
      return [...points.slice(0, i), { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }];
    }
    remaining -= length;
  }
  return points.slice();
}
