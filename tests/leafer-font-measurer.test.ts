import './setup';
import { describe, it, expect } from 'vitest';
import { SkyNoteEngine, createSimpleTextBlock } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';
import { Platform } from 'leafer';
import { LeaferFontMeasurer, toLeaferFont } from '../src/text/leafer-font-measurer';

describe('LeaferFontMeasurer', () => {
  it('字体串与 Leafer Text 的拼接规则一致：斜体、非常规字重在前，缺省字体为 caption', () => {
    expect(toLeaferFont({ size: 16, weight: 'bold', style: 'italic', family: 'Inter' })).toBe('italic bold 16px Inter');
    expect(toLeaferFont({ size: 12, weight: 'normal', style: 'normal' })).toBe('12px caption');
    expect(toLeaferFont({ size: 12, weight: 'bolder', style: 'oblique' })).toBe('italic bold 12px caption');
  });

  it('用 Leafer 测量画布量宽度，相同字体与文字只量一次', () => {
    const measurer = new LeaferFontMeasurer();
    const canvas = Platform.canvas!;
    const original = canvas.measureText.bind(canvas);
    let calls = 0;
    canvas.measureText = (text: string) => {
      calls++;
      return original(text);
    };
    const font = { size: 16, weight: 'normal' as const, style: 'normal' as const };
    const width = measurer.measureWidth('hello', font);
    expect(measurer.measureWidth('hello', font)).toBe(width);
    expect(measurer.measureWidth('', font)).toBe(0);
    expect(calls).toBe(1);
    canvas.measureText = original;
  });

  it('注入引擎后，height-driven 节点随文本变长自动撑高', () => {
    const engine = new SkyNoteEngine({ fonts: new LeaferFontMeasurer() });
    engine.nodeTypes.register({ type: 'sticky', label: '便签', defaultData: {}, sizingPolicy: 'height-driven' });
    const node: NodeEntity = {
      id: 's',
      type: 'node',
      nodeType: 'sticky',
      x: 0,
      y: 0,
      width: 200,
      height: 1,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      textBlocks: [createSimpleTextBlock('t', 'hello')]
    };
    engine.documentStore.addNode(node);
    const shortHeight = engine.documentStore.getNode('s')!.height;
    expect(shortHeight).toBeGreaterThan(1);

    engine.documentStore.updateNode('s', { textBlocks: [createSimpleTextBlock('t', 'hello '.repeat(40))] });
    expect(engine.documentStore.getNode('s')!.height).toBeGreaterThan(shortHeight);
  });
});
