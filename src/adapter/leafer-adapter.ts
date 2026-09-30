/**
 * @file leafer-adapter.ts
 * @description Leafer 渲染适配器：成对提供 LeaferRenderer 与 LeaferTextMeasurer
 *
 * 用法：`new SkyNoteEditor({ renderer: new LeaferAdapter() })`
 */

import type { CanvasRenderer, RenderAdapter, SkyNoteEngine } from '@skynote/core';
import type { LeaferRendererOptions } from '../types';
import { LeaferRenderer } from '../leafer-renderer';
import { LeaferTextMeasurer } from '../text/leafer-text-measurer';

export class LeaferAdapter implements RenderAdapter<HTMLElement> {
  readonly textMeasurer = new LeaferTextMeasurer();

  /** @param options 每次挂载渲染器时使用的选项 */
  constructor(private readonly options?: LeaferRendererOptions) {}

  mount(engine: SkyNoteEngine, container: HTMLElement): CanvasRenderer {
    return new LeaferRenderer(engine, container, this.options);
  }
}
