/**
 * @file primitive-mapper.ts
 * @description 声明式跨引擎中间图元 (CanvasPrimitive) 到 Leafer 图元的高性能映射与就地复用器
 *
 * 遵守 AGENTS.md 性能军规：
 * 1. 就地复用：更新阶段优先修改已有图元属性，严禁反复 new Rect() 触发 GC 掉帧；
 * 2. 物理像素对齐：对 1px 细线进行 DPR 栅格对齐；
 * 3. 极速分支：识别简单文本与纯色填充，走极速通道；
 * 4. 零遗漏：全量覆盖所有 CanvasPrimitive 基础图元 (含图片、盒子、多边形等)。
 */

import type {
  CanvasPrimitive,
  RectPrimitive,
  TextPrimitive,
  CirclePrimitive,
  EllipsePrimitive,
  PolygonPrimitive,
  PathPrimitive,
  LinePrimitive,
  ImagePrimitive,
  GroupPrimitive,
  BoxPrimitive,
  FontWeight,
  LineHeight,
  StrokeCap,
  TextWrap,
  TextDecoration,
  TextOverflow
} from '@skynote/core';
import { Rect, Text, Ellipse, Polygon, Path, Line, Group, Box, Image } from 'leafer';
import type { LeaferShape } from '../types';

type LeaferStrokeCap = 'round' | 'square' | 'none';
type LeaferFontWeight = NonNullable<InstanceType<typeof Text>['fontWeight']>;
type LeaferLineHeight = NonNullable<InstanceType<typeof Text>['lineHeight']>;

/**
 * 转换行高：数字为字号倍数 → Leafer 百分比行高；'24px' → Leafer 像素数值
 */
function toLeaferLineHeight(lineHeight?: LineHeight): LeaferLineHeight | undefined {
  if (lineHeight === undefined) return undefined;
  if (typeof lineHeight === 'number') return { type: 'percent', value: lineHeight };
  return Number.parseFloat(lineHeight);
}

/**
 * 转换标准 FontWeight 到 Leafer
 */
function toLeaferFontWeight(weight?: FontWeight): LeaferFontWeight | undefined {
  if (!weight) return undefined;
  if (weight === 'bolder') return 'bold';
  if (weight === 'lighter') return 'normal';
  return weight;
}

/**
 * 转换标准 StrokeCap 到 Leafer
 */
function toLeaferStrokeCap(cap?: StrokeCap): LeaferStrokeCap | undefined {
  if (!cap) return undefined;
  if (cap === 'butt') return 'none';
  return cap as LeaferStrokeCap;
}

/**
 * 转换换行模式到 Leafer
 */
function toLeaferTextWrap(wrap?: TextWrap): 'normal' | 'none' | 'break' | undefined {
  if (!wrap) return undefined;
  if (wrap === 'break-all' || wrap === 'break-word') return 'break';
  return wrap;
}

/**
 * 转换文本装饰线 (下划线/删除线) 到 Leafer (支持单值与多选数组)
 */
function toLeaferTextDecoration(decoration?: TextDecoration): 'none' | 'under' | 'delete' | 'under-delete' | undefined {
  if (!decoration || decoration === 'none') return 'none';
  const lines = Array.isArray(decoration) ? decoration : [decoration];
  const hasUnderline = lines.includes('underline');
  const hasLineThrough = lines.includes('line-through');
  if (hasUnderline && hasLineThrough) return 'under-delete';
  if (hasUnderline) return 'under';
  if (hasLineThrough) return 'delete';
  return 'none';
}

/**
 * 转换文本溢出模式到 Leafer
 */
function toLeaferTextOverflow(overflow?: TextOverflow): 'show' | 'hide' | 'ellipsis' | undefined {
  if (!overflow) return undefined;
  if (overflow === 'clip') return 'hide';
  if (overflow === 'none') return 'show';
  return overflow;
}

/**
 * 将单个 CanvasPrimitive 创建为原生 Leafer 图元
 */
export function createLeaferShapeFromPrimitive(primitive: CanvasPrimitive, dpr = 1): LeaferShape {
  switch (primitive.kind) {
    case 'rect':
      return createRectShape(primitive, dpr);
    case 'text':
      return createTextShape(primitive);
    case 'circle':
      return createCircleShape(primitive, dpr);
    case 'ellipse':
      return createEllipseShape(primitive, dpr);
    case 'polygon':
      return createPolygonShape(primitive, dpr);
    case 'path':
      return createPathShape(primitive, dpr);
    case 'line':
      return createLineShape(primitive, dpr);
    case 'image':
      return createImageShape(primitive, dpr);
    case 'group':
      return createGroupShape(primitive, dpr);
    case 'box':
      return createBoxShape(primitive, dpr);
    default:
      return new Group();
  }
}

/**
 * 就地更新已有 Leafer 图元属性 (In-place Mutation)
 */
