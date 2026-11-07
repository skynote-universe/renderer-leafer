/**
 * @file node-view.ts
 * @description 单个节点的原生图元：外层变换、内容图元与子容器，按双版本号就地更新
 *
 * 设计考量 (Why):
 * 1. 双版本号守卫：移动与旋转只更新外层变换；数据版本、尺寸 (compose 图元依赖宽高)、主题或细节档位变化才重建内容；
 *    选中态不参与 (ADR-110)，框选上千节点不触发任何内容重建。
 * 2. 单节点崩溃防白屏：内容渲染异常局部捕获并降级为占位框，直到数据或主题再次变化才重试，避免每帧重复抛错。
 * 3. 内容裁剪：节点类型声明 clipContent 时，内容图元放进 overflow: 'hide' 的 Box，超出外框的部分不绘制。
 * 4. 旋转约定：绕节点中心旋转，x / y 为未旋转框左上角在父容器中的局部坐标。位置由内核局部矩阵直接给出
 *    (旋转后左上角所在位置，Leafer 绕自身原点旋转)；不用 Leafer 的 origin: 'center'——分组的「中心」取自子图元的
 *    实际包围盒而非节点宽高，子节点拖出容器时旋转容器的中心随之漂移，容器与子节点都会错位。
 */

import { Box, Group } from 'leafer-ui';
import { withDetachedBranches } from '../layers/scene-subtree-mutation';
import type {
  CanvasPrimitive,
  CanvasTheme,
  EntityVersions,
  NodeEntity,
  NodeFill,
  NodeDataPaths,
  NodeDataPath,
  NodeCompositionPart,
  NodeTypeDefinition,
  NodeTypeRegistry,
  TextEditingTarget
} from '@skynote/core';
import {
  applyThemeToPrimitives,
  computeNodeLocalMatrix,
  editingTextPrimitive,
  resolveNodeStyle,
  resolveThemeColor
} from '@skynote/core';
import type { LeaferRenderContext, LeaferShape } from '../types';
import type {
  LeaferNodeRendererRegistry,
  LeaferNodeLifecycleRenderer
} from '../registry/leafer-node-renderer-registry';
import type { PrimitiveMapper } from '../primitives/primitive-mapper';

/** 本帧要求的节点细节档位 */
export type NodeRenderDetail = 'full' | 'placeholder';

/** 同一图层内所有节点视图共享的依赖 */
export interface NodeViewEnvironment {
  readonly nodeTypes: NodeTypeRegistry;
  readonly renderers: LeaferNodeRendererRegistry;
  readonly mapper: PrimitiveMapper;
}

/** 渐变填充在占位与兜底矩形中退化为首个色标 */
function resolveNodeFill(fill: NodeFill | undefined, theme: CanvasTheme, fallback: string): string {
  const color = typeof fill === 'object' ? fill.stops[0]?.color : fill;
  return resolveThemeColor(color, theme, fallback)!;
}

export class NodeView {
  /** 创建视图时的类型不能随实体字段原位更新而改变。 */
  readonly nodeType: string;
  readonly definition: NodeTypeDefinition | undefined;
  /** 外层图元：承载节点变换，挂在父容器的子容器 (或根内容层) 中 */
  readonly group = new Group();
  /** 内容图元的容器；裁剪型节点为随外框同步尺寸的 Box */
  private readonly content: Group;
  private childrenGroup: Group | null = null;
  private shapes: LeaferShape[] = [];
  private nativeRenderer: LeaferNodeLifecycleRenderer | null = null;
  private nativeNode: Readonly<NodeEntity> | null = null;
  private node: Readonly<NodeEntity>;
  private geomVersion = -1;
  private dataVersion = -1;
  /** 内容图元按此尺寸生成：移动不改尺寸，不必重建 */
  private contentWidth = -1;
  private contentHeight = -1;
  private theme: CanvasTheme | null = null;
  /** 内容生成时本节点的编辑视图 (编辑块、滚动与输入法组合文字)；会话每次变化整体替换，按引用比较 */
  private editing: TextEditingTarget | null = null;
  /** 当前内容档位；broken 为渲染崩溃后的降级占位框 */
  private detail: NodeRenderDetail | 'broken' | null = null;
  private readonly parts = new Map<
    string,
    { group: Group | null; order: number; shapes: LeaferShape[]; source: readonly CanvasPrimitive[] }
  >();
  private readonly textParts = new Map<string, Set<string>>();
  private readonly mountedPartOrders: number[] = [];
  private pendingPaths: Map<string, NodeDataPath> | null = null;
  private pendingVersion: number | null = null;
  private renderedEditing: TextEditingTarget | null = null;

