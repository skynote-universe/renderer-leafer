import type { AssetAdapter, NodeEntity } from '@skynote/core';
import { Ellipse, Path } from 'leafer-ui';
import { ImageNodeRenderer } from './image-node-renderer';
import { getVideoFields, videoCardPlayRadius } from './video-fields';
import type { LeaferRenderContext, LeaferShape } from '../types';

export class VideoPosterRenderer extends ImageNodeRenderer {
  override readonly nodeType = 'video';

  constructor(
    getAsset: (id: string) => { src: string } | undefined,
    assets: AssetAdapter | undefined,
    private readonly options: {
      getNode?: (id: string) => NodeEntity | undefined;
      renderPreviewPoster?: boolean;
    } = {}
  ) {
    super(getAsset, assets, undefined, options.getNode);
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
    shapes.push(new Ellipse({ hittable: false }), new Path({ hittable: false }));
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

  private updateVisibility(shapes: LeaferShape[], node: NodeEntity, { theme }: LeaferRenderContext): void {
    const showPoster = this.showsPoster(node);
    // 原位预览由 video 提供封面，画布保留节点底色和描边。
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
  }
}
