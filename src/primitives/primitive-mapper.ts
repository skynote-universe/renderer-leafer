/**
 * @file primitive-mapper.ts
 * @description 声明式图元 (CanvasPrimitive) → Leafer 图元：新建、就地更新与列表对齐
 *
 * 设计考量 (Why):
 * 1. 每种图元只有一份描述 (类 + 属性 + 子描述)：新建是 new Shape(props)，更新是 shape.set(props)，两条路径不会分叉。
 * 2. 更新只复用同一个类的图元 (按构造函数精确匹配)：Image 继承 Rect、Box 继承 Group，用 instanceof 会把
 *    图片当矩形、盒子当分组复用，属性错位。
 * 3. 未设置的可选字段显式写入默认值 (如 opacity 为 1)，就地更新时不会残留上一次的值。
 * 4. 文字不交给 Leafer 排版：按内核排版结果 (layoutText) 逐片段绘制单行 Text，背景色画在片段下方；
 *    片段的 y 由基线反推 (Leafer 单行文字的基线在行框内的位置与内核基线模型一致)，混排字号也按基线对齐 (ADR-122)。
 * 5. 像素对齐由 Leafer 画布的 pixelSnap 在绘制时按屏幕像素完成，这里保持世界坐标原值。
 */

// 带透明度的纯色 (fillOpacity / strokeOpacity 映射为 { type: 'solid', color, opacity }) 需要颜色插件把字符串颜色解析为 RGBA；
// leafer-ui 本体缺少它时会忽略透明度、整块画成不透明色 (如框选背景、半透明填充)
import '@leafer-in/color';
import {
  layoutText,
  type CanvasPrimitive,
  type FontMeasurer,
  type OverflowMode,
  type StrokeAlign,
  type StrokeCap,
  type StrokeJoin,
  type TextFragment,
  type TextPrimitive
} from '@skynote/core';
import { Box, Ellipse, Group, Image, Line, Path, Polygon, Rect, Text } from 'leafer-ui';
import type { ISolidPaint, IUIInputData } from 'leafer-ui';
import type { LeaferShape } from '../types';
import { toLeaferFontWeight } from '../text/leafer-font-measurer';

type ShapeClass = new (props: IUIInputData) => LeaferShape;

/** 图元描述：对应的 Leafer 类、属性与子图元描述 (分组、盒子与文字片段) */
interface ShapeSpec {
  readonly Shape: ShapeClass;
  readonly props: IUIInputData;
  readonly children?: readonly ShapeSpec[];
}

/** 可描边图元的公共字段 */
interface StrokeFields {
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeDashArray?: number[];
  strokeCap?: StrokeCap;
  strokeJoin?: StrokeJoin;
  strokeAlign?: StrokeAlign;
}

const LEAFER_STROKE_CAP: Record<StrokeCap, 'round' | 'square' | 'none'> = {
  butt: 'none',
  round: 'round',
  square: 'square'
};
const LEAFER_OVERFLOW: Record<OverflowMode, 'show' | 'hide'> = { visible: 'show', hidden: 'hide' };

/** 描边端点映射 (连线图元同样使用) */
export function toLeaferStrokeCap(cap: StrokeCap | undefined): 'round' | 'square' | 'none' | undefined {
  return cap && LEAFER_STROKE_CAP[cap];
}

/** 填充：带独立透明度时转为纯色画笔，只淡化填充而不影响描边 */
function paint(color: string | undefined, opacity: number | undefined): string | ISolidPaint | undefined {
  return color !== undefined && opacity !== undefined ? { type: 'solid', color, opacity } : color;
}

function strokeProps(p: StrokeFields): IUIInputData {
  return {
    stroke: paint(p.stroke, p.strokeOpacity),
    strokeWidth: p.strokeWidth,
    // Leafer 的虚线属性名为 dashPattern
    dashPattern: p.strokeDashArray,
    strokeCap: toLeaferStrokeCap(p.strokeCap),
    strokeJoin: p.strokeJoin,
    strokeAlign: p.strokeAlign
  };
}

