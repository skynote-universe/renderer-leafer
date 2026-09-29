/**
 * @file types.ts
 * @description LeaferJS 渲染适配器类型定义
 *
 * 遵守 AGENTS.md 准则：
 * 1. 单一事实源：杜绝能在已有字段推导出的冗余属性 (如 zoom)；
 * 2. 干净纯粹：严禁未被实际使用的幽灵字段 (如 lifecycleCustomData)。
 */

import type { NodeEntity, ConnectorEntity, Point, CanvasTheme, ComputedRoute } from '@skynote/core';
import type { Group, Rect, Ellipse, Polygon, Path, Line, Text, Box, Image } from 'leafer';
import type { ViewportState } from './viewport/viewport-transform';

/** Leafer 支持的基础形状联合 */
export type LeaferShape = Group | Rect | Ellipse | Polygon | Path | Line | Text | Box | Image;

/**
 * 视口与渲染交互上下文 (遵守单一事实源，zoom 直接通过 viewport.zoom 读取)
 * 不含选区：选中框与控制柄由覆盖层统一绘制，节点内容与选中态无关，选中切换不重建任何节点
 */
export interface LeaferRenderContext {
  readonly viewport: ViewportState;
  readonly isInteracting: boolean;
  /** 当前主题 (主题切换时整体替换，原生渲染器应从此取色而非写死色值) */
  readonly theme: CanvasTheme;
}

/** 图层单帧同步结果 */
export interface LayerSyncResult {
  /** 新进入场景 (需要重新确定层级位置) 的实体数 */
  entered: number;
  /** 渲染新进入实体的累计耗时，回传分帧调度器校准单个实体的挂载成本 */
  enterMs: number;
}

/** 渲染器构造选项 */
export interface LeaferRendererOptions {
  /** 挂载的 DOM 容器 */
  container?: HTMLElement;
  /** 设备像素比 (默认自动读取 window.devicePixelRatio) */
  dpr?: number;
  /** 初始视口 */
  initialViewport?: ViewportState;
  /** 帧调度配置 (默认 true) */
  enableFrameScheduler?: boolean;
  /**
   * 离屏图元缓存上限 (节点与连线各自计数，默认 2000)
   * 离开视锥的实体保留图元以便回到视野时就地复用，超出上限按最近最少出现 (LRU) 淘汰并释放
   */
  offscreenCacheLimit?: number;
}

/** 节点渲染图元缓存项 */
export interface NodeRenderCache {
  readonly outerGroup: Group;
  readonly contentGroup: Group;
  /** 最近一次成功渲染的几何版本号 */
  geomVersion: number;
  /** 最近一次成功渲染的业务数据版本号 */
  dataVersion: number;
  /** 当前内容档位：完整内容 / LOD 占位块 / 渲染崩溃后的降级占位框 */
  detail: 'full' | 'placeholder' | 'broken';
  /** 最近一次渲染所用的主题 (按引用比较，主题切换即失效) */
  theme: CanvasTheme;
  /** 内部创建的 Leafer 图元引用列表 (用于就地复用) */
  shapes: LeaferShape[];
  /** 最近一次渲染的节点实体 (卸载时据其 nodeType 寻址原生渲染器，并作为 destroy 的入参) */
  node: NodeEntity;
}

/** 连线渲染图元缓存项 */
export interface ConnectorRenderCache {
  readonly group: Group;
  readonly lineShape: Line | Path;
  startMarkerShape?: LeaferShape;
  endMarkerShape?: LeaferShape;
  /** 最近一次绘制所用的路由 (按引用比较，路由重算即失效) */
  route: ComputedRoute;
  /** 最近一次渲染时的连线业务数据版本号 */
  dataVersion: number;
  /** 实际绘制的折线点集 (两端已按箭头后撤) */
  computedPoints: Point[];
  /** 最近一次渲染的连线实体 (卸载时据其 connectorType 寻址原生渲染器，并作为 destroy 的入参) */
  connector: ConnectorEntity;
  /** 最近一次渲染所用的主题 (按引用比较，主题切换即失效) */
  theme: CanvasTheme;
}

/** 顶层瞬态图元渲染会话 */
export interface EphemeralSession {
  readonly sessionId: string;
  shapes: LeaferShape[];
}

/** 实体碰撞拾取统一命中结果 */
export type HitEntityResult =
  | { readonly type: 'node'; readonly entity: NodeEntity }
  | { readonly type: 'connector'; readonly entity: ConnectorEntity };
