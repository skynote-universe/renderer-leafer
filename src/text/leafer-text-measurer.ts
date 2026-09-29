/**
 * @file leafer-text-measurer.ts
 * @description 基于 Leafer 排版的文本测量器 (TextMeasurer 实现)
 *
 * 设计考量 (Why):
 * 测量与绘制走同一条路径：文本块经 core 的 createTextBlockPrimitive 转为图元，再由与渲染完全相同的
 * createLeaferShapeFromPrimitive 生成 Leafer Text，读取其排版包围盒。字体、折行与行高规则与实际绘制一致，
 * 自动尺寸不会出现「量出来一个高度、画出来另一个高度」的偏差。
 */

import type { Text } from 'leafer';
import type { TextMeasurer, TextMeasureRequest, TextBlockMetrics } from '@skynote/core';
import { createTextBlockPrimitive } from '@skynote/core';
import { createLeaferShapeFromPrimitive, updateLeaferShapeInPlace } from '../primitives/primitive-mapper';

/**
 * 创建 Leafer 文本测量器，注入引擎：`engine.setTextMeasurer(createLeaferTextMeasurer())`
 * 测量器内部复用同一个 Text 实例，逐次就地更新属性，不产生额外 GC 压力
 */
export function createLeaferTextMeasurer(): TextMeasurer {
  let probe: Text | null = null;

  return {
    measure(request: TextMeasureRequest): TextBlockMetrics {
      const primitive = createTextBlockPrimitive(request.block, request.style, {
        x: 0,
        y: 0,
        width: request.maxWidth
      });
      if (probe) {
        updateLeaferShapeInPlace(probe, primitive);
      } else {
        probe = createLeaferShapeFromPrimitive(primitive) as Text;
      }

      const bounds = probe.getBounds('box', 'inner');
      return { width: bounds.width, height: bounds.height };
    }
  };
}
