/**
 * @file primitive-mapper.ts
 * @description 声明式图元 (CanvasPrimitive) → Leafer 图元：新建、就地更新与列表对齐
 *
 * 设计考量 (Why):
 * 1. 每种图元只有一份属性映射：新建是 new Shape(props)，更新是 shape.set(props)，两条路径不会分叉。
 * 2. 更新只复用同一个类的图元 (按构造函数精确匹配)：Image 继承 Rect、Box 继承 Group，用 instanceof 会把
 *    图片当矩形、盒子当分组复用，属性错位。
 * 3. 未设置的可选字段显式写入默认值 (如 opacity 为 1)，就地更新时不会残留上一次的值。
 * 4. 像素对齐由 Leafer 画布的 pixelSnap 在绘制时按屏幕像素完成，这里保持世界坐标原值。
 */

import type {
  CanvasPrimitive,
  FontWeight,
  LineHeight,
  OverflowMode,
  StrokeAlign,
  StrokeCap,
  StrokeJoin,
  TextDecoration,
  TextOverflow,
  TextWrap
} from '@skynote/core';
import { Box, Ellipse, Group, Image, Line, Path, Polygon, Rect, Text } from 'leafer';
import type { ISolidPaint, IUIInputData } from 'leafer';
import type { LeaferShape } from '../types';

type ShapeClass = new (props: IUIInputData) => LeaferShape;

/** 图元描述：对应的 Leafer 类与属性 */
interface ShapeSpec {
  readonly Shape: ShapeClass;
  readonly props: IUIInputData;
}

/** 可描边图元的公共字段 */
interface StrokeFields {
  stroke?: string;
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
const LEAFER_TEXT_WRAP: Record<TextWrap, 'normal' | 'none' | 'break'> = {
  normal: 'normal',
  none: 'none',
  'break-all': 'break',
  'break-word': 'break'
};
const LEAFER_TEXT_OVERFLOW: Record<TextOverflow, 'show' | 'hide' | 'ellipsis'> = {
  none: 'show',
  clip: 'hide',
  ellipsis: 'ellipsis'
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
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeDashArray: p.strokeDashArray,
    strokeCap: toLeaferStrokeCap(p.strokeCap),
    strokeJoin: p.strokeJoin,
    strokeAlign: p.strokeAlign
  };
}

/** 数字行高为字号倍数 → Leafer 百分比行高；'24px' → 像素值 */
function toLeaferLineHeight(lineHeight: LineHeight | undefined): IUIInputData['lineHeight'] {
  if (lineHeight === undefined) return undefined;
  return typeof lineHeight === 'number' ? { type: 'percent', value: lineHeight } : Number.parseFloat(lineHeight);
}

function toLeaferFontWeight(weight: FontWeight | undefined): IUIInputData['fontWeight'] {
  if (weight === 'bolder') return 'bold';
  if (weight === 'lighter') return 'normal';
  return weight;
}

function toLeaferTextDecoration(decoration: TextDecoration | undefined): 'none' | 'under' | 'delete' | 'under-delete' {
  const lines =
    decoration === undefined || decoration === 'none' ? [] : Array.isArray(decoration) ? decoration : [decoration];
  const under = lines.includes('underline');
  const strike = lines.includes('line-through');
  return under && strike ? 'under-delete' : under ? 'under' : strike ? 'delete' : 'none';
}

function describe(p: CanvasPrimitive): ShapeSpec {
  const opacity = p.opacity ?? 1;
  switch (p.kind) {
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
    case 'text':
      return {
        Shape: Text,
        props: {
          x: p.x,
          y: p.y,
          text: p.text,
          width: p.width,
          height: p.height,
          fontSize: p.fontSize ?? 14,
          fontFamily: p.fontFamily,
          fontWeight: toLeaferFontWeight(p.fontWeight),
          italic: p.fontStyle === 'italic',
          fill: p.fill,
          textAlign: p.textAlign,
          verticalAlign: p.verticalAlign,
          textBaseline: p.textBaseline,
          lineHeight: toLeaferLineHeight(p.lineHeight),
          letterSpacing: p.letterSpacing,
          textWrap: p.textWrap && LEAFER_TEXT_WRAP[p.textWrap],
          textDecoration: toLeaferTextDecoration(p.textDecoration),
          textOverflow: p.textOverflow && LEAFER_TEXT_OVERFLOW[p.textOverflow],
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
      return { Shape: Group, props: { x: p.x ?? 0, y: p.y ?? 0, rotation: p.rotation ?? 0, opacity } };
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
        }
      };
  }
}

/** 由图元新建 Leafer 图元 (含子图元) */
export function createLeaferShape(primitive: CanvasPrimitive): LeaferShape {
  const { Shape, props } = describe(primitive);
  const shape = new Shape(props);
  if (primitive.kind === 'group' || primitive.kind === 'box') {
    for (const child of primitive.children) (shape as Group).add(createLeaferShape(child));
  }
  return shape;
}

/**
 * 就地更新已有图元；类型不一致时返回 false，由调用方替换
 */
export function updateLeaferShape(shape: LeaferShape, primitive: CanvasPrimitive): boolean {
  const { Shape, props } = describe(primitive);
  if (shape.constructor !== Shape) return false;
  shape.set(props);
  if (primitive.kind === 'group' || primitive.kind === 'box') {
    const group = shape as Group;
    reconcileLeaferShapes(group, group.children as LeaferShape[], primitive.children);
  }
  return true;
}

/**
 * 按位置对齐图元列表：同位置同类型就地更新，否则替换；多余的移除，不足的补齐
 * @returns 对齐后的图元列表 (与 primitives 一一对应)
 */
export function reconcileLeaferShapes(
  parent: Group,
  existing: readonly LeaferShape[],
  primitives: readonly CanvasPrimitive[]
): LeaferShape[] {
  const result: LeaferShape[] = [];
  for (let i = 0; i < primitives.length; i++) {
    const shape = existing[i];
    if (shape && updateLeaferShape(shape, primitives[i])) {
      result.push(shape);
      continue;
    }
    shape?.remove();
    const created = createLeaferShape(primitives[i]);
    parent.addAt(created, i);
    result.push(created);
  }
  for (let i = primitives.length; i < existing.length; i++) existing[i].remove();
  return result;
}
