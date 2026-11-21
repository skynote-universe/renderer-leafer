import { expandCornerRadius, resolveNodeStyle, type NodeEntity, type Point, type SkyNoteEngine } from '@skynote/core';

export const PREVIEW_TARGET_ATTRIBUTE = 'data-skynote-preview-target';
export const PREVIEW_CONTENT_ATTRIBUTE = 'data-skynote-preview-content';

export class PreviewFrame {
  readonly element: HTMLDivElement;
  protected readonly surface: HTMLDivElement;
  protected readonly content: HTMLDivElement;
  protected readonly shield: HTMLDivElement;

  constructor(doc: Document, nodeId: string) {
    this.element = doc.createElement('div');
    this.element.dataset.nodeId = nodeId;
    this.surface = doc.createElement('div');
    this.content = doc.createElement('div');
    this.content.setAttribute(PREVIEW_CONTENT_ATTRIBUTE, '');
    this.shield = doc.createElement('div');
    this.shield.setAttribute(PREVIEW_TARGET_ATTRIBUTE, nodeId);
    Object.assign(this.element.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    Object.assign(this.surface.style, {
      position: 'absolute',
      inset: '0 auto auto 0',
      transformOrigin: '0 0',
      overflow: 'hidden'
    });
    Object.assign(this.content.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'auto',
      cursor: 'default',
      overflow: 'hidden'
    });
    Object.assign(this.shield.style, { position: 'absolute', inset: '0', pointerEvents: 'auto', touchAction: 'none' });
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'keyup', 'contextmenu'])
      this.content.addEventListener(type, (event) => event.stopPropagation());
    this.element.addEventListener('dblclick', (event) => event.stopPropagation());
    this.surface.append(this.content, this.shield);
    this.element.append(this.surface);
  }

  position(engine: SkyNoteEngine, node: Readonly<NodeEntity>, outline: readonly Point[]): void {
    const matrix = engine.entityStore.getWorldTransform(node.id);
    if (!matrix) return;
    const { x, y, zoom } = engine.session.viewport;
    const width = node.width * zoom;
    const height = node.height * zoom;
    const {
      radius,
      strokeWidth = 0,
      stroke,
      strokeOpacity
    } = resolveNodeStyle(node, engine.nodeTypes.get(node.nodeType));
    const border = stroke === 'transparent' || strokeOpacity === 0 ? 0 : strokeWidth * zoom;
    const dpr = this.element.ownerDocument.defaultView?.devicePixelRatio || 1;
    // 向上对齐到物理像素，避免非整数缩放时 DOM 边缘吃掉底层 Canvas 描边的抗锯齿像素。
    const snappedBorder = border > 0 ? Math.ceil(border * dpr) / dpr : 0;
    const maxRadius = Math.min(width, height) / 2;
    const inset = Math.max(0, Math.min(snappedBorder, maxRadius - 0.5));
    this.element.style.clipPath = `polygon(${outline.map((p) => `${p.x - x}px ${p.y - y}px`).join(', ')})`;
    this.surface.style.width = `${width}px`;
    this.surface.style.height = `${height}px`;
    this.surface.style.transform = `matrix(${matrix.a},${matrix.b},${matrix.c},${matrix.d},${matrix.e * zoom},${matrix.f * zoom})`;
    this.content.style.inset = this.shield.style.inset = `${inset}px`;
    // 内容与边框共用圆心，内圆角随内缩量收小。外层多边形继续负责祖先裁切。
    const innerRadius = expandCornerRadius(radius)
      .map((corner) => `${Math.max(0, Math.min(corner * zoom, maxRadius) - inset)}px`)
      .join(' ');
    this.content.style.borderRadius = this.shield.style.borderRadius = innerRadius;
  }

  setInteractive(interactive: boolean): void {
    this.content.inert = !interactive;
    this.shield.hidden = interactive;
  }
}
