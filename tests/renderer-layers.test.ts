import './setup';
import { describe, it, expect } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import { createLeaferRenderer } from '../src/leafer-renderer';

describe('LeaferRenderer 场景树图层架构', () => {
  it('mount 后正确定位 backgroundLayer 处于最底层，且独立于 contentLayer', () => {
    const engine = new SkyNoteEngine();
    const renderer = createLeaferRenderer(engine);

    // 尚未 mount 时图层为 null
    expect(renderer.getBackgroundLayer()).toBeNull();
    expect(renderer.getContentLayer()).toBeNull();

    // 模拟 mount 挂载
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1000 });
    Object.defineProperty(container, 'clientHeight', { value: 800 });

    renderer.mount(container);

    const backgroundLayer = renderer.getBackgroundLayer();
    const contentLayer = renderer.getContentLayer();

    expect(backgroundLayer).not.toBeNull();
    expect(contentLayer).not.toBeNull();

    // 验证场景树相对层级：backgroundLayer 必须在 contentLayer 之前添加 (最底)
    const sceneGroup = (backgroundLayer as any).parent;
    expect(sceneGroup).toBeDefined();
    expect(sceneGroup.children[0]).toBe(backgroundLayer);
    expect(sceneGroup.children[1]).toBe(contentLayer);

    // 验证 destroy 资源完全释放
    renderer.destroy();
    expect(renderer.getBackgroundLayer()).toBeNull();
    expect(renderer.getContentLayer()).toBeNull();
  });
});
