import { applyThemeToPrimitives, editingTextPrimitive, type NodeEntity, type SkyNoteEngine } from '@skynote/core';
import { Group } from 'leafer-ui';
import type { PrimitiveMapper } from '../primitives/primitive-mapper';
import type { LeaferRenderContext, LeaferShape } from '../types';
import { ImageNodeRenderer } from './image-node-renderer';

export class WebLinkCoverRenderer extends ImageNodeRenderer {
  override readonly nodeType = 'web-link';

  constructor(
    private readonly engine: SkyNoteEngine,
    private readonly mapper: PrimitiveMapper,
    private readonly hidePreviewCover = false
  ) {
    super(
      (id) => engine.documentStore.getView().assets?.[id],
      engine.assets,
      undefined,
      (id) => engine.entityStore.getNode(id)?.entity
    );
  }

  protected override getImage(node: NodeEntity) {
    const link = (node as { webLink?: { coverAssetId?: string; displayMode?: string } }).webLink;
    const assetId = this.hidePreviewCover && link?.displayMode === 'preview' ? undefined : link?.coverAssetId;
    return { assetId, fit: 'cover' as const };
  }

  override create(node: NodeEntity, context: LeaferRenderContext): LeaferShape[] {
    const shapes = super.create(node, context);
    shapes.push(new Group({ hittable: false }));
    this.updateContent(shapes, node, context);
    return shapes;
  }

  override update(shapes: LeaferShape[], node: NodeEntity, context: LeaferRenderContext): void {
    super.update(shapes, node, context);
    this.updateContent(shapes, node, context);
  }

  private updateContent(shapes: LeaferShape[], node: NodeEntity, { theme, textEditing }: LeaferRenderContext): void {
    const definition = this.engine.nodeTypes.get(node.nodeType);
    const primitives = (definition?.compose?.(node, { theme }) ?? []).map((primitive) => {
      if (
        primitive.kind !== 'text' ||
        textEditing?.kind !== 'node' ||
        textEditing.id !== node.id ||
        textEditing.blockId !== primitive.id
      )
        return primitive;
      const title = definition?.composeTextBlock?.(node, { theme }, textEditing.blockId);
      return editingTextPrimitive(title ?? primitive, textEditing);
    });
    const [background, ...labels] = applyThemeToPrimitives(primitives, theme);
    shapes[1].visible = shapes[4].visible = false;
    if (background?.kind === 'rect') {
      this.mapper.update(shapes[0], { ...background, stroke: undefined });
      this.mapper.update(shapes[3], { ...background, fill: undefined });
      shapes[2].set({ cornerRadius: background.radius });
    }
    const labelGroup = shapes[5] as Group;
    this.mapper.reconcile(
      labelGroup,
      labelGroup.children as LeaferShape[],
      labels.filter((p) => p.kind !== 'image')
    );
  }
}
