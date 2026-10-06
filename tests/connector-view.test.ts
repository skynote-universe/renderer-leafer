import { describe, it, expect } from 'vitest';
import type { ConnectorEntity } from '@skynote/core';
import {
  ConnectorRouterRegistry,
  ArrowMarkerRegistry,
  deriveCanvasTheme,
  LIGHT_CANVAS_THEME_SEED,
  computeConnectorRoute,
  computeNodeLocalMatrix,
  resolveNodeOutline
} from '@skynote/core';
import type { NodeEntity } from '@skynote/core';

// 连线渲染需显式提供主题：未设置描边色时取 connectorStroke，空心箭头取画布底色
const TEST_THEME = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });

/** 路由由内核引擎求解，渲染器只负责绘制：测试中直接调用同一纯函数构造路由 */
function routeOf(connector: ConnectorEntity, nodes: Record<string, NodeEntity> = {}, withFonts = false) {
  const resolveNode = (id: string) =>
    nodes[id] && {
      node: nodes[id],
      worldMatrix: computeNodeLocalMatrix(nodes[id]),
      outline: resolveNodeOutline(nodes[id], undefined),
      strokeWidth: 0
    };
  return computeConnectorRoute(connector, resolveNode, new ConnectorRouterRegistry(), withFonts ? fonts : null)!;
}

