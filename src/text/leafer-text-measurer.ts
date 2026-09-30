/**
 * @file leafer-text-measurer.ts
 * @description 基于 Leafer 排版的文本测量器 (TextMeasurer 实现)
 *
 * 设计考量 (Why):
 * 1. 测量与绘制走同一条路径：文本块经 core 的 createTextBlockPrimitive 转为图元，再由与渲染完全相同的
 *    createLeaferShape 生成 Leafer Text，读取其排版包围盒。字体、折行与行高规则与实际绘制一致，
 *    自动尺寸不会出现「量出来一个高度、画出来另一个高度」的偏差。
 * 2. 复用同一个 Text 实例逐次就地更新属性，测量大量节点时不产生额外 GC 压力。
 *
 * 用法：`new SkyNoteEngine({ textMeasurer: new LeaferTextMeasurer() })`
 */

import type { Text } from 'leafer';
import type { TextMeasurer, TextMeasureRequest, TextBlockMetrics } from '@skynote/core';
import { createTextBlockPrimitive } from '@skynote/core';
import { createLeaferShape, updateLeaferShape } from '../primitives/primitive-mapper';

export class LeaferTextMeasurer implements TextMeasurer {
  private probe: Text | null = null;

  measure(request: TextMeasureRequest): TextBlockMetrics {
    // 与绘制一致：折行宽度为 0 时没有放文字的空间 (Leafer 会把 0 当作不折行，量出整段单行的尺寸)
    if (request.maxWidth !== undefined && request.maxWidth <= 0) return { width: 0, height: 0 };
    const primitive = createTextBlockPrimitive(request.block, request.style, {
      x: 0,
      y: 0,
      width: request.maxWidth
    });
    if (this.probe) {
      updateLeaferShape(this.probe, primitive);
    } else {
      this.probe = createLeaferShape(primitive) as Text;
    }
    const bounds = this.probe.getBounds('box', 'inner');
    return { width: bounds.width, height: bounds.height };
  }
}
