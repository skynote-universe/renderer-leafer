import './setup';
import { describe, it, expect } from 'vitest';
import { SkyNoteEngine, createSimpleTextBlock } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';
import { createLeaferTextMeasurer } from '../src/text/leafer-text-measurer';

describe('createLeaferTextMeasurer', () => {
  it('按 Leafer 排版测量：限宽时文本越长折行越多，不限宽时宽度随内容增长', () => {
    const measurer = createLeaferTextMeasurer();
    const measure = (text: string, maxWidth?: number) =>
      measurer.measure({
        block: createSimpleTextBlock('t', text),
        style: { fontSize: 16 },
        sizing: maxWidth === undefined ? 'auto-width' : 'auto-height',
        maxWidth
      });

    const short = measure('hello', 200);
    const long = measure('hello '.repeat(40), 200);
    expect(long.height).toBeGreaterThan(short.height);
    expect(long.width).toBe(200);

    expect(measure('hello hello').width).toBeGreaterThan(measure('hello').width);
  });

  it('注入引擎后，height-driven 节点随文本变长自动撑高', () => {
    const engine = new SkyNoteEngine({ textMeasurer: createLeaferTextMeasurer() });
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
