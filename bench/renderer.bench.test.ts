/**
 * @file renderer.bench.test.ts
 * @description 渲染帧性能基准：帧开销只随可见规模增长，平移时不得整体重挂场景树
 *
 * 运行：pnpm --filter @skynote/renderer-leafer bench（不随 pnpm test 执行，避免机器负载导致单测抖动）
 * 测试环境只替身了画布绘制，测得的是场景树结构与增量管线开销；预算按实测值放宽约 5 倍。
 */

import '../tests/setup';
import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import type { CanvasPatch, NodeEntity } from '@skynote/core';
import { createLeaferRenderer } from '../src/leafer-renderer';

function createScene() {
  const engine = new SkyNoteEngine();
  const patches: CanvasPatch[] = [];
  for (let i = 0; i < 10_000; i++) {
    const node: NodeEntity = {
      id: `n${i}`,
      type: 'node',
      nodeType: 'rect',
      x: (i % 100) * 30,
      y: Math.floor(i / 100) * 30,
      width: 20,
      height: 20,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };
    patches.push({ op: 'set', path: ['content', 'nodes', node.id], value: node });
  }
  engine.documentStore.commit({ patches, undoable: false });

  const renderer = createLeaferRenderer(engine, { enableFrameScheduler: false });
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 1000 });
  Object.defineProperty(container, 'clientHeight', { value: 800 });
  renderer.mount(container);
  engine.session.setViewport({ zoom: 0.8, x: 0, y: 0 });
  renderer.renderFrame();
  return { engine, renderer };
}

function averageFrame(run: (i: number) => void, iterations = 20): number {
  for (let i = 0; i < 3; i++) run(-1 - i);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) run(i);
  return (performance.now() - start) / iterations;
}

describe('渲染帧开销 (10k 节点，约 1700 个可见)', () => {
  it('平移帧：新进入视野的实体只做定位插入', () => {
    const { engine, renderer } = createScene();
    const frame = averageFrame((i) => {
      engine.session.setViewport({ x: -90 * (i + 10) });
      renderer.renderFrame();
    });
    console.info(`[bench] 平移帧: ${frame.toFixed(2)}ms`);
    // 实测约 6ms；若退化为每帧整体重挂场景树会超过 14ms
    expect(frame).toBeLessThan(30);
    renderer.destroy();
  });

  it('空闲帧：无变化时只做视锥检索与版本比较', () => {
    const { renderer } = createScene();
    const frame = averageFrame(() => renderer.renderFrame());
    console.info(`[bench] 空闲帧: ${frame.toFixed(2)}ms`);
    expect(frame).toBeLessThan(8);
    renderer.destroy();
  });
});
