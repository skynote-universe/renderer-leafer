/**
 * @file types.ts
 * @description Leafer 渲染适配层的公共类型
 */

import type { CanvasTheme, ViewportState } from '@skynote/core';
import type { Group, Rect, Ellipse, Polygon, Path, Line, Text, Box, Image } from 'leafer';

/** 渲染器使用的 Leafer 图元 */
export type LeaferShape = Group | Rect | Ellipse | Polygon | Path | Line | Text | Box | Image;

/**
 * 原生节点渲染器的上下文
 * 不含选区：选中框与控制柄由覆盖层统一绘制，节点内容与选中态无关 (ADR-110)
 */
export interface LeaferRenderContext {
  readonly viewport: Readonly<ViewportState>;
  /** 正在拖拽、平移等交互中：原生渲染器可据此暂时降低绘制精度 */
  readonly isInteracting: boolean;
  /** 当前主题 (切换时整体替换)，原生渲染器从此取色而非写死色值 */
  readonly theme: CanvasTheme;
}

/** 图层单帧同步结果 */
export interface LayerSyncResult {
  /** 新进入场景 (需要重新确定层级位置) 的实体数 */
  entered: number;
  /** 渲染新进入实体的累计耗时，回传分帧调度器校准单个实体的挂载成本 */
  enterMs: number;
  /**
   * 离开场景的实体数：层级同步必须在同一帧把它们从有序列表中剔除，
   * 否则之后重新进入时会被误认为仍在原位 (实际已被追加到容器末尾)
   */
  left: number;
}

/** 渲染器选项 */
export interface LeaferRendererOptions {
  /** 设备像素比 (默认读取 window.devicePixelRatio) */
  pixelRatio?: number;
  /** 分帧调度 (默认开启) */
  enableFrameScheduler?: boolean;
  /**
   * 离屏图元缓存上限 (节点与连线各自计数，默认 2000)
   * 离开视锥的实体保留图元以便回到视野时就地复用，超出上限按最近最少出现 (LRU) 淘汰并释放
   */
  offscreenCacheLimit?: number;
}
