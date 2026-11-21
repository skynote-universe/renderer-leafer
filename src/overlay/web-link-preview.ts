import { getPlainText, parseWebUrl, type NodeEntity } from '@skynote/core';
import { PreviewFrame } from './preview-frame';

export interface WebLinkPreviewInfo {
  readonly url: string;
  readonly title: string;
  readonly preview: boolean;
}

export function readWebLink(node: Readonly<NodeEntity> | undefined): WebLinkPreviewInfo | undefined {
  if (node?.nodeType !== 'web-link') return undefined;
  const fields = (node as { webLink?: { url?: unknown; displayMode?: unknown } }).webLink;
  const url = parseWebUrl(fields?.url);
  if (!url) return undefined;
  const titleBlock = node.textBlocks?.find((block) => block.slot === 'title');
  const title = titleBlock ? getPlainText(titleBlock) : '';
  return {
    url: url.href,
    title: title.trim().slice(0, 120) || url.hostname,
    preview: fields?.displayMode === 'preview'
  };
}

export class WebLinkPreview extends PreviewFrame {
  readonly canInteract = true;
  private readonly frame: HTMLIFrameElement;
  private readonly hint: HTMLSpanElement;
  private readonly controller = new AbortController();

  constructor(
    doc: Document,
    nodeId: string,
    readonly source: string,
    onExit: (restoreFocus?: boolean) => void
  ) {
    super(doc, nodeId);
    this.element.className = 'skynote-web-link-preview';
    const { signal } = this.controller;
    this.frame = doc.createElement('iframe');
    this.frame.setAttribute('sandbox', 'allow-scripts allow-forms');
    this.frame.referrerPolicy = 'no-referrer';
    this.frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'");
    this.frame.tabIndex = 0;
    Object.assign(this.frame.style, {
      display: 'block',
      border: '0',
      width: '100%',
      height: '100%',
      background: 'var(--sn-surface, Canvas)'
    });

    this.content.append(this.frame);

    this.hint = doc.createElement('span');
    this.hint.textContent = '再次点击或按 Enter 操作网页';
    Object.assign(this.hint.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: 'max-content',
      maxWidth: 'calc(100% - 12px)',
      padding: '4px 8px',
      borderRadius: '9999px',
      background: 'var(--sn-surface, Canvas)',
      color: 'var(--sn-text, CanvasText)',
      boxShadow: 'var(--sn-shadow-tooltip, 0 2px 8px rgb(0 0 0 / 18%))',
      fontSize: '12px',
      textAlign: 'center',
      pointerEvents: 'none'
    });
    this.shield.append(this.hint);
    this.setInteractive(false);
    this.content.addEventListener(
      'focusout',
      (event) => {
        if (!this.content.contains(event.relatedTarget as Node | null)) onExit();
      },
      { signal }
    );
    this.content.addEventListener(
      'keydown',
      (event) => {
        if (event.isComposing || event.keyCode === 229 || event.key !== 'Escape' || event.defaultPrevented)
          event.stopPropagation();
      },
      { signal }
    );
    this.frame.src = source;
  }

  setTitle(title: string): void {
    if (this.frame.title !== title) this.frame.title = title;
  }

  override setInteractive(interactive: boolean, showHint = false): void {
    super.setInteractive(interactive);
    this.hint.hidden = !showHint;
  }

  focus(): void {
    this.frame.focus({ preventScroll: true });
  }

  destroy(): void {
    this.controller.abort();
    this.element.remove();
  }
}
