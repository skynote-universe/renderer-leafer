import { compareHierarchicalNodes, type DocumentChangeSet, type NodeEntity, type SkyNoteEngine } from '@skynote/core';
import { getVideoAsset, getVideoFields } from '../node/video-fields';
import type { ContentPreviewOptions } from '../types';
import { previewOutline } from './preview-clip';
import { VideoPreview, type PreviewPlayback } from './video-preview';
import { readWebLink, WebLinkPreview } from './web-link-preview';

type ContentPreview = VideoPreview | WebLinkPreview;

export class ContentPreviews {
  private readonly root: HTMLDivElement;
  private readonly world: HTMLDivElement;
  private readonly previews = new Map<string, ContentPreview>();
  private readonly playback = new Map<string, PreviewPlayback>();
  private readonly previousPosition?: string;
  private focusedId?: string;
  private visibleCount = 0;

  constructor(
    private readonly engine: SkyNoteEngine,
    private readonly container: HTMLElement,
    private readonly options: ContentPreviewOptions = {},
    private readonly requestRender: () => void = () => {}
  ) {
    const doc = container.ownerDocument;
    this.root = doc.createElement('div');
    this.world = doc.createElement('div');
    this.world.className = 'skynote-content-preview-world';
    this.root.className = 'skynote-content-previews';
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '1',
      overflow: 'hidden',
      pointerEvents: 'none'
    });
    Object.assign(this.world.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    this.root.append(this.world);
    if (doc.defaultView?.getComputedStyle(container).position === 'static') {
      this.previousPosition = container.style.position;
      container.style.position = 'relative';
    }
    container.append(this.root);
    this.updateViewport();
  }

  updateViewport(): void {
    const { x, y } = this.engine.session.viewport;
    this.world.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  get hasVisiblePreview(): boolean {
    return this.visibleCount > 0;
  }

  canFocus(id: string): boolean {
    const { session } = this.engine;
    const preview = this.previews.get(id);
    return (
      session.tool === 'select' &&
      !session.inMaintenance &&
      session.selectedNodeIds.has(id) &&
      preview?.element.hidden === false &&
      preview.canInteract
    );
  }

  focus(id: string): boolean {
    if (!this.canFocus(id)) return false;
    if (this.focusedId && this.focusedId !== id) this.blur(this.focusedId);
    const preview = this.previews.get(id)!;
    this.focusedId = id;
    preview.setInteractive(true);
    preview.focus();
    return true;
  }

  exitFocus(): boolean {
    if (this.focusedId === undefined) return false;
    this.blur(this.focusedId, true);
    return true;
  }

  private blur(id: string, restoreFocus = false): void {
    if (this.focusedId !== id) return;
    this.focusedId = undefined;
    this.previews.get(id)?.setInteractive(false, this.canFocus(id));
    if (restoreFocus) this.container.focus({ preventScroll: true });
  }

  reconcilePlayback(changes: DocumentChangeSet): void {
    for (const id of changes.nodes.removed) this.playback.delete(id);
    const affected = changes.assets.size ? this.playback.keys() : changes.nodes.data;
    for (const id of affected) {
      const saved = this.playback.get(id);
      if (!saved) continue;
      const node = this.engine.entityStore.getNode(id)?.entity;
      if (getVideoFields(node)?.displayMode !== 'preview' || getVideoAsset(this.engine, node)?.src !== saved.source)
        this.playback.delete(id);
    }
  }

  sync(candidateIds: Iterable<string>, isInteracting: boolean): void {
    const { session, assets } = this.engine;
    if (session.inMaintenance) {
      this.clear();
      return;
    }
    const getNode = (id: string) => this.engine.entityStore.getNode(id)?.entity;
    const visible: Readonly<NodeEntity>[] = [];
    const shown = new Set<string>();
    for (const id of candidateIds) {
      const node = getNode(id);
      if (!node || !this.engine.visibility.isNodeVisible(id)) continue;
      const web = this.options.enableWebLinkPreviews ? readWebLink(node) : undefined;
      const isVideo = node.nodeType === 'video' && getVideoFields(node)?.displayMode === 'preview' && !!assets;
      if (!isVideo && !web?.preview) continue;
      const source = web?.url ?? getVideoAsset(this.engine, node)?.src;
      const outline = previewOutline(this.engine, node, false);
      const { width, height } = session.viewportSize;
      if (
        outline.length < 3 ||
        outline.every((p) => p.x <= 0) ||
        outline.every((p) => p.x >= width) ||
        outline.every((p) => p.y <= 0) ||
        outline.every((p) => p.y >= height)
      )
        continue;
      let preview = this.previews.get(id);
      if (preview && (preview.source !== source || preview instanceof VideoPreview !== isVideo)) {
        this.remove(id, preview);
        preview = undefined;
      }
      if (!preview) {
        const saved = this.playback.get(id);
        this.playback.delete(id);
        const onExit = (restoreFocus?: boolean) => this.blur(id, restoreFocus);
        const doc = this.container.ownerDocument;
        preview = web
          ? new WebLinkPreview(doc, id, web.url, onExit)
          : new VideoPreview(
              doc,
              id,
              source,
              assets!,
              this.options.mountVideoControls,
              saved?.source === source ? saved : undefined,
              onExit,
              this.requestRender
            );
        this.previews.set(id, preview);
        this.world.append(preview.element);
      }
      if (preview instanceof VideoPreview) {
        const posterId = getVideoFields(node)?.posterAssetId;
        const poster = posterId ? this.engine.documentStore.getView().assets?.[posterId] : undefined;
        preview.setPoster(poster?.mimeType.startsWith('image/') ? poster.src : undefined);
      } else if (web) preview.setTitle(web.title);
      preview.element.hidden = false;
      preview.position(this.engine, node, outline);
      const canFocus = !isInteracting && this.canFocus(id);
      preview.setInteractive(canFocus && this.focusedId === id, canFocus && this.focusedId !== id);
      shown.add(id);
      visible.push(node);
    }
    for (const [id, preview] of this.previews) {
      if (shown.has(id)) continue;
      const node = getNode(id);
      const sameSource =
        preview instanceof VideoPreview &&
        preview.source !== undefined &&
        getVideoFields(node)?.displayMode === 'preview' &&
        getVideoAsset(this.engine, node)?.src === preview.source;
      if (sameSource && preview.playing && this.engine.visibility.isNodeVisible(id)) {
        const heldFocus = preview.element.contains(this.container.ownerDocument.activeElement);
        this.blur(id, heldFocus);
        preview.element.hidden = true;
      } else {
        const playback = sameSource ? preview.playback : undefined;
        if (playback) this.playback.set(id, playback);
        this.remove(id, preview);
      }
    }
    if (this.focusedId && !this.canFocus(this.focusedId)) this.blur(this.focusedId);
    this.visibleCount = visible.length;
    visible.sort((a, b) => compareHierarchicalNodes(a, b, getNode));
    for (const [index, node] of visible.entries()) this.previews.get(node.id)!.element.style.zIndex = String(index);
  }

  private remove(id: string, preview: ContentPreview): void {
    const heldFocus = preview.element.contains(this.container.ownerDocument.activeElement);
    this.blur(id);
    this.previews.delete(id);
    preview.destroy();
    if (heldFocus) this.container.focus({ preventScroll: true });
  }

  clear(): void {
    for (const [id, preview] of this.previews) this.remove(id, preview);
    this.playback.clear();
    this.visibleCount = 0;
  }

  destroy(): void {
    this.clear();
    this.root.remove();
    if (this.previousPosition !== undefined && this.container.style.position === 'relative')
      this.container.style.position = this.previousPosition;
  }
}
