import { describe, it, expect } from 'vitest';
import type { ConnectorEntity } from '@skynote/core';
import { ConnectorRouterRegistry, ArrowMarkerRegistry, deriveCanvasTheme, LIGHT_CANVAS_THEME_SEED, computeConnectorRoute } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';

// 连线渲染需显式提供主题：未设置描边色时取 connectorStroke，空心箭头取画布底色
const TEST_THEME = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });

/** 路由由内核引擎求解，渲染器只负责绘制：测试中直接调用同一纯函数构造路由 */
function routeOf(connector: ConnectorEntity, nodes: Record<string, NodeEntity> = {}) {
  return computeConnectorRoute(connector, (id) => nodes[id], new ConnectorRouterRegistry())!;
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

const { Group, Path, Line } = await import('leafer');
const { renderConnector } = await import('../src/connector/connector-renderer');

describe('Connector Renderer', () => {
  it('正确创建基础直连线与端点箭头后撤计算', () => {
    const parentGroup = new Group();
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

    const cache = renderConnector(parentGroup, {
      theme: TEST_THEME,
      connector,
      route: routeOf(connector),
      dataVersion: 1,
      arrowMarkers
    });

    expect(cache.group).toBeDefined();
    expect(cache.lineShape).toBeInstanceOf(Line);
    expect(cache.endMarkerShape).toBeInstanceOf(Path);
    expect(cache.startMarkerShape).toBeUndefined();

    // 终点箭头切线水平向右 (0 度)，终点坐标在端点后撤 lineOffset (默认 8px) 之后向内收敛为 92px
    expect(cache.computedPoints.length).toBe(2);
    expect(cache.computedPoints[0]).toEqual({ x: 0, y: 0 });
    expect(cache.computedPoints[1].x).toBeCloseTo(92, 1);
    expect(cache.computedPoints[1].y).toBeCloseTo(0, 1);
  });

  it('Fast Path 守卫：路由、属性与主题均未变化时直接返回现有缓存', () => {
    const parentGroup = new Group();
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
    const firstCache = renderConnector(parentGroup, {
      theme: TEST_THEME,
      connector,
      route,
      dataVersion: 1,
      arrowMarkers
    });

    const secondCache = renderConnector(parentGroup, {
      theme: TEST_THEME,
      connector,
      route,
      dataVersion: 1,
      arrowMarkers,
      existingCache: firstCache
    });

    expect(secondCache).toBe(firstCache);
  });

  it('动态增补箭头：原连线无箭头，后续增改属性时安全就地补全 Path', () => {
    const parentGroup = new Group();
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

    const initialCache = renderConnector(parentGroup, {
      theme: TEST_THEME,
      connector: connectorNoArrow,
      route: routeOf(connectorNoArrow),
      dataVersion: 1,
      arrowMarkers
    });
    expect(initialCache.startMarkerShape).toBeUndefined();
    expect(initialCache.endMarkerShape).toBeUndefined();

    // 变为带有起点与终点箭头
    const connectorWithArrows: ConnectorEntity = {
      ...connectorNoArrow,
      style: {
        startArrow: true,
        endArrow: true
      }
    };

    const updatedCache = renderConnector(parentGroup, {
      theme: TEST_THEME,
      connector: connectorWithArrows,
      route: initialCache.route,
      dataVersion: 2,
      arrowMarkers,
      existingCache: initialCache
    });

    expect(updatedCache).toBe(initialCache);
    expect(updatedCache.startMarkerShape).toBeInstanceOf(Path);
    expect(updatedCache.endMarkerShape).toBeInstanceOf(Path);
    expect(updatedCache.group.children.length).toBe(3); // Line + startMarker + endMarker
  });

  it('支持节点锚点 (anchorId) 精确吸附解算与空心三角箭头 (match-background) 底色填充', () => {
    const parentGroup = new Group();
    const arrowMarkers = new ArrowMarkerRegistry();

    const fromNode = {
      id: 'node-from',
      type: 'node',
      nodeType: 'rect',
      x: 100,
      y: 100,
      width: 80,
      height: 60,
      anchors: [
        { id: 'right', x: 1, y: 0.5 } // 右侧边缘中点 (180, 130)
      ]
    } as unknown as NodeEntity;

    const toNode = {
      id: 'node-to',
      type: 'node',
      nodeType: 'rect',
      x: 300,
      y: 100,
      width: 80,
      height: 60,
      anchors: [
        { id: 'left', x: 0, y: 0.5 } // 左侧边缘中点 (300, 130)
      ]
    } as unknown as NodeEntity;

    const connector: ConnectorEntity = {
      id: 'conn-anchor',
      type: 'connector',
      zIndex: 'a0',
      locked: false,
      connectorType: 'straight',
      from: { nodeId: 'node-from', anchorId: 'right' },
      to: { nodeId: 'node-to', anchorId: 'left' },
      style: {
        stroke: '#0055FF',
        strokeWidth: 2,
        endArrow: 'triangle' // 空心三角箭头 (fillRule: match-background)
      }
    };

    const cache = renderConnector(parentGroup, {
      theme: TEST_THEME,
      connector,
      route: routeOf(connector, { 'node-from': fromNode, 'node-to': toNode }),
      dataVersion: 1,
      arrowMarkers
    });

    expect(cache.lineShape).toBeInstanceOf(Line);
    // 起点位于 fromNode 的 right 锚点: (100 + 80 = 180, 100 + 30 = 130)
    expect(cache.computedPoints[0].x).toBeCloseTo(180, 1);
    expect(cache.computedPoints[0].y).toBeCloseTo(130, 1);

    // 终点位于 toNode 的 left 锚点: (300, 130)，后撤 8px 后为 292
    expect(cache.computedPoints[1].x).toBeCloseTo(292, 1);
    expect(cache.computedPoints[1].y).toBeCloseTo(130, 1);

    // 空心箭头应填充白色背景底色，描边为连线颜色
    const endMarker = cache.endMarkerShape as any;
    expect(endMarker).toBeInstanceOf(Path);
    expect(endMarker.fill).toBe('#FFFFFF');
    expect(endMarker.stroke).toBe('#0055FF');
  });
});
