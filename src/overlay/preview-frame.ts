import { expandCornerRadius, resolveNodeStyle, type NodeEntity, type Point, type SkyNoteEngine } from '@skynote/core';

export const PREVIEW_TARGET_ATTRIBUTE = 'data-skynote-preview-target';
export const PREVIEW_CONTENT_ATTRIBUTE = 'data-skynote-preview-content';
const MIN_LOADING_DISPLAY_MS = 240;

export interface PreviewStatusOptions {
  readonly className: string;
  readonly text: string;
  readonly animate: boolean;
  readonly signal: AbortSignal;
}

export interface PreviewStatusHandle {
  readonly status: HTMLDivElement;
  readonly spinner: HTMLSpanElement;
  readonly message: HTMLSpanElement;
  finish(onHidden?: () => void): void;
  cancel(): void;
}

export class PreviewFrame {
  readonly element: HTMLDivElement;
  protected readonly surface: HTMLDivElement;
  protected readonly content: HTMLDivElement;
  protected readonly shield: HTMLDivElement;
  private statusLayer?: HTMLDivElement;

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
    this.shield.style.cursor = engine.session.isReadOnly ? 'pointer' : '';
    // 内容与边框共用圆心，内圆角随内缩量收小。外层多边形继续负责祖先裁切。
    const innerRadius = expandCornerRadius(radius)
      .map((corner) => `${Math.max(0, Math.min(corner * zoom, maxRadius) - inset)}px`)
      .join(' ');
    this.content.style.borderRadius = this.shield.style.borderRadius = innerRadius;
    if (this.statusLayer) {
      this.statusLayer.style.inset = `${inset}px`;
      this.statusLayer.style.borderRadius = innerRadius;
    }
  }

  /** 创建居中加载/状态浮层并插入 shield 之前，自动跟随节点内边距与圆角 */
  protected createStatus(options: PreviewStatusOptions): PreviewStatusHandle {
    const doc = this.element.ownerDocument;
    const status = doc.createElement('div');
    status.className = options.className;
    status.setAttribute('role', 'status');
    const badge = doc.createElement('span');
    const spinner = doc.createElement('span');
    spinner.setAttribute('aria-hidden', 'true');
    const message = doc.createElement('span');
    message.textContent = options.text;
    badge.append(spinner, message);
    status.append(badge);
    Object.assign(status.style, {
      position: 'absolute',
      inset: this.content.style.inset || '0',
      borderRadius: this.content.style.borderRadius || '',
      pointerEvents: 'none',
      background: 'color-mix(in srgb, var(--sn-canvas, Canvas) 48%, transparent)'
    });
    Object.assign(badge.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: 'max-content',
      maxWidth: 'calc(100% - 12px)',
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 10px',
      borderRadius: '9999px',
      fontSize: '12px',
      lineHeight: '16px',
      color: 'var(--sn-text, CanvasText)',
      background: 'var(--sn-surface, Canvas)',
      boxShadow: 'var(--sn-shadow-tooltip, 0 2px 8px rgb(0 0 0 / 18%))'
    });
    Object.assign(spinner.style, {
      width: '14px',
      height: '14px',
      flexShrink: '0',
      borderRadius: '50%',
      border: '2px solid var(--sn-border, currentColor)',
      borderTopColor: 'var(--sn-accent, currentColor)'
    });
    this.statusLayer = status;
    this.surface.insertBefore(status, this.shield);

    const reduceMotion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const animation =
      options.animate && !reduceMotion
        ? spinner.animate?.([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
            duration: 800,
            iterations: Infinity
          })
        : undefined;
    // 循环动画在加载结束或节点卸载时取消，finished 会以 AbortError 结束。
    void animation?.finished.catch(() => {});
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
      animation?.cancel();
    };
    options.signal.addEventListener('abort', cancel, { once: true });
    const finish = (onHidden?: () => void) => {
      if (options.signal.aborted || status.hidden || timer !== undefined) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          animation?.cancel();
          status.hidden = true;
          onHidden?.();
        },
        Math.max(0, MIN_LOADING_DISPLAY_MS - (performance.now() - startedAt))
      );
    };
    return { status, spinner, message, finish, cancel };
  }

  setInteractive(interactive: boolean): void {
    this.content.inert = !interactive;
    this.shield.hidden = interactive;
  }
}