  /** 保留离屏和同帧多次提交的变化；整体替换或缺少路径提示时必须完整重建。 */
  recordChanges(paths: NodeDataPaths, version: number): void {
    // 版本来自全局时钟，其他实体变化也会使数值跳跃，不能用差值判断本节点是否漏帧。
    if (paths === null || this.pendingVersion === null) this.pendingPaths = null;
    if (this.pendingPaths && paths) for (const path of paths) this.pendingPaths.set(JSON.stringify(path), path);
    this.pendingVersion = version;
  }

  constructor(
    private readonly env: NodeViewEnvironment,
    node: Readonly<NodeEntity>
  ) {
    this.node = node;
    this.nodeType = node.nodeType;
    const def = env.nodeTypes.get(node.nodeType);
    this.definition = def;
    this.content = def?.clipContent
      ? new Box({
          width: node.width,
          height: node.height,
          overflow: 'hide',
          cornerRadius: resolveNodeStyle(node, def).radius
        })
      : new Group();
    this.group.add(this.content);
  }

  /**
   * 子节点与容器内连线的挂载容器，按需创建 (多数节点没有子节点)，位于自身内容之上
   * 声明 clipChildren 的节点类型 (画框) 用 overflow: 'hide' 的 Box 裁剪，旋转后依旧正确
   */
  get children(): Group {
    if (!this.childrenGroup) {
      const def = this.env.nodeTypes.get(this.node.nodeType);
      this.childrenGroup = def?.clipChildren
        ? new Box({
            width: this.node.width,
            height: this.node.height,
            overflow: 'hide',
            cornerRadius: resolveNodeStyle(this.node, def).radius
          })
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
      const local = computeNodeLocalMatrix(node);
      this.group.set({ x: local.e, y: local.f, rotation: node.rotation });
      if (this.childrenGroup instanceof Box) this.childrenGroup.set({ width: node.width, height: node.height });
      if (this.content instanceof Box) this.content.set({ width: node.width, height: node.height });
      this.geomVersion = versions.geomVersion;
    }

    // 已崩溃降级的节点视同占位档位，只在数据、尺寸或主题变化时重试
    const renderedDetail = this.detail === 'broken' ? detail : this.detail;
    const sizeChanged = node.width !== this.contentWidth || node.height !== this.contentHeight;
    const target = context.textEditing;
    const editing = target?.kind === 'node' && target.id === node.id ? target : null;
    const fullComposition =
      this.dataVersion < 0 ||
      sizeChanged ||
      context.theme !== this.theme ||
      this.detail !== 'full' ||
      (versions.dataVersion !== this.dataVersion &&
        (this.pendingPaths === null || this.pendingVersion !== versions.dataVersion));
    if (
      versions.dataVersion === this.dataVersion &&
      !sizeChanged &&
      context.theme === this.theme &&
      editing === this.editing &&
      renderedDetail === detail
    ) {
      return;
    }
    const def = this.env.nodeTypes.get(node.nodeType);
    const cornerRadius = resolveNodeStyle(node, def).radius;
    if (this.childrenGroup instanceof Box) this.childrenGroup.set({ cornerRadius });
    if (this.content instanceof Box) this.content.set({ cornerRadius });
    this.editing = editing;
    this.dataVersion = versions.dataVersion;
    this.contentWidth = node.width;
    this.contentHeight = node.height;
    this.theme = context.theme;
    this.renderContent(context, detail, fullComposition);
    this.pendingPaths = new Map();
    this.pendingVersion = versions.dataVersion;
  }