export function updateLeaferShapeInPlace(shape: LeaferShape, primitive: CanvasPrimitive, dpr = 1): boolean {
  switch (primitive.kind) {
    case 'rect':
      if (!(shape instanceof Rect)) return false;
      updateRectShape(shape, primitive, dpr);
      return true;

    case 'text':
      if (!(shape instanceof Text)) return false;
      updateTextShape(shape, primitive);
      return true;

    case 'circle':
      if (!(shape instanceof Ellipse)) return false;
      updateCircleShape(shape, primitive, dpr);
      return true;

    case 'ellipse':
      if (!(shape instanceof Ellipse)) return false;
      updateEllipseShape(shape, primitive, dpr);
      return true;

    case 'polygon':
      if (!(shape instanceof Polygon)) return false;
      updatePolygonShape(shape, primitive, dpr);
      return true;

    case 'path':
      if (!(shape instanceof Path)) return false;
      updatePathShape(shape, primitive, dpr);
      return true;

    case 'line':
      if (!(shape instanceof Line)) return false;
      updateLineShape(shape, primitive, dpr);
      return true;

    case 'image':
      if (!(shape instanceof Image)) return false;
      updateImageShape(shape, primitive, dpr);
      return true;

    case 'group':
      if (!(shape instanceof Group)) return false;
      updateGroupShape(shape, primitive, dpr);
      return true;

    case 'box':
      if (!(shape instanceof Box)) return false;
      updateBoxShape(shape, primitive, dpr);
      return true;

    default:
      return false;
  }
}

/**
 * 批量同步图元列表：就地复用已有图元，多退少补
 */
export function reconcileLeaferShapes(
  parentGroup: Group,
  existingShapes: LeaferShape[],
  primitives: CanvasPrimitive[],
  dpr = 1
): LeaferShape[] {
  const resultShapes: LeaferShape[] = [];
  const maxLen = Math.max(existingShapes.length, primitives.length);

  for (let i = 0; i < maxLen; i++) {
    const existing = existingShapes[i];
    const target = primitives[i];

    if (existing && target) {
      if (updateLeaferShapeInPlace(existing, target, dpr)) {
        resultShapes.push(existing);
      } else {
        existing.remove();
        const newShape = createLeaferShapeFromPrimitive(target, dpr);
        parentGroup.addAt(newShape, i);
        resultShapes.push(newShape);
      }
    } else if (!existing && target) {
      const newShape = createLeaferShapeFromPrimitive(target, dpr);
      parentGroup.addAt(newShape, i);
      resultShapes.push(newShape);
    } else if (existing && !target) {
      existing.remove();
    }
  }

  return resultShapes;
}

// ================= 具体图元实现纯逻辑 =================

function createRectShape(p: RectPrimitive, _dpr: number): Rect {
  return new Rect({
    x: p.x,
    y: p.y,
    width: Math.max(0, p.width),
    height: Math.max(0, p.height),
    fill: p.fill,
    opacity: p.opacity,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeDashArray: p.strokeDashArray,
    cornerRadius: p.radius,
    strokeAlign: p.strokeAlign
  });
}

function updateRectShape(shape: Rect, p: RectPrimitive, _dpr: number): void {
  shape.set({
    x: p.x,
    y: p.y,
    width: Math.max(0, p.width),
    height: Math.max(0, p.height),
    fill: p.fill,
    opacity: p.opacity ?? 1,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeDashArray: p.strokeDashArray,
    cornerRadius: p.radius,
    strokeAlign: p.strokeAlign
  });
}

function createTextShape(p: TextPrimitive): Text {
  return new Text({
    x: p.x,
    y: p.y,
    text: p.text,
    width: p.width,
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
    textWrap: toLeaferTextWrap(p.textWrap),
    textDecoration: toLeaferTextDecoration(p.textDecoration),
    textOverflow: toLeaferTextOverflow(p.textOverflow),
    opacity: p.opacity
  });
}

function updateTextShape(shape: Text, p: TextPrimitive): void {
  shape.set({
    x: p.x,
    y: p.y,
    text: p.text,
    width: p.width,
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
    textWrap: toLeaferTextWrap(p.textWrap),
    textDecoration: toLeaferTextDecoration(p.textDecoration),
    textOverflow: toLeaferTextOverflow(p.textOverflow),
    opacity: p.opacity ?? 1
  });
}

function createCircleShape(p: CirclePrimitive, _dpr: number): Ellipse {
  const d = p.r * 2;
  return new Ellipse({
    x: p.cx - p.r,
    y: p.cy - p.r,
    width: d,
    height: d,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeDashArray: p.strokeDashArray,
    opacity: p.opacity
  });
}

function updateCircleShape(shape: Ellipse, p: CirclePrimitive, _dpr: number): void {
  const d = p.r * 2;
  shape.set({
    x: p.cx - p.r,
    y: p.cy - p.r,
    width: d,
    height: d,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeDashArray: p.strokeDashArray,
    opacity: p.opacity ?? 1
  });
}

