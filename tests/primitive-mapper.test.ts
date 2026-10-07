import { describe, it, expect } from 'vitest';
import type { CanvasPrimitive } from '@skynote/core';
import type { Text } from 'leafer';

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

const { Group, Rect, Box, Image, Path } = await import('leafer');
type TextShape = Text;
type RectShape = InstanceType<typeof Rect>;
const { PrimitiveMapper } = await import('../src/primitives/primitive-mapper');

/** 替身字体测量：每个码点宽 = 字号 × 0.5 */
const mapper = new PrimitiveMapper({ measureWidth: (text, font) => [...text].length * font.size * 0.5 });
const createLeaferShape = (primitive: CanvasPrimitive) => mapper.create(primitive);
const updateLeaferShape = (shape: Parameters<typeof mapper.update>[0], primitive: CanvasPrimitive) =>
  mapper.update(shape, primitive);

describe('Primitive Mapper', () => {
  it('文字按内核排版逐片段绘制：分段样式、装饰线与背景色 (背景在文字下方)', () => {
    const textPrimitive: CanvasPrimitive = {
      kind: 'text',
      x: 10,
      y: 20,
      runs: [
        { text: 'Sky' },
        { text: 'Note', fontWeight: 'bold', textDecoration: ['underline', 'line-through'], backgroundColor: '#FF0000' }
      ],
      style: { fontSize: 16, color: '#111111' }
    };

    const group = createLeaferShape(textPrimitive) as InstanceType<typeof Group>;
    expect(group).toBeInstanceOf(Group);
    expect(group.x).toBe(10);
    expect(group.y).toBe(20);
    const [background, sky, note] = group.children as [RectShape, TextShape, TextShape];
    expect(background).toBeInstanceOf(Rect);
    expect(background).toMatchObject({ x: 24, y: 0, width: 32, height: 24, fill: '#FF0000' });
    expect(sky).toMatchObject({ text: 'Sky', x: 0, fontSize: 16, fill: '#111111', textDecoration: 'none' });
    expect(note).toMatchObject({ text: 'Note', x: 24, fontWeight: 'bold', textDecoration: 'under-delete' });
  });

  it('混排字号按基线对齐：各片段在 Leafer 中的基线 (y + (行高 + 0.7 × 字号) / 2) 相同', () => {
    const group = createLeaferShape({
      kind: 'text',
      x: 0,
      y: 0,
      runs: [{ text: 'a' }, { text: 'B', fontSize: 40 }],
      style: { fontSize: 20 }
    }) as InstanceType<typeof Group>;
    const baselines = (group.children as TextShape[]).map(
      (text) => text.y! + ((text.lineHeight as number) + text.fontSize! * 0.7) / 2
    );
    expect(baselines[0]).toBeCloseTo(baselines[1]);
  });

  it('带 scrollY 的文字 (画布内编辑且超出文本框) 放进裁剪盒，内容上移 scrollY', () => {
    const shape = createLeaferShape({
      kind: 'text',
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      scrollY: 15,
      runs: [{ text: 'a' }],
      style: { fontSize: 20 }
    }) as InstanceType<typeof Box>;
    expect(shape).toBeInstanceOf(Box);
    expect(shape).toMatchObject({ x: 10, y: 20, width: 100, height: 40, overflow: 'hide' });
    const content = shape.children[0] as InstanceType<typeof Group>;
    expect(content.y).toBe(-15);
    expect((content.children[0] as TextShape).text).toBe('a');
  });

  it('单行不折行文字在编辑态 (textOverflow: none) 溢出时不进裁剪盒，保持 Group 完整可见', () => {
    const shape = createLeaferShape({
      kind: 'text',
      x: 0,
      y: -20,
      width: 100,
      height: 20,
      runs: [{ text: '超出画框宽度的很长很长标题' }],
      style: { fontSize: 12, textWrap: 'none', textOverflow: 'none' }
    });
    expect(shape).toBeInstanceOf(Group);
  });

  it('固定高度文字：textOverflow 为 none 时照常显示 (Group)，声明截断时裁剪到文本框 (Box)', () => {
    const visibleShape = createLeaferShape({
      kind: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      runs: [{ text: '溢出文字' }],
      style: { textOverflow: 'none' }
    });
    expect(visibleShape).toBeInstanceOf(Group);

    const hiddenShape = createLeaferShape({
      kind: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      runs: [{ text: '溢出文字' }],
      style: { textOverflow: 'clip' }
    }) as InstanceType<typeof Box>;
    expect(hiddenShape).toBeInstanceOf(Box);
    expect(hiddenShape.overflow).toBe('hide');
  });

  it('排版框宽或高为 0 时没有放文字的空间，不绘制任何片段；框恢复后重新绘制', () => {
    const base: CanvasPrimitive = { kind: 'text', x: 0, y: 0, runs: [{ text: '很长的一段文字' }], style: {}, width: 0 };
    const group = createLeaferShape(base) as InstanceType<typeof Group>;
    expect(group.children).toHaveLength(0);
    updateLeaferShape(group, { ...base, width: 500 });
    expect(group.children).toHaveLength(1);
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

  it('reconcile 保持严格层级索引顺序并按需增删替换', () => {
    const parent = new Group();
    const s0 = new Rect({ x: 0, y: 0, width: 10, height: 10 });
    const s1 = new Rect({ x: 10, y: 10, width: 20, height: 20 });
    parent.add(s0);
    parent.add(s1);

    // 将 s0 替换为 Text，s1 就地更新，并新增第三个图元
    const newPrimitives: CanvasPrimitive[] = [
      { kind: 'text', x: 0, y: 0, runs: [{ text: 'Replaced' }], style: {} },
      { kind: 'rect', x: 15, y: 15, width: 30, height: 30 },
      { kind: 'line', points: [0, 0, 100, 100] }
    ];

    const result = mapper.reconcile(parent, [s0, s1], newPrimitives);
    expect(result.length).toBe(3);
    expect(parent.children.length).toBe(3);

    // 索引 0 被替换为文字分组，且位于第 0 位 (层级未颠倒)
    const text = parent.children[0] as InstanceType<typeof Group>;
    expect(text).toBeInstanceOf(Group);
    expect((text.children[0] as TextShape).text).toBe('Replaced');

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

  it('strokeOpacity 转为描边纯色画笔的透明度，不影响填充', () => {
    const shape = createLeaferShape({
      kind: 'polygon',
      points: [0, 0, 10, 0, 5, 10],
      fill: '#FFFFFF',
      stroke: '#3366FF',
      strokeOpacity: 0.4
    }) as RectShape;
    expect(shape.stroke).toEqual({ type: 'solid', color: '#3366FF', opacity: 0.4 });
    expect(shape.fill).toBe('#FFFFFF');
  });

  it('只复用同一个类的图元：图片继承自矩形、盒子继承自分组，也不能互相复用', () => {
    const image = new Image({ url: 'https://example.com/a.png', width: 10, height: 10 });
    expect(updateLeaferShape(image, { kind: 'rect', x: 0, y: 0, width: 10, height: 10 })).toBe(false);
    const box = new Box();
    expect(updateLeaferShape(box, { kind: 'group', children: [] })).toBe(false);
    expect(updateLeaferShape(new Group(), { kind: 'group', children: [] })).toBe(true);
  });

  it('文字由多分段合并为单分段时，多余的旧图元彻底删除无残留 (杜绝文字重叠残影)', () => {
    // 模拟输入法组合状态：有 3 个文字片段 (前缀、拼音、后缀)
    const textGroup = createLeaferShape({
      kind: 'text',
      x: 0,
      y: 0,
      runs: [{ text: '文' }, { text: "s's'd'd's", textDecoration: ['underline'] }, { text: '本' }],
      style: { fontSize: 16 }
    }) as InstanceType<typeof Group>;

    expect(textGroup.children.length).toBe(3);

    // 模拟确认输入法后：合并为 1 个连续文本片段
    const updated = updateLeaferShape(textGroup, {
      kind: 'text',
      x: 0,
      y: 0,
      runs: [{ text: '文实打实大苏打杀杀杀杀杀闪烁本' }],
      style: { fontSize: 16 }
    });

    expect(updated).toBe(true);
    // 必须只剩下 1 个图元，旧的拼音与旧的“本”字必须全部被 remove，绝无残留
    expect(textGroup.children.length).toBe(1);
    expect((textGroup.children[0] as TextShape).text).toBe('文实打实大苏打杀杀杀杀杀闪烁本');
  });
});