/** 单行文字片段：y 由基线反推 (Leafer 单行文字基线距行框顶 (行高 + 0.7 × 字号) / 2) */
function describeFragment(fragment: TextFragment, baseline: number): ShapeSpec {
  const { style } = fragment;
  const { font } = style;
  return {
    Shape: Text,
    props: {
      x: fragment.x,
      y: baseline - (style.lineHeight + font.size * 0.7) / 2,
      text: fragment.text,
      fontSize: font.size,
      fontFamily: font.family,
      fontWeight: toLeaferFontWeight(font.weight),
      italic: font.style !== 'normal',
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      fill: style.color,
      textDecoration: style.underline
        ? style.lineThrough
          ? 'under-delete'
          : 'under'
        : style.lineThrough
          ? 'delete'
          : 'none'
    }
  };
}

function describe(p: CanvasPrimitive, fonts: FontMeasurer): ShapeSpec {
  const opacity = p.opacity ?? 1;
  switch (p.kind) {
    case 'text':
      return describeText(p, fonts);
    case 'rect':
      return {
        Shape: Rect,
        props: {
          x: p.x,
          y: p.y,
          width: Math.max(0, p.width),
          height: Math.max(0, p.height),
          fill: paint(p.fill, p.fillOpacity),
          ...strokeProps(p),
          cornerRadius: p.radius,
          opacity
        }
      };
    case 'circle':
      return {
        Shape: Ellipse,
        props: {
          x: p.cx - p.r,
          y: p.cy - p.r,
          width: p.r * 2,
          height: p.r * 2,
          rotation: 0,
          fill: paint(p.fill, p.fillOpacity),
          ...strokeProps(p),
          opacity
        }
      };
    case 'ellipse':
      return {
        Shape: Ellipse,
        props: {
          x: p.cx - p.rx,
          y: p.cy - p.ry,
          width: p.rx * 2,
          height: p.ry * 2,
          rotation: p.rotation ?? 0,
          fill: paint(p.fill, p.fillOpacity),
          ...strokeProps(p),
          opacity
        }
      };
    case 'polygon':
      return {
        Shape: Polygon,
        props: {
          points: p.points,
          fill: paint(p.fill, p.fillOpacity),
          ...strokeProps(p),
          cornerRadius: p.cornerRadius,
          opacity
        }
      };
    case 'path':
      return {
        Shape: Path,
        props: {
          // Leafer 的路径属性名为 path (没有 d)
          path: p.d,
          windingRule: p.fillRule,
          fill: paint(p.fill, p.fillOpacity),
          ...strokeProps(p),
          opacity
        }
      };
    case 'line':
      return {
        Shape: Line,
        props: {
          points: p.points,
          ...strokeProps(p),
          strokeWidth: p.strokeWidth ?? 1,
          cornerRadius: p.cornerRadius,
          opacity
        }
      };
    case 'image':
      return {
        Shape: Image,
        props: {
          url: p.url,
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
          cornerRadius: p.radius,
          opacity
        }
      };
    case 'group':
      return {
        Shape: Group,
        props: { x: p.x ?? 0, y: p.y ?? 0, rotation: p.rotation ?? 0, opacity },
        children: p.children.map((child) => describe(child, fonts))
      };
    case 'box':
      return {
        Shape: Box,
        props: {
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
          rotation: p.rotation ?? 0,
          fill: paint(p.fill, p.fillOpacity),
          ...strokeProps(p),
          cornerRadius: p.radius,
          overflow: LEAFER_OVERFLOW[p.overflow ?? 'visible'],
          opacity
        },
        children: p.children.map((child) => describe(child, fonts))
      };
  }
}