// 注入 Node 环境 Canvas 全局 mock 以供 Leafer 静态初始化
if (typeof (globalThis as any).CanvasRenderingContext2D === 'undefined') {
  (globalThis as any).CanvasRenderingContext2D = class {};
}
if (typeof (globalThis as any).Path2D === 'undefined') {
  (globalThis as any).Path2D = class {};
}
if (typeof (globalThis as any).ImageData === 'undefined') {
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

const { Path } = await import('leafer');
const { ConnectorView } = await import('../src/connector/connector-view');
const { PrimitiveMapper } = await import('../src/primitives/primitive-mapper');
const fonts = { measureWidth: (text: string, font: { size: number }) => [...text].length * font.size * 0.5 };
const mapper = new PrimitiveMapper(fonts);

describe('ConnectorView', () => {
  it('正确创建基础直连线与端点箭头后撤计算', () => {
    const arrowMarkers = new ArrowMarkerRegistry();

    const connector: ConnectorEntity = {
      id: 'conn-1',
      type: 'connector',
      zIndex: 'a0',
      locked: false,
      connectorType: 'straight',
      from: { position: { x: 0, y: 0 } },
      to: { position: { x: 100, y: 0 } },
      style: {
        stroke: '#FF0000',
        strokeWidth: 2,
        endArrow: true
      }
    };

    const view = new ConnectorView(mapper);
    view.update({
      theme: TEST_THEME,
      editing: null,
      fonts: null,
      style: connector.style ?? {},
      route: routeOf(connector),
      version: '1',
      arrowMarkers
    });

    expect(view.endMarker).toBeInstanceOf(Path);
    expect(view.startMarker).toBeNull();

    // 终点箭头切线水平向右 (0 度)，终点坐标在端点后撤 lineOffset (默认 8px) 之后向内收敛为 92px
    expect(view.points.length).toBe(2);
    expect(view.points[0]).toEqual({ x: 0, y: 0 });
    expect(view.points[1].x).toBeCloseTo(92, 1);
    expect(view.points[1].y).toBeCloseTo(0, 1);
  });

  it('Fast Path 守卫：路由、属性与主题均未变化时跳过重绘', () => {
    const arrowMarkers = new ArrowMarkerRegistry();

    const connector: ConnectorEntity = {
      id: 'conn-fast',
      type: 'connector',
      zIndex: 'a0',
      locked: false,
      connectorType: 'straight',
      from: { position: { x: 10, y: 10 } },
      to: { position: { x: 50, y: 50 } }
    };

    const route = routeOf(connector);
    const view = new ConnectorView(mapper);
    const input = {
      theme: TEST_THEME,
      editing: null,
      fonts: null,
      style: connector.style ?? {},
      route,
      version: '1',
      arrowMarkers
    };
    expect(view.update(input)).toBe(true);
    const points = view.points;

    expect(view.update(input)).toBe(false);
    expect(view.points).toBe(points);
    expect(view.update({ ...input, version: '2' })).toBe(true);
  });

  it('动态增补箭头：原连线无箭头，后续增改属性时安全就地补全 Path', () => {
    const arrowMarkers = new ArrowMarkerRegistry();

    const connectorNoArrow: ConnectorEntity = {
      id: 'conn-dynamic',
      type: 'connector',
      zIndex: 'a0',
      locked: false,
      connectorType: 'straight',
      from: { position: { x: 0, y: 0 } },
      to: { position: { x: 200, y: 0 } }
    };

    const view = new ConnectorView(mapper);
    const route = routeOf(connectorNoArrow);
    view.update({
      theme: TEST_THEME,
      editing: null,
      fonts: null,
      style: connectorNoArrow.style ?? {},
      route,
      version: '1',
      arrowMarkers
    });
    expect(view.startMarker).toBeNull();
    expect(view.endMarker).toBeNull();

    // 变为带有起点与终点箭头
    const connectorWithArrows: ConnectorEntity = {
      ...connectorNoArrow,
      style: {
        startArrow: true,
        endArrow: true
      }
    };

    view.update({
      theme: TEST_THEME,
      editing: null,
      fonts: null,
      style: connectorWithArrows.style ?? {},
      route,
      version: '2',
      arrowMarkers
    });
    const { startMarker, endMarker } = view;
    expect(startMarker).toBeInstanceOf(Path);
    expect(endMarker).toBeInstanceOf(Path);
    expect(view.group.children.length).toBe(4); // Line + 文字层 + startMarker + endMarker

    // 取消箭头只隐藏，再次启用时复用同一图元
    view.update({
      theme: TEST_THEME,
      editing: null,
      fonts: null,
      style: connectorNoArrow.style ?? {},
      route,
      version: '3',
      arrowMarkers
    });
    expect(startMarker!.visible).toBe(false);
    view.update({
      theme: TEST_THEME,
      editing: null,
      fonts: null,
      style: connectorWithArrows.style ?? {},
      route,
      version: '4',
      arrowMarkers
    });
    expect(view.startMarker).toBe(startMarker);
    expect(startMarker!.visible).toBe(true);
    expect(view.group.children.length).toBe(4);
  });

  it('固定端按比例落在节点边框上与空心三角箭头 (match-background) 底色填充', () => {
    const arrowMarkers = new ArrowMarkerRegistry();

    const fromNode = {
      id: 'node-from',
      type: 'node',
      nodeType: 'rect',
      x: 100,
      y: 100,
      width: 80,
      height: 60
    } as unknown as NodeEntity;

    const toNode = {
      id: 'node-to',
      type: 'node',
      nodeType: 'rect',
      x: 300,
      y: 100,
      width: 80,
      height: 60
    } as unknown as NodeEntity;

    const connector: ConnectorEntity = {
      id: 'conn-anchor',
      type: 'connector',
      zIndex: 'a0',
      locked: false,
      connectorType: 'straight',
      // 右侧边缘中点 (180, 130) → 左侧边缘中点 (300, 130)
      from: { nodeId: 'node-from', anchor: { x: 1, y: 0.5 } },
      to: { nodeId: 'node-to', anchor: { x: 0, y: 0.5 } },
      style: {
        stroke: '#0055FF',
        strokeWidth: 2,
        endArrow: 'triangle' // 空心三角箭头 (fillRule: match-background)
      }
    };

    const view = new ConnectorView(mapper);
    view.update({
      theme: TEST_THEME,
      editing: null,
      fonts: null,
      style: connector.style!,
      route: routeOf(connector, { 'node-from': fromNode, 'node-to': toNode }),
      version: '1',
      arrowMarkers
    });

    // 起点位于 fromNode 的 right 锚点: (100 + 80 = 180, 100 + 30 = 130)
    expect(view.points[0].x).toBeCloseTo(180, 1);
    expect(view.points[0].y).toBeCloseTo(130, 1);

    // 终点位于 toNode 的 left 锚点: (300, 130)，后撤 8px 后为 292
    expect(view.points[1].x).toBeCloseTo(292, 1);
    expect(view.points[1].y).toBeCloseTo(130, 1);

    // 空心箭头应填充白色背景底色，描边为连线颜色
    const endMarker = view.endMarker as any;
    expect(endMarker).toBeInstanceOf(Path);
    expect(endMarker.path).toBeDefined();
    expect(endMarker.fill).toBe('#FFFFFF');
    expect(endMarker.stroke).toBe('#0055FF');
  });

  it('曲线的采样段很短：箭头按路径长度后撤，朝向沿曲线末端切线', () => {
    const arrowMarkers = new ArrowMarkerRegistry();
    const connector: ConnectorEntity = {
      id: 'conn-curve',
      type: 'connector',
      zIndex: 'a0',
      locked: false,
      connectorType: 'curved',
      from: { position: { x: 0, y: 0 } },
      to: { position: { x: 300, y: 100 } },
      style: { endArrow: true }
    };
    const route = routeOf(connector);
    const view = new ConnectorView(mapper);
    view.update({
      theme: TEST_THEME,
      editing: null,
      fonts: null,
      style: connector.style!,
      route,
      version: '1',
      arrowMarkers
    });

    const tip = route.points[route.points.length - 1];
    const end = view.points[view.points.length - 1];
    expect(Math.hypot(tip.x - end.x, tip.y - end.y)).toBeCloseTo(8, 0);
    // 自由端沿主轴 (水平) 切入：箭头朝右 (取回退 8px 处的弦，与切线相差不到几度)
    expect(Math.abs((view.endMarker as any).rotation)).toBeLessThan(5);
  });

  it('连线文字：底色加文字画在线上；编辑中换成编辑视图 (含输入法组合文字)，底色随之伸展', () => {
    const connector: ConnectorEntity = {
      id: 'conn-label',
      type: 'connector',
      zIndex: 'a0',
      locked: false,
      connectorType: 'straight',
      from: { position: { x: 0, y: 0 } },
      to: { position: { x: 200, y: 0 } },
      textBlocks: [{ id: 'l', runs: [{ text: '是' }], position: 0.5 }]
    };
    const route = routeOf(connector, {}, true);
    expect(route.labels).toHaveLength(1);
    const view = new ConnectorView(mapper);
    const input = {
      theme: TEST_THEME,
      editing: null,
      fonts,
      style: {},
      route,
      version: '1',
      arrowMarkers: new ArrowMarkerRegistry()
    };
    view.update(input);
    expect(view.labels.children).toHaveLength(2);
    const width = (view.labels.children[0] as any).width;

    const editing = {
      kind: 'connector' as const,
      id: 'conn-label',
      blockId: 'l',
      scrollY: 0,
      composition: { offset: 1, text: 'fou', style: {} }
    };
    expect(view.update({ ...input, editing })).toBe(true);
    expect((view.labels.children[0] as any).width).toBeGreaterThan(width);
  });
});
