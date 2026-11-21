import { compareHierarchicalNodes, type DocumentChangeSet, type NodeEntity, type SkyNoteEngine } from '@skynote/core';
import type { ContentPreviewOptions } from '../types';
import { previewOutline } from './preview-clip';
import { PreviewRendererRegistry, type ContentPreviewInstance, type ContentPreviewRenderer } from './preview-registry';
import { createVideoPreviewRenderer } from './video-preview';
import { createWebLinkPreviewRenderer } from './web-link-preview';

interface MountedPreview {
  readonly renderer: ContentPreviewRenderer;
  readonly instance: ContentPreviewInstance;
}

interface SavedPreviewState {
  readonly renderer: ContentPreviewRenderer;
  readonly state: unknown;
}

export function createDefaultPreviewRegistry(options?: ContentPreviewOptions): PreviewRendererRegistry {
  const registry = new PreviewRendererRegistry();
  registry.register(createVideoPreviewRenderer(options?.mountVideoControls));
  if (options?.enableWebLinkPreviews) registry.register(createWebLinkPreviewRenderer());
  return registry;
}

export class ContentPreviews {
  private readonly root: HTMLDivElement;
  private readonly world: HTMLDivElement;
  private readonly registry: PreviewRendererRegistry;
  private readonly previews = new Map<string, MountedPreview>();
  private readonly savedStates = new Map<string, SavedPreviewState>();
  private readonly previousPosition?: string;
  private focusedId?: string;
  private visibleCount = 0;

  constructor(
    private readonly engine: SkyNoteEngine,
    private readonly container: HTMLElement,
    registryOrOptions: PreviewRendererRegistry | ContentPreviewOptions = {},
    private readonly requestRender: () => void = () => {}
  ) {
    this.registry =
      registryOrOptions instanceof PreviewRendererRegistry
        ? registryOrOptions
        : createDefaultPreviewRegistry(registryOrOptions);
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
    this.root.appendChild(this.world);
    if (doc.defaultView?.getComputedStyle(container).position === 'static') {
      this.previousPosition = container.style.position;
      container.style.position = 'relative';
    }
    container.appendChild(this.root);
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
    const entry = this.previews.get(id);
    return (
      session.tool === 'select' &&
      !session.inMaintenance &&
      session.selectedNodeIds.has(id) &&
      entry?.instance.element.hidden === false &&
      entry.instance.canInteract
    );
  }

  focus(id: string): boolean {
    if (!this.canFocus(id)) return false;
    if (this.focusedId && this.focusedId !== id) this.blur(this.focusedId);
    const entry = this.previews.get(id)!;
    this.focusedId = id;
    entry.instance.setInteractive(true);
    entry.instance.focus();
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
    this.previews.get(id)?.instance.setInteractive(false, this.canFocus(id));
    if (restoreFocus) this.container.focus({ preventScroll: true });
  }

  reconcilePlayback(changes: DocumentChangeSet): void {
    for (const id of changes.nodes.removed) this.savedStates.delete(id);
    const affected = changes.assets.size ? this.savedStates.keys() : changes.nodes.data;
    for (const id of affected) {
      const saved = this.savedStates.get(id);
      if (!saved) continue;
      const node = this.engine.entityStore.getNode(id)?.entity;
      if (
        !node ||
        this.registry.get(node.nodeType) !== saved.renderer ||
        !saved.renderer.shouldKeepSavedState?.(this.engine, node, saved.state)
      ) {
        this.savedStates.delete(id);
      }
    }
  }

  sync(candidateIds: Iterable<string>, isInteracting: boolean): void {
    const { session } = this.engine;
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
      const renderer = this.registry.get(node.nodeType);
      const resolved = renderer?.resolveSource(this.engine, node);
      if (!renderer || !resolved) continue;
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
      let entry = this.previews.get(id);
      if (entry && (entry.renderer !== renderer || entry.instance.source !== resolved.source)) {
        this.remove(id, entry.instance);
        entry = undefined;
      }
      if (!entry) {
        const saved = this.savedStates.get(id);
        this.savedStates.delete(id);
        const onExit = (restoreFocus?: boolean) => this.blur(id, restoreFocus);
        const instance = renderer.create({
          doc: this.container.ownerDocument,
          engine: this.engine,
          node,
          source: resolved.source,
          savedState: saved?.renderer === renderer ? saved.state : undefined,
          onExit,
          requestRender: this.requestRender
        });
        entry = { renderer, instance };
        this.previews.set(id, entry);
        this.world.appendChild(instance.element);
      }
      entry.instance.update?.(this.engine, node);
      entry.instance.element.hidden = false;
      entry.instance.position(this.engine, node, outline);
      const canFocus = !isInteracting && this.canFocus(id);
      entry.instance.setInteractive(canFocus && this.focusedId === id, canFocus && this.focusedId !== id);
      shown.add(id);
      visible.push(node);
    }
    for (const [id, entry] of this.previews) {
      if (shown.has(id)) continue;
      const node = getNode(id);
      const renderer = node ? this.registry.get(node.nodeType) : undefined;
      const resolved = node && renderer === entry.renderer ? renderer.resolveSource(this.engine, node) : undefined;
      const sameSource = !!resolved && resolved.source !== undefined && resolved.source === entry.instance.source;
      if (sameSource && entry.instance.keepAliveWhenOffscreen && this.engine.visibility.isNodeVisible(id)) {
        const heldFocus = entry.instance.element.contains(this.container.ownerDocument.activeElement);
        this.blur(id, heldFocus);
        entry.instance.element.hidden = true;
      } else {
        const state = sameSource ? entry.instance.captureState?.() : undefined;
        if (state !== undefined) this.savedStates.set(id, { renderer: entry.renderer, state });
        this.remove(id, entry.instance);
      }
    }
    if (this.focusedId && !this.canFocus(this.focusedId)) this.blur(this.focusedId);
    this.visibleCount = visible.length;
    visible.sort((a, b) => compareHierarchicalNodes(a, b, getNode));
    for (const [index, node] of visible.entries())
      this.previews.get(node.id)!.instance.element.style.zIndex = String(index);
  }

  private remove(id: string, preview: ContentPreviewInstance): void {
    const heldFocus = preview.element.contains(this.container.ownerDocument.activeElement);
    this.blur(id);
    this.previews.delete(id);
    preview.destroy();
    if (heldFocus) this.container.focus({ preventScroll: true });
  }

  clear(): void {
    for (const [id, entry] of this.previews) this.remove(id, entry.instance);
    this.savedStates.clear();
    this.visibleCount = 0;
  }

  destroy(): void {
    this.clear();
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    else this.root.remove?.();
    if (this.previousPosition !== undefined && this.container.style.position === 'relative')
      this.container.style.position = this.previousPosition;
  }
}
