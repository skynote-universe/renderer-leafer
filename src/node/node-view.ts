/**
 * @file node-view.ts
 * @description 单个节点的原生图元：外层变换、内容图元与子容器，按双版本号就地更新
 *
 * 设计考量 (Why):
 * 1. 双版本号守卫：几何版本变化只更新外层变换，数据版本、主题或细节档位变化才重建内容；
 *    选中态不参与 (ADR-110)，框选上千节点不触发任何内容重建。
 * 2. 单节点崩溃防白屏：内容渲染异常局部捕获并降级为占位框，直到数据或主题再次变化才重试，避免每帧重复抛错。
 * 3. 旋转约定：绕节点中心旋转，x / y 为未旋转框左上角在父容器中的局部坐标 (origin 不改变定位，around 会改变)。
 */

import { Box, Group } from 'leafer';
import type {
  CanvasPrimitive,
  CanvasTheme,
  EntityVersions,
  NodeEntity,
  NodeFill,
  NodeTypeRegistry
} from '@skynote/core';
import { applyThemeToPrimitives, resolveThemeColor } from '@skynote/core';
import type { LeaferRenderContext, LeaferShape } from '../types';
import type { LeaferNodeRendererRegistry } from '../registry/leafer-node-renderer-registry';
import { reconcileLeaferShapes } from '../primitives/primitive-mapper';

/** 本帧要求的节点细节档位 */
export type NodeRenderDetail = 'full' | 'placeholder';

/** 同一图层内所有节点视图共享的依赖 */
export interface NodeViewEnvironment {
  readonly nodeTypes: NodeTypeRegistry;
  readonly renderers: LeaferNodeRendererRegistry;
}

/** 渐变填充在占位与兜底矩形中退化为首个色标 */
function resolveNodeFill(fill: NodeFill | undefined, theme: CanvasTheme, fallback: string): string {
  const color = typeof fill === 'object' ? fill.stops[0]?.color : fill;
  return resolveThemeColor(color, theme, fallback)!;
}

export class NodeView {
  /** 外层图元：承载节点变换，挂在父容器的子容器 (或根内容层) 中 */
  readonly group = new Group();
  private readonly content = new Group();
  private childrenGroup: Group | null = null;
  private shapes: LeaferShape[] = [];
  private node: Readonly<NodeEntity>;
  private geomVersion = -1;
  private dataVersion = -1;
  private theme: CanvasTheme | null = null;
  /** 当前内容档位；broken 为渲染崩溃后的降级占位框 */
  private detail: NodeRenderDetail | 'broken' | null = null;

  constructor(
    private readonly env: NodeViewEnvironment,
    node: Readonly<NodeEntity>
  ) {
    this.node = node;
    this.group.add(this.content);
  }

  /**
   * 子节点与容器内连线的挂载容器，按需创建 (多数节点没有子节点)，位于自身内容之上
   * 声明 clipChildren 的节点类型 (画框) 用 overflow: 'hide' 的 Box 裁剪，旋转后依旧正确
   */
  get children(): Group {
    if (!this.childrenGroup) {
      this.childrenGroup = this.env.nodeTypes.get(this.node.nodeType)?.clipChildren
        ? new Box({ width: this.node.width, height: this.node.height, overflow: 'hide' })
        : new Group();
      this.group.add(this.childrenGroup);
    }
    return this.childrenGroup;
  }

  update(
    node: Readonly<NodeEntity>,
    versions: Readonly<EntityVersions>,
    context: LeaferRenderContext,
    detail: NodeRenderDetail
  ): void {
    this.node = node;
    if (versions.geomVersion !== this.geomVersion) {
      this.group.set({
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        origin: 'center'
      });
      if (this.childrenGroup instanceof Box) this.childrenGroup.set({ width: node.width, height: node.height });
      this.geomVersion = versions.geomVersion;
    }

    // 已崩溃降级的节点视同占位档位，只在数据或主题变化时重试
    const renderedDetail = this.detail === 'broken' ? detail : this.detail;
    if (versions.dataVersion === this.dataVersion && context.theme === this.theme && renderedDetail === detail) return;
    this.dataVersion = versions.dataVersion;
    this.theme = context.theme;
    this.renderContent(context, detail);
  }

  /** 释放图元；原生渲染器的资源成对 destroy */
  destroy(): void {
    if (this.detail === 'full') this.env.renderers.get(this.node.nodeType)?.destroy?.(this.shapes, this.node);
    this.group.destroy();
  }

  /** 内容来源：占位块 / 原生渲染器 / 声明式 compose()；异常局部捕获并降级为占位框 */
  private renderContent(context: LeaferRenderContext, detail: NodeRenderDetail): void {
    const { node } = this;
    const { theme } = context;
    try {
      if (detail === 'placeholder') {
        this.renderPlaceholder(theme);
        this.detail = 'placeholder';
        return;
      }

      const nativeRenderer = this.env.renderers.get(node.nodeType);
      if (nativeRenderer) {
        // 从占位或崩溃态恢复时整体重建
        if (this.detail === 'full' && this.shapes.length > 0) {
          nativeRenderer.update(this.shapes, node, context);
        } else {
          this.discardShapes();
          this.shapes = nativeRenderer.create(node, context);
          for (const shape of this.shapes) this.content.add(shape);
        }
        this.detail = 'full';
        return;
      }

      // 未注册类型兜底为按节点样式绘制的矩形
      const definition = this.env.nodeTypes.get(node.nodeType);
      const primitives: CanvasPrimitive[] = definition?.compose
        ? applyThemeToPrimitives(definition.compose(node, { theme }), theme)
        : [
            {
              kind: 'rect',
              x: 0,
              y: 0,
              width: node.width,
              height: node.height,
              fill: resolveNodeFill(node.style?.fill, theme, theme.nodeFill),
              stroke: resolveThemeColor(node.style?.stroke, theme, theme.nodeStroke),
              strokeWidth: node.style?.strokeWidth ?? 1,
              radius: node.style?.radius
            }
          ];
      if (this.detail !== 'full') this.discardShapes();
      this.shapes = reconcileLeaferShapes(this.content, this.shapes, primitives);
      this.detail = 'full';
    } catch (err) {
      console.error(`[LeaferRenderer] 节点 ${node.id} (${node.nodeType}) 渲染失败，已降级为占位框:`, err);
      try {
        this.renderPlaceholder(theme);
      } catch {
        // 占位框本身失败时保留空内容，保证渲染循环继续
      }
      this.detail = 'broken';
    }
  }

  /** 纯色占位块：跳过文本排版与 compose，只按节点填充色 (未设置时取主题占位色) 绘制一个矩形 */
  private renderPlaceholder(theme: CanvasTheme): void {
    const { node } = this;
    if (this.detail === 'full') this.discardShapes();
    this.shapes = reconcileLeaferShapes(this.content, this.shapes, [
      {
        kind: 'rect',
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        fill: resolveNodeFill(node.style?.fill, theme, theme.placeholderFill),
        radius: node.style?.radius
      }
    ]);
  }

  /** 切换内容来源前释放现有图元，原生渲染器的资源成对 destroy */
  private discardShapes(): void {
    if (this.detail === 'full') this.env.renderers.get(this.node.nodeType)?.destroy?.(this.shapes, this.node);
    for (const shape of this.shapes) shape.remove();
    this.shapes = [];
  }
}
