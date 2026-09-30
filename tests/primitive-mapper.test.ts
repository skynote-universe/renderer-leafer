import { describe, it, expect } from 'vitest';
import type { CanvasPrimitive } from '@skynote/core';

// 注入 Node 环境下缺失的 Canvas 全局变量，使 Leafer 在非浏览器环境中安全初始化
if (typeof globalThis.CanvasRenderingContext2D === 'undefined') {
  (globalThis as any).CanvasRenderingContext2D = class {};
}
if (typeof globalThis.Path2D === 'undefined') {
  (globalThis as any).Path2D = class {};
}
if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as any).ImageData = class {};
}
if (typeof (globalThis as any).document === 'undefined') {
  const mockCanvas = {
    getContext: () => ({
      measureText: () => ({ width: 100 }),
      clearRect: () => {},
      fillRect: () => {},
      drawImage: () => {}
    }),
    style: {}
  };
  (globalThis as any).document = {
    createElement: (tag: string) => (tag === 'canvas' ? mockCanvas : {}),
    body: { appendChild: () => {}, removeChild: () => {} }
  };
}
if (typeof (globalThis as any).Image === 'undefined') {
  (globalThis as any).Image = class {};
}
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis;
}
if (typeof (globalThis as any).navigator === 'undefined') {
  (globalThis as any).navigator = { userAgent: 'node' };
}
const eventClasses = [
  'PointerEvent',
  'MouseEvent',
  'WheelEvent',
  'KeyboardEvent',
  'TouchEvent',
  'DragEvent',
  'Event',
  'CustomEvent',
  'UIEvent'
];
for (const name of eventClasses) {
  if (typeof (globalThis as any)[name] === 'undefined') {
    (globalThis as any)[name] = class {};
  }
}
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  (globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 16);
}
if (typeof (globalThis as any).cancelAnimationFrame === 'undefined') {
  (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
}
if (typeof (globalThis as any).devicePixelRatio === 'undefined') {
  (globalThis as any).devicePixelRatio = 1;
}

const { Group, Rect, Text, Box, Image, Path } = await import('leafer');
type TextShape = InstanceType<typeof Text>;
type RectShape = InstanceType<typeof Rect>;
const { createLeaferShape, updateLeaferShape, reconcileLeaferShapes } =
  await import('../src/primitives/primitive-mapper');

describe('Primitive Mapper', () => {
  it('正确将 CanvasPrimitive 创建为 Leafer 图元，并映射文本高级排版属性', () => {
    const textPrimitive: CanvasPrimitive = {
      kind: 'text',
      x: 10,
      y: 20,
      text: 'SkyNote Architecture',
      fontSize: 16,
      textWrap: 'break-word',
      textDecoration: ['underline', 'line-through'],
      textOverflow: 'ellipsis'
    };

    const textShape = createLeaferShape(textPrimitive) as TextShape;
    expect(textShape).toBeInstanceOf(Text);
    expect(textShape.text).toBe('SkyNote Architecture');
    expect(textShape.x).toBe(10);
    expect(textShape.y).toBe(20);
    expect(textShape.textWrap).toBe('break');
    expect(textShape.textDecoration).toBe('under-delete');
    expect(textShape.textOverflow).toBe('ellipsis');
  });

  it('排版框宽或高为 0 的文字不绘制 (Leafer 会把 0 当作未设置而画成整段单行)，框恢复后重新显示', () => {
    const base: CanvasPrimitive = { kind: 'text', x: 0, y: 0, text: '很长的一段文字', width: 0, height: 20 };
    const shape = createLeaferShape(base) as TextShape;
    expect(shape.visible).toBe(false);
    updateLeaferShape(shape, { ...base, width: 50, height: 0 });
    expect(shape.visible).toBe(false);
    updateLeaferShape(shape, { ...base, width: 50 });
    expect(shape.visible).toBe(true);
    // 不限宽高 (适应内容) 照常绘制
    updateLeaferShape(shape, { ...base, width: undefined, height: undefined });
    expect(shape.visible).toBe(true);
  });

  it('updateLeaferShape 就地覆写已有图元，避免 GC 掉帧', () => {
    const rectShape = new Rect({ x: 0, y: 0, width: 100, height: 50, fill: '#FFFFFF' });
    const targetRect: CanvasPrimitive = {
      kind: 'rect',
      x: 20,
      y: 30,
      width: 200,
      height: 80,
      fill: '#FF0000'
    };

    const updated = updateLeaferShape(rectShape, targetRect);
    expect(updated).toBe(true);
    expect(rectShape.x).toBe(20);
    expect(rectShape.y).toBe(30);
    expect(rectShape.width).toBe(200);
    expect(rectShape.height).toBe(80);
    expect(rectShape.fill).toBe('#FF0000');

    // 类型不匹配时安全返回 false
    const mismatch = updateLeaferShape(rectShape, {
      kind: 'circle',
      cx: 10,
      cy: 10,
      r: 5
    });
    expect(mismatch).toBe(false);
  });

  it('updateLeaferShape 对 Box 和 Group 的 children 进行深度递归同步', () => {
    const boxShape = new Box({ x: 0, y: 0, width: 100, height: 100 });
    const childRect = new Rect({ x: 0, y: 0, width: 20, height: 20, fill: '#000000' });
    boxShape.add(childRect);

    const targetBox: CanvasPrimitive = {
      kind: 'box',
      x: 10,
      y: 10,
      width: 120,
      height: 120,
      children: [
        {
          kind: 'rect',
          x: 5,
          y: 5,
          width: 50,
          height: 50,
          fill: '#00FF00'
        }
      ]
    };

    const updated = updateLeaferShape(boxShape, targetBox);
    expect(updated).toBe(true);
    expect(boxShape.x).toBe(10);
    expect(boxShape.children.length).toBe(1);
    // 子图元被就地复用为新坐标与颜色
    const updatedChild = boxShape.children[0] as RectShape;
    expect(updatedChild).toBe(childRect);
    expect(updatedChild.x).toBe(5);
    expect(updatedChild.width).toBe(50);
    expect(updatedChild.fill).toBe('#00FF00');
  });

  it('reconcileLeaferShapes 保持严格层级索引顺序并按需增删替换', () => {
    const parent = new Group();
    const s0 = new Rect({ x: 0, y: 0, width: 10, height: 10 });
    const s1 = new Rect({ x: 10, y: 10, width: 20, height: 20 });
    parent.add(s0);
    parent.add(s1);

    // 将 s0 替换为 Text，s1 就地更新，并新增第三个图元
    const newPrimitives: CanvasPrimitive[] = [
      { kind: 'text', x: 0, y: 0, text: 'Replaced' },
      { kind: 'rect', x: 15, y: 15, width: 30, height: 30 },
      { kind: 'line', points: [0, 0, 100, 100] }
    ];

    const result = reconcileLeaferShapes(parent, [s0, s1], newPrimitives);
    expect(result.length).toBe(3);
    expect(parent.children.length).toBe(3);

    // 索引 0 被替换为 Text，且位于第 0 位 (层级未颠倒)
    expect(parent.children[0]).toBeInstanceOf(Text);
    expect((parent.children[0] as TextShape).text).toBe('Replaced');

    // 索引 1 就地复用原 s1 对象
    expect(parent.children[1]).toBe(s1);
    expect((parent.children[1] as RectShape).width).toBe(30);

    // 索引 2 为新增 Line
    expect(parent.children[2].tag).toBe('Line');
  });

  it('路径图元写入 Leafer 的 path 属性 (Leafer 没有 d 属性，写 d 时什么都不画)', () => {
    const shape = createLeaferShape({ kind: 'path', d: 'M 0 0 L 10 10', stroke: '#000000', fillRule: 'evenodd' });
    expect(shape).toBeInstanceOf(Path);
    expect((shape as InstanceType<typeof Path>).path).toBeDefined();
    expect((shape as unknown as { windingRule?: string }).windingRule).toBe('evenodd');
  });

  it('fillOpacity 转为纯色画笔的透明度，只淡化填充不影响描边', () => {
    const shape = createLeaferShape({
      kind: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fill: '#3366FF',
      fillOpacity: 0.08,
      stroke: '#3366FF'
    }) as RectShape;
    expect(shape.fill).toEqual({ type: 'solid', color: '#3366FF', opacity: 0.08 });
    expect(shape.stroke).toBe('#3366FF');
    expect(shape.opacity).toBe(1);
  });

  it('只复用同一个类的图元：图片继承自矩形、盒子继承自分组，也不能互相复用', () => {
    const image = new Image({ url: 'https://example.com/a.png', width: 10, height: 10 });
    expect(updateLeaferShape(image, { kind: 'rect', x: 0, y: 0, width: 10, height: 10 })).toBe(false);
    const box = new Box();
    expect(updateLeaferShape(box, { kind: 'group', children: [] })).toBe(false);
    expect(updateLeaferShape(new Group(), { kind: 'group', children: [] })).toBe(true);
  });
});