  /** 资产元数据或节点类型注册表变化不改节点版本，显式使内容缓存失效。 */
  invalidateContent(): void {
    this.dataVersion = -1;
    this.pendingPaths = null;
    this.pendingVersion = null;
    if (this.detail === 'broken') this.detail = null;
  }

  /** 释放图元；原生渲染器的资源成对 destroy */
  destroy(): void {
    // 子容器只承载节点/连线图层各自拥有的图元。先摘下它们，避免 Leafer 递归销毁解组后仍存活或离屏缓存中的视图。
    if (this.childrenGroup?.children.length) {
      const container = this.childrenGroup;
      const children = new Set(container.children as Group[]);
      withDetachedBranches([container], () => container.removeAll(), new Map([[container, { removed: children }]]));
    }
    this.releaseNative();
    this.group.destroy();
    this.parts.clear();
    this.mountedPartOrders.length = 0;
    this.textParts.clear();
    this.pendingPaths = null;
  }

  /** 内容来源：占位块 / 原生渲染器 / 声明式 compose()；异常局部捕获并降级为占位框 */
  private renderContent(context: LeaferRenderContext, detail: NodeRenderDetail, fullComposition: boolean): void {
    const { node } = this;
    const { theme } = context;
    try {
      if (detail === 'placeholder') {
        this.renderPlaceholder(theme);
        this.detail = 'placeholder';
        return;
      }

      const validationError = this.env.nodeTypes.validateNode(node, this.dataVersion);
      if (validationError) {
        throw new Error(validationError);
      }

      const nativeRenderer = this.env.renderers.get(node.nodeType);
      if (nativeRenderer) {
        // 从占位或崩溃态恢复时整体重建
        if (this.detail === 'full' && this.shapes.length > 0 && this.nativeRenderer === nativeRenderer) {
          nativeRenderer.update(this.shapes, node, context);
          this.nativeNode = { ...node };
        } else {
          this.discardShapes();
          this.shapes = nativeRenderer.create(node, context);
          this.nativeRenderer = nativeRenderer;
          this.nativeNode = { ...node };
          for (const shape of this.shapes) this.content.add(shape);
        }
        this.detail = 'full';
        return;
      }

      // 未注册类型兜底为按节点样式绘制的矩形
      const definition = this.env.nodeTypes.get(node.nodeType);
      if (definition?.composeParts) {
        this.renderParts(definition, context, fullComposition);
        this.detail = 'full';
        return;
      }
      const { editing } = this;
      const primitives: CanvasPrimitive[] = definition?.compose
        ? applyThemeToPrimitives(
            // 编辑中的文字块换成编辑视图 (与编辑插件同一函数)：不截断、按滚动裁剪、插入输入法组合文字
            definition
              .compose(node, { theme })
              .map((primitive) =>
                editing && primitive.kind === 'text' && primitive.id === editing.blockId
                  ? editingTextPrimitive(primitive, editing)
                  : primitive
              ),
            theme
          )
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
              strokeDashArray: node.style?.strokeDashArray,
              radius: node.style?.radius
            }
          ];
      if (this.detail !== 'full' || this.parts.size || this.nativeRenderer) this.discardShapes();
      this.shapes = this.env.mapper.reconcile(this.content, this.shapes, primitives);
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

  private indexPart(id: string, primitives: readonly CanvasPrimitive[], add: boolean): void {
    for (const primitive of primitives) {
      if (primitive.kind !== 'text' || !primitive.id) continue;
      if (add) {
        let ids = this.textParts.get(primitive.id);
        if (!ids) this.textParts.set(primitive.id, (ids = new Set()));
        ids.add(id);
      } else {
        const ids = this.textParts.get(primitive.id);
        ids?.delete(id);
        if (!ids?.size) this.textParts.delete(primitive.id);
      }
    }
  }

