import './setup';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';
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

  it('通过 DocumentStore 修改 zIndex 后内容层自动重排', () => {
    const engine = new SkyNoteEngine();
    const make = (id: string, zIndex: string): NodeEntity => ({
      id,
      type: 'node',
      nodeType: 'rect',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      rotation: 0,
      zIndex,
      locked: false
    });
    engine.documentStore.addNode(make('a', 'a1'));
    engine.documentStore.addNode(make('b', 'a2'));

    const renderer = createLeaferRenderer(engine);
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1000 });
    Object.defineProperty(container, 'clientHeight', { value: 800 });
    renderer.mount(container);

    const contentLayer = renderer.getContentLayer()!;
    const [groupA, groupB] = contentLayer.children;
    expect(contentLayer.children).toEqual([groupA, groupB]);

    // 提交只登记变更并申请下一帧，显式冲刷后按 ChangeSet.orderChanged 重排
    engine.documentStore.updateNode('a', { zIndex: 'a3' });
    renderer.renderFrame();
    expect(contentLayer.children).toEqual([groupB, groupA]);

    renderer.destroy();
  });

  it('Esc 经焦点栈以最低优先级清空瞬态图元，销毁后注销作用域', () => {
    const engine = new SkyNoteEngine();
    const renderer = createLeaferRenderer(engine);
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1000 });
    Object.defineProperty(container, 'clientHeight', { value: 800 });
    renderer.mount(container);

    const ephemeralGroup = renderer.getContentLayer()!.parent!.children[2] as unknown as { children: unknown[] };
    renderer.ephemeral.setPrimitives('marquee', [{ kind: 'rect', x: 0, y: 0, width: 10, height: 10 }]);
    expect(ephemeralGroup.children.length).toBeGreaterThan(0);

    const escape = {
      key: 'Escape',
      code: 'Escape',
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault: () => {},
      stopPropagation: () => {}
    };
    engine.inputScopes.dispatchKeyDown(escape);
    expect(ephemeralGroup.children.length).toBe(0);

    renderer.destroy();
    expect(engine.inputScopes.hasScope('renderer:ephemeral-escape')).toBe(false);
  });

  describe('视口尺寸', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('渲染帧不读取容器布局尺寸，尺寸变化由 ResizeObserver 驱动视锥更新', () => {
      let resize: ((entries: { contentRect: { width: number; height: number } }[]) => void) | null = null;
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: typeof resize) {
            resize = callback;
          }
          observe() {}
          disconnect() {}
        }
      );

      const engine = new SkyNoteEngine();
      const makeNode = (id: string, x: number): NodeEntity => ({
        id,
        type: 'node',
        nodeType: 'rect',
        x,
        y: 10,
        width: 20,
        height: 20,
        rotation: 0,
        zIndex: 'a0',
        locked: false
      });
      engine.documentStore.addNode(makeNode('near', 10));
      engine.documentStore.addNode(makeNode('far', 1500));

      const renderer = createLeaferRenderer(engine, { enableFrameScheduler: false });
      const container = document.createElement('div');
      const widthRead = vi.fn(() => 400);
      Object.defineProperty(container, 'clientWidth', { get: widthRead });
      Object.defineProperty(container, 'clientHeight', { value: 300 });
      renderer.mount(container);
      const contentLayer = renderer.getContentLayer()!;
      expect(contentLayer.children.length).toBe(1);

      widthRead.mockClear();
      renderer.renderFrame();
      expect(widthRead).not.toHaveBeenCalled();

      resize!([{ contentRect: { width: 1600, height: 300 } }]);
      renderer.renderFrame();
      expect(contentLayer.children.length).toBe(2);
      renderer.destroy();
    });
  });
});
