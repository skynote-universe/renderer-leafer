/**
 * @file dom-text-input.ts
 * @description 浏览器文字输入通道：隐藏的 textarea 接收键入、输入法、粘贴与剪贴板，转为 TextInputHandler 回调
 *
 * 设计考量 (Why):
 * 1. 只借输入通道不借排版：textarea 完全透明且不承载文字 (内容始终清空)，光标、选区与文字都画在画布上 (ADR-122)。
 * 2. 输入法候选框跟随光标：textarea 移到画布光标处，系统候选框贴着光标弹出。
 * 3. 键入走 beforeinput (可取消，拿到确定的文字)；组合输入的中间态不可取消，改走 composition 事件；
 *    编辑按键 (方向键、退格等) 照常冒泡到画布容器，由键盘作用域处理并阻止默认行为，不会进入 textarea。
 */

import {
  RICH_TEXT_CLIPBOARD_TYPE,
  type TextClipboardContent,
  type TextInputHandler,
  type TextInputSession
} from '@skynote/core';

/** 标记隐藏输入通道：宿主桥据此把它的按键照常转发给键盘作用域 */
export const TEXT_INPUT_ATTRIBUTE = 'data-skynote-text-input';

export class DOMTextInput implements TextInputSession {
  private readonly textarea: HTMLTextAreaElement;
  private readonly abortController = new AbortController();

  constructor(
    private readonly container: HTMLElement,
    private readonly handler: TextInputHandler,
    private readonly onClose: (session: DOMTextInput) => void
  ) {
    const textarea = container.ownerDocument.createElement('textarea');
    textarea.setAttribute(TEXT_INPUT_ATTRIBUTE, '');
    textarea.setAttribute('aria-label', '画布文字输入');
    textarea.autocomplete = 'off';
    textarea.spellcheck = false;
    Object.assign(textarea.style, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: '1px',
      height: '1em',
      padding: '0',
      border: '0',
      margin: '0',
      opacity: '0',
      resize: 'none',
      overflow: 'hidden',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      color: 'transparent',
      caretColor: 'transparent',
      background: 'transparent'
    });
    container.appendChild(textarea);
    this.textarea = textarea;
    this.bindEvents();
    this.focus();
  }

  setCaretRect(rect: { x: number; y: number; height: number }): void {
    Object.assign(this.textarea.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      height: `${Math.max(1, rect.height)}px`,
      fontSize: `${Math.max(1, rect.height * 0.8)}px`
    });
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
  }

  close(): void {
    const hadFocus = this.textarea.ownerDocument.activeElement === this.textarea;
    this.abortController.abort();
    this.textarea.remove();
    // 焦点交还画布：退出编辑后快捷键 (删除、撤销等) 立即可用
    if (hadFocus) this.container.focus({ preventScroll: true });
    this.onClose(this);
  }

  private bindEvents(): void {
    const { signal } = this.abortController;
    const { textarea, handler } = this;
    textarea.addEventListener(
      'beforeinput',
      (e) => {
        switch (e.inputType) {
          case 'insertText':
          case 'insertReplacementText':
            if (e.data) handler.insertText(e.data);
            e.preventDefault();
            break;
          case 'insertLineBreak':
          case 'insertParagraph':
            handler.insertText('\n');
            e.preventDefault();
            break;
          case 'insertCompositionText':
          case 'deleteCompositionText':
          case 'insertFromComposition':
            // 组合输入的中间态不可取消，由 composition 事件处理
            break;
          default:
            // 粘贴、拖放、撤销与删除由剪贴板事件与键盘作用域处理，textarea 自身不改变内容
            e.preventDefault();
        }
      },
      { signal }
    );
    textarea.addEventListener('compositionstart', () => handler.compositionStart(), { signal });
    textarea.addEventListener('compositionupdate', (e) => handler.compositionUpdate(e.data), { signal });
    textarea.addEventListener(
      'compositionend',
      (e) => {
        handler.compositionEnd(e.data);
        textarea.value = '';
      },
      { signal }
    );
    textarea.addEventListener(
      'paste',
      (e) => {
        e.preventDefault();
        const data = e.clipboardData;
        if (!data) return;
        const text = data.getData('text/plain').replace(/\r\n?/g, '\n');
        const richText = data.getData(RICH_TEXT_CLIPBOARD_TYPE);
        if (text || richText) handler.paste({ text, richText: richText || undefined });
      },
      { signal }
    );
    // 同时写入纯文本 (外部应用) 与富文本分段 (画布内粘贴保留样式)
    const writeClipboard = (e: ClipboardEvent, content: TextClipboardContent | null): void => {
      e.preventDefault();
      if (!content) return;
      e.clipboardData?.setData('text/plain', content.text);
      if (content.richText) e.clipboardData?.setData(RICH_TEXT_CLIPBOARD_TYPE, content.richText);
    };
    textarea.addEventListener('copy', (e) => writeClipboard(e, handler.copySelection()), { signal });
    textarea.addEventListener('cut', (e) => writeClipboard(e, handler.cutSelection()), { signal });
  }
}
