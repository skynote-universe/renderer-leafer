import { describe, it, expect } from 'vitest';
import {
  screenToWorld,
  worldToScreen,
  getViewportWorldBounds,
  snapToDevicePixel,
  snapHalfPixel,
  distanceToSegment,
  distanceToPolyline
} from '../src/viewport/viewport-transform';

describe('ViewportTransform', () => {
  it('应准确完成屏幕坐标与世界坐标的双向转换', () => {
    const viewport = { x: 100, y: 50, zoom: 2 };
    const screenPt = { x: 300, y: 250 };

    const worldPt = screenToWorld(screenPt, viewport);
    expect(worldPt).toEqual({ x: 100, y: 100 });

    const backToScreen = worldToScreen(worldPt, viewport);
    expect(backToScreen).toEqual(screenPt);
  });

  it('在 zoom 缩放极小和极大时应保持纯函数且不产生 NaN', () => {
    const minZoom = { x: 0, y: 0, zoom: 0.1 };
    const world1 = screenToWorld({ x: 10, y: 10 }, minZoom);
    expect(world1.x).toBe(100);
    expect(world1.y).toBe(100);

    const maxZoom = { x: 500, y: 500, zoom: 10 };
    const world2 = screenToWorld({ x: 500, y: 500 }, maxZoom);
    expect(world2.x).toBe(0);
    expect(world2.y).toBe(0);
  });

  it('求解视锥世界坐标包围盒 AABB', () => {
    const viewport = { x: 0, y: 0, zoom: 1 };
    const bounds = getViewportWorldBounds(viewport, 800, 600);

    expect(bounds).toEqual({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600
    });
  });

  it('物理像素吸附 snapToDevicePixel 与半像素对齐 snapHalfPixel', () => {
    // DPR = 2 时，硬件栅格步长为 0.5px
    expect(snapToDevicePixel(10.23, 2)).toBe(10);
    expect(snapToDevicePixel(10.26, 2)).toBe(10.5);
    expect(snapToDevicePixel(10.49, 2)).toBe(10.5);
    expect(snapToDevicePixel(10.76, 2)).toBe(11);

    // 奇数描边 (1px) 在 DPR=1 时应当在硬件栅格上微调 0.5px
    const half = snapHalfPixel(10, 1, 1);
    expect(half).toBe(10.5);
  });

  it('几何距离纯函数 distanceToSegment 与 distanceToPolyline 准确度量', () => {
    const p1 = { x: 0, y: 0 };
    const p2 = { x: 100, y: 0 };

    // 垂直投影在 [0, 100] 范围内的点
    expect(distanceToSegment({ x: 50, y: 20 }, p1, p2)).toBe(20);

    // 落在起点外部的点
    expect(distanceToSegment({ x: -10, y: 0 }, p1, p2)).toBe(10);

    // 落在终点外部的点
    expect(distanceToSegment({ x: 110, y: 0 }, p1, p2)).toBe(10);

    // 折线距离
    const polyline = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 }
    ];
    expect(distanceToPolyline({ x: 50, y: 5 }, polyline)).toBe(5);
    expect(distanceToPolyline({ x: 105, y: 50 }, polyline)).toBe(5);
  });
});
