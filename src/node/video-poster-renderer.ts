import { applyThemeToPrimitives, editingTextPrimitive, type NodeEntity, type SkyNoteEngine } from '@skynote/core';
import { Ellipse, Group, Path } from 'leafer-ui';
import type { PrimitiveMapper } from '../primitives/primitive-mapper';
import { ImageNodeRenderer } from './image-node-renderer';
import { getVideoFields, videoCardPlayRadius } from './video-fields';
import type { LeaferRenderContext, LeaferShape } from '../types';

export class VideoPosterRenderer extends ImageNodeRenderer {
  override readonly nodeType = 'video';

  constructor(
    private readonly engine: SkyNoteEngine,
    private readonly mapper: PrimitiveMapper,
    private readonly options: {
      renderPreviewPoster?: boolean;
    } = {}
  ) {
    super(
      (id) => engine.documentStore.getView().assets?.[id],
      engine.assets,
      undefined,
      (id) => engine.entityStore.getNode(id)?.entity
    );
  }

  protected override getImage(node: NodeEntity) {
    const assetId = this.showsPoster(node) ? getVideoFields(node)?.posterAssetId : undefined;
    return { assetId, fit: 'cover' as const };
  }

  protected override get emptyLabel(): string {
    return '视频';
  }

  override create(node: NodeEntity, context: LeaferRenderContext): LeaferShape[] {
    const shapes = super.create(node, context);
    shapes.push(new Ellipse({ hittable: false }), new Path({ hittable: false }), new Group({ hittable: false }));
    this.updateVisibility(shapes, node, context);
    return shapes;
  }

  override update(shapes: LeaferShape[], node: NodeEntity, context: LeaferRenderContext): void {
    super.update(shapes, node, context);
    this.updateVisibility(shapes, node, context);
  }

  private showsPoster(node: NodeEntity): boolean {
    return this.options.renderPreviewPoster === true || getVideoFields(node)?.displayMode !== 'preview';
  }

  private updateVisibility(shapes: LeaferShape[], node: NodeEntity, { theme, textEditing }: LeaferRenderContext): void {
    const showPoster = this.showsPoster(node);
    // 原位预览由 video 提供封面，画布保留节点底色、描边与顶部标题。
    for (const index of [1, 2, 4]) shapes[index].visible = showPoster;
    const r = videoCardPlayRadius(node);
    const x = node.width / 2;
    const y = node.height / 2;
    const visible = getVideoFields(node)?.displayMode !== 'preview';
    shapes[5].set({ x: x - r, y: y - r, width: r * 2, height: r * 2, fill: theme.background, opacity: 0.9, visible });
    shapes[6].set({
      path: `M ${x - r * 0.22} ${y - r * 0.42} L ${x + r * 0.44} ${y} L ${x - r * 0.22} ${y + r * 0.42} Z`,
      fill: theme.textColor,
      visible
    });
    const definition = this.engine.nodeTypes.get(node.nodeType);
    const labels = applyThemeToPrimitives(
      (definition?.compose?.(node, { theme }) ?? [])
        .filter((primitive) => primitive.kind === 'text')
        .map((primitive) => {
          if (textEditing?.kind !== 'node' || textEditing.id !== node.id || textEditing.blockId !== primitive.id)
            return primitive;
          const title = definition?.composeTextBlock?.(node, { theme }, textEditing.blockId);
          return editingTextPrimitive(title ?? primitive, textEditing);
        }),
      theme
    );
    const labelGroup = shapes[7] as Group;
    this.mapper.reconcile(labelGroup, labelGroup.children as LeaferShape[], labels);
  }
}
