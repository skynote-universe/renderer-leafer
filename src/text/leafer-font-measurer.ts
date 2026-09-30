/**
 * @file leafer-font-measurer.ts
 * @description 基于 Leafer 测量画布的字体测量器 (FontMeasurer 实现)
 *
 * 设计考量 (Why):
 * 1. 测量与绘制同源：字体串与 Leafer Text 绘制时拼出的完全一致，且用 Leafer 自己的测量画布，
 *    内核排版给出的片段宽度即 Leafer 画出的宽度 (ADR-122)。
 * 2. 排版会反复测量相同的词与字 (分行、光标、选区)，按「字体 + 文字」缓存结果；超出上限时整体清空，
 *    实现简单且内存有界。
 */

import { Platform } from 'leafer';
import type { FontMeasurer, FontSpec, FontWeight } from '@skynote/core';

const CACHE_LIMIT = 20000;

/** Leafer 不支持相对字重，按最接近的绝对字重绘制 */
export function toLeaferFontWeight(weight: FontWeight): Exclude<FontWeight, 'bolder' | 'lighter'> {
  if (weight === 'bolder') return 'bold';
  if (weight === 'lighter') return 'normal';
  return weight;
}

/** 与 Leafer Text 内部拼接规则一致的 CSS 字体串 */
export function toLeaferFont(font: FontSpec): string {
  const weight = toLeaferFontWeight(font.weight);
  const italic = font.style === 'normal' ? '' : 'italic ';
  return `${italic}${weight === 'normal' ? '' : `${weight} `}${font.size}px ${font.family ?? 'caption'}`;
}

export class LeaferFontMeasurer implements FontMeasurer {
  private readonly cache = new Map<string, number>();

  measureWidth(text: string, font: FontSpec): number {
    if (text === '') return 0;
    const fontString = toLeaferFont(font);
    const key = `${fontString}\u0000${text}`;
    let width = this.cache.get(key);
    if (width === undefined) {
      // Leafer 导入时即创建测量画布
      const canvas = Platform.canvas!;
      canvas.font = fontString;
      width = canvas.measureText(text).width;
      if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
      this.cache.set(key, width);
    }
    return width;
  }
}