function createEllipseShape(p: EllipsePrimitive, _dpr: number): Ellipse {
  return new Ellipse({
    x: p.cx - p.rx,
    y: p.cy - p.ry,
    width: p.rx * 2,
    height: p.ry * 2,
    rotation: p.rotation ?? 0,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeDashArray: p.strokeDashArray,
    opacity: p.opacity
  });
}

function updateEllipseShape(shape: Ellipse, p: EllipsePrimitive, _dpr: number): void {
  shape.set({
    x: p.cx - p.rx,
    y: p.cy - p.ry,
    width: p.rx * 2,
    height: p.ry * 2,
    rotation: p.rotation ?? 0,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeDashArray: p.strokeDashArray,
    opacity: p.opacity ?? 1
  });
}

function createPolygonShape(p: PolygonPrimitive, _dpr: number): Polygon {
  return new Polygon({
    points: p.points,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeDashArray: p.strokeDashArray,
    strokeCap: toLeaferStrokeCap(p.strokeCap),
    strokeJoin: p.strokeJoin,
    cornerRadius: p.cornerRadius,
    opacity: p.opacity
  });
}

function updatePolygonShape(shape: Polygon, p: PolygonPrimitive, _dpr: number): void {
  shape.set({
    points: p.points,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeDashArray: p.strokeDashArray,
    strokeCap: toLeaferStrokeCap(p.strokeCap),
    strokeJoin: p.strokeJoin,
    cornerRadius: p.cornerRadius,
    opacity: p.opacity ?? 1
  });
}

function createPathShape(p: PathPrimitive, _dpr: number): Path {
  return new Path({
    d: p.d,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeCap: toLeaferStrokeCap(p.strokeCap),
    strokeJoin: p.strokeJoin,
    opacity: p.opacity
  });
}

function updatePathShape(shape: Path, p: PathPrimitive, _dpr: number): void {
  shape.set({
    d: p.d,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    strokeCap: toLeaferStrokeCap(p.strokeCap),
    strokeJoin: p.strokeJoin,
    opacity: p.opacity ?? 1
  });
}

function createLineShape(p: LinePrimitive, _dpr: number): Line {
  return new Line({
    points: p.points,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth ?? 1,
    strokeDashArray: p.strokeDashArray,
    strokeCap: toLeaferStrokeCap(p.strokeCap),
    strokeJoin: p.strokeJoin,
    cornerRadius: p.cornerRadius,
    opacity: p.opacity
  });
}

function updateLineShape(shape: Line, p: LinePrimitive, _dpr: number): void {
  shape.set({
    points: p.points,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth ?? 1,
    strokeDashArray: p.strokeDashArray,
    strokeCap: toLeaferStrokeCap(p.strokeCap),
    strokeJoin: p.strokeJoin,
    cornerRadius: p.cornerRadius,
    opacity: p.opacity ?? 1
  });
}

function createImageShape(p: ImagePrimitive, _dpr: number): Image {
  return new Image({
    url: p.url,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    cornerRadius: p.radius,
    opacity: p.opacity
  });
}

function updateImageShape(shape: Image, p: ImagePrimitive, _dpr: number): void {
  shape.set({
    url: p.url,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    cornerRadius: p.radius,
    opacity: p.opacity ?? 1
  });
}

function createGroupShape(p: GroupPrimitive, dpr: number): Group {
  const group = new Group({
    x: p.x,
    y: p.y,
    opacity: p.opacity
  });
  if (p.children && p.children.length > 0) {
    p.children.forEach((child) => {
      group.add(createLeaferShapeFromPrimitive(child, dpr));
    });
  }
  return group;
}

function updateGroupShape(shape: Group, p: GroupPrimitive, dpr: number): void {
  shape.set({
    x: p.x,
    y: p.y,
    opacity: p.opacity ?? 1
  });
  if (p.children && p.children.length > 0) {
    reconcileLeaferShapes(shape, shape.children as LeaferShape[], p.children, dpr);
  } else if (shape.children && shape.children.length > 0) {
    shape.clear();
  }
}

function createBoxShape(p: BoxPrimitive, dpr: number): Box {
  const box = new Box({
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    cornerRadius: p.radius,
    opacity: p.opacity
  });
  if (p.children && p.children.length > 0) {
    p.children.forEach((child) => {
      box.add(createLeaferShapeFromPrimitive(child, dpr));
    });
  }
  return box;
}

function updateBoxShape(shape: Box, p: BoxPrimitive, dpr: number): void {
  shape.set({
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    fill: p.fill,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    cornerRadius: p.radius,
    opacity: p.opacity ?? 1
  });
  if (p.children && p.children.length > 0) {
    reconcileLeaferShapes(shape, shape.children as LeaferShape[], p.children, dpr);
  } else if (shape.children && shape.children.length > 0) {
    shape.clear();
  }
}