/** 文字：按内核排版逐行逐片段展开，背景色矩形在前 (位于文字下方) */
function describeText(p: TextPrimitive, fonts: FontMeasurer): ShapeSpec {
  const layout = layoutText(p.runs, p.style, { width: p.width, height: p.height }, fonts);
  const backgrounds: ShapeSpec[] = [];
  const fragments: ShapeSpec[] = [];
  for (const line of layout.lines) {
    for (const fragment of line.fragments) {
      if (fragment.style.backgroundColor) {
        backgrounds.push({
          Shape: Rect,
          props: {
            x: fragment.x,
            y: line.top,
            width: fragment.width,
            height: line.height,
            fill: fragment.style.backgroundColor
          }
        });
      }
      fragments.push(describeFragment(fragment, line.baseline));
    }
  }
  const children = [...backgrounds, ...fragments];
  const opacity = p.opacity ?? 1;
  // 编辑时在框内滚动，或声明了截断 (clip / ellipsis) 的固定高度文字：裁剪到文本框；其余照常显示
  const clips = p.height !== undefined && (p.scrollY !== undefined || (p.style.textOverflow ?? 'none') !== 'none');
  if (!clips) {
    return { Shape: Group, props: { x: p.x, y: p.y, rotation: 0, opacity }, children };
  }
  return {
    Shape: Box,
    props: {
      x: p.x,
      y: p.y,
      width: p.width ?? layout.width,
      height: p.height!,
      rotation: 0,
      overflow: 'hide',
      opacity
    },
    children: [{ Shape: Group, props: { x: 0, y: -(p.scrollY ?? 0), rotation: 0, opacity: 1 }, children }]
  };
}

function build(spec: ShapeSpec): LeaferShape {
  const shape = new spec.Shape(spec.props);
  if (spec.children) for (const child of spec.children) (shape as Group).add(build(child));
  return shape;
}

/** 就地更新；类不一致时返回 false，由调用方替换 */
function apply(shape: LeaferShape, spec: ShapeSpec): boolean {
  if (shape.constructor !== spec.Shape) return false;
  shape.set(spec.props);
  if (spec.children) {
    const group = shape as Group;
    reconcile(group, group.children as LeaferShape[], spec.children);
  }
  return true;
}

function reconcile(parent: Group, existing: readonly LeaferShape[], specs: readonly ShapeSpec[]): LeaferShape[] {
  // 浅拷贝快照：避免遍历与就地 remove/addAt 时受底层 children 数组动态变化的影响 (防跳项漏删)
  const oldShapes = [...existing];
  const result: LeaferShape[] = [];
  for (let i = 0; i < specs.length; i++) {
    const shape = oldShapes[i];
    if (shape && apply(shape, specs[i])) {
      result.push(shape);
      continue;
    }
    shape?.remove();
    const created = build(specs[i]);
    parent.addAt(created, i);
    result.push(created);
  }
  for (let i = specs.length; i < oldShapes.length; i++) {
    oldShapes[i]?.remove();
  }
  return result;
}

/** 图元映射器：持有字体测量器，文字按内核排版绘制 */
export class PrimitiveMapper {
  constructor(private readonly fonts: FontMeasurer) {}

  /** 由图元新建 Leafer 图元 (含子图元) */
  create(primitive: CanvasPrimitive): LeaferShape {
    return build(describe(primitive, this.fonts));
  }

  /** 就地更新已有图元；类型不一致时返回 false，由调用方替换 */
  update(shape: LeaferShape, primitive: CanvasPrimitive): boolean {
    return apply(shape, describe(primitive, this.fonts));
  }

  /**
   * 按位置对齐图元列表：同位置同类型就地更新，否则替换；多余的移除，不足的补齐
   * @returns 对齐后的图元列表 (与 primitives 一一对应)
   */
  reconcile(parent: Group, existing: readonly LeaferShape[], primitives: readonly CanvasPrimitive[]): LeaferShape[] {
    return reconcile(
      parent,
      existing,
      primitives.map((primitive) => describe(primitive, this.fonts))
    );
  }
}