  private renderParts(definition: NodeTypeDefinition, context: LeaferRenderContext, full: boolean): void {
    const paths = [...(this.pendingPaths?.values() ?? [])];
    let updates: readonly NodeCompositionPart[] | null = null;
    if (!full && this.parts.size)
      updates = paths.length
        ? (definition.composeChangedParts?.(this.node, { theme: context.theme }, paths) ?? null)
        : [];
    if (updates?.some((part) => !this.parts.has(part.id))) updates = null;
    const dirty = new Set<string>();
    if (updates === null) {
      const all = definition.composeParts!(this.node, { theme: context.theme });
      this.discardShapes();
      for (const [order, part] of all.entries()) {
        if (this.parts.has(part.id)) throw new Error(`重复渲染分片: ${part.id}`);
        this.parts.set(part.id, { group: null, order, shapes: [], source: part.primitives });
        this.indexPart(part.id, part.primitives, true);
        dirty.add(part.id);
      }
    } else {
      for (const part of updates) {
        const view = this.parts.get(part.id)!;
        this.indexPart(part.id, view.source, false);
        view.source = part.primitives;
        this.indexPart(part.id, view.source, true);
        dirty.add(part.id);
      }
      for (const editing of [this.renderedEditing, this.editing]) {
        if (editing) for (const id of this.textParts.get(editing.blockId) ?? []) dirty.add(id);
      }
    }
    for (const id of dirty) {
      const view = this.parts.get(id)!;
      if (!view.source.length && !view.group) continue;
      if (!view.group) {
        let start = 0;
        let end = this.mountedPartOrders.length;
        while (start < end) {
          const middle = (start + end) >> 1;
          if (this.mountedPartOrders[middle] < view.order) start = middle + 1;
          else end = middle;
        }
        view.group = new Group();
        this.content.addAt(view.group, start);
        this.mountedPartOrders.splice(start, 0, view.order);
      }
      const primitives = applyThemeToPrimitives(
        view.source.map((primitive) =>
          this.editing && primitive.kind === 'text' && primitive.id === this.editing.blockId
            ? editingTextPrimitive(primitive, this.editing)
            : primitive
        ),
        context.theme
      );
      view.shapes = this.env.mapper.reconcile(view.group, view.shapes, primitives);
    }
    this.renderedEditing = this.editing;
  }

  /** 纯色占位块：跳过文本排版与 compose，只按节点填充色 (未设置时取主题占位色) 绘制一个矩形 */
  private renderPlaceholder(theme: CanvasTheme): void {
    const { node } = this;
    if (this.detail === 'full' || this.parts.size || this.nativeRenderer) this.discardShapes();
    this.shapes = this.env.mapper.reconcile(this.content, this.shapes, [
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
    this.releaseNative();
    for (const shape of this.shapes) shape.remove();
    this.shapes = [];
    for (const part of this.parts.values()) part.group?.destroy();
    this.parts.clear();
    this.mountedPartOrders.length = 0;
    this.textParts.clear();
    this.renderedEditing = null;
  }

  /** 插件清理失败不能阻断整帧；先清除旧来源引用，再释放框架持有的原生图元。 */
  private releaseNative(): void {
    const renderer = this.nativeRenderer;
    const node = this.nativeNode;
    this.nativeRenderer = null;
    this.nativeNode = null;
    if (!renderer || !node) return;
    const shapes = this.shapes;
    const owned = shapes.slice();
    this.shapes = [];
    try {
      renderer.destroy?.(shapes, node);
    } catch (error) {
      console.error(`[LeaferRenderer] 节点 ${node.id} (${node.nodeType}) 原生资源释放失败，继续清理图元:`, error);
    } finally {
      for (const shape of owned) {
        if (shape.destroyed) continue;
        try {
          // 先从场景摘除，子类释放失败也不让外层销毁再次进入同一图元。
          shape.remove();
          shape.destroy();
        } catch (error) {
          console.error(`[LeaferRenderer] 节点 ${node.id} (${node.nodeType}) 原生图元释放失败:`, error);
        }
      }
    }
  }
}
