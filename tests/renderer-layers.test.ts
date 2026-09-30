import './setup';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DETACHED_CANVAS_HOST, SkyNoteEngine } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';
import { LeaferAdapter } from '../src/adapter/leafer-adapter';
import { LeaferTextMeasurer } from '../src/text/leafer-text-measurer';

describe('LeaferRenderer 场景树图层架构', () => {
  it('backgroundLayer 处于最底层，且独立于 contentLayer', () => {
    const engine = new SkyNoteEngine();

    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1000 });
    Object.defineProperty(container, 'clientHeight', { value: 800 });

    const renderer = new LeaferRenderer(engine, container);

    const backgroundLayer = renderer.backgroundLayer;
    const contentLayer = renderer.contentLayer;

    // 验证场景树相对层级：backgroundLayer 必须在 contentLayer 之前添加 (最底)
    const sceneGroup = (backgroundLayer as any).parent;
    expect(sceneGroup).toBeDefined();
    expect(sceneGroup.children[0]).toBe(backgroundLayer);
    expect(sceneGroup.children[1]).toBe(contentLayer);

    renderer.destroy();
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

    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1000 });
    Object.defineProperty(container, 'clientHeight', { value: 800 });
    const renderer = new LeaferRenderer(engine, container);

    const contentLayer = renderer.contentLayer;
    const [groupA, groupB] = contentLayer.children;
    expect(contentLayer.children).toEqual([groupA, groupB]);

    // 提交只登记变更并申请下一帧，显式冲刷后按 ChangeSet.orderChanged 重排
    engine.documentStore.updateNode('a', { zIndex: 'a3' });
    renderer.renderFrame();
    expect(contentLayer.children).toEqual([groupB, groupA]);

    renderer.destroy();
  });

  it('Esc 经焦点栈以最低优先级清空瞬态图元 (持久图元保留)，销毁后注销作用域', () => {
    const engine = new SkyNoteEngine();
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 1000 });
    Object.defineProperty(container, 'clientHeight', { value: 800 });
    const renderer = new LeaferRenderer(engine, container);

    const ephemeralGroup = renderer.contentLayer.parent!.children[2] as unknown as { children: unknown[] };
    // 经引擎宿主写入 (与交互插件的路径一致)：框选为瞬态，选中框为持久
    engine.host.overlay.setPrimitives('marquee', [{ kind: 'rect', x: 0, y: 0, width: 10, height: 10 }], {
      transient: true
    });
    engine.host.overlay.setPrimitives('selection', [{ kind: 'rect', x: 0, y: 0, width: 20, height: 20 }]);
    expect(ephemeralGroup.children.length).toBe(2);

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
    expect(ephemeralGroup.children.length).toBe(1);

    renderer.destroy();
    expect(engine.inputScopes.hasScope('renderer:overlay-escape')).toBe(false);
    // 卸载后引擎回到空宿主
    expect(engine.host).toBe(DETACHED_CANVAS_HOST);
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

      const container = document.createElement('div');
      const widthRead = vi.fn(() => 400);
      Object.defineProperty(container, 'clientWidth', { get: widthRead });
      Object.defineProperty(container, 'clientHeight', { value: 300 });
      const renderer = new LeaferRenderer(engine, container, { enableFrameScheduler: false });
      const contentLayer = renderer.contentLayer;
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

describe('LeaferAdapter', () => {
  it('成对提供 Leafer 文本测量器与渲染器，挂载即接管引擎宿主，销毁后解除', () => {
    const adapter = new LeaferAdapter({ enableFrameScheduler: false });
    expect(adapter.textMeasurer).toBeInstanceOf(LeaferTextMeasurer);

    const engine = new SkyNoteEngine({ textMeasurer: adapter.textMeasurer });
    const renderer = adapter.mount(engine, document.createElement('div'));
    expect(renderer).toBeInstanceOf(LeaferRenderer);
    expect(engine.host).not.toBe(DETACHED_CANVAS_HOST);

    renderer.destroy();
    expect(engine.host).toBe(DETACHED_CANVAS_HOST);
    engine.destroy();
  });
});
