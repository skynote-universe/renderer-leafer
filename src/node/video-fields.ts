import type { NodeEntity, SkyNoteEngine } from '@skynote/core';

export function getVideoFields(node: Pick<NodeEntity, 'nodeType'> | undefined) {
  return (
    node as
      | (Pick<NodeEntity, 'nodeType'> & {
          video?: { assetId: string; posterAssetId?: string; displayMode?: 'card' | 'preview' };
        })
      | undefined
  )?.video;
}

export function getVideoAsset(engine: SkyNoteEngine, node: Readonly<NodeEntity> | undefined) {
  const fields = node?.nodeType === 'video' ? getVideoFields(node) : undefined;
  const asset = fields && engine.documentStore.getView().assets?.[fields.assetId];
  return asset?.mimeType.startsWith('video/') ? asset : undefined;
}

export function videoCardPlayRadius(node: Readonly<NodeEntity>): number {
  return Math.min(18, node.width / 3, node.height / 3);
}
