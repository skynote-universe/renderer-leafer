import './setup';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DETACHED_CANVAS_HOST, SkyNoteEngine } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';
import { LeaferAdapter } from '../src/adapter/leafer-adapter';
import { LeaferFontMeasurer } from '../src/text/leafer-font-measurer';

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
  it('成对提供 Leafer 字体测量器与渲染器，挂载即接管引擎宿主，销毁后解除', () => {
    const adapter = new LeaferAdapter({ enableFrameScheduler: false });
    expect(adapter.fonts).toBeInstanceOf(LeaferFontMeasurer);

    const engine = new SkyNoteEngine({ fonts: adapter.fonts });
    const renderer = adapter.mount(engine, document.createElement('div'));
    expect(renderer).toBeInstanceOf(LeaferRenderer);
    expect(engine.host).not.toBe(DETACHED_CANVAS_HOST);

    renderer.destroy();
    expect(engine.host).toBe(DETACHED_CANVAS_HOST);
    engine.destroy();
  });

  it('专有结构 validate 校验失败时局部降级为占位框且不逐帧重复报错；动态注册类型与进入维护冻结时同步响应', () => {
    const engine = new SkyNoteEngine();
    let validateCalls = 0;
    let composeCalls = 0;

    engine.documentStore.addNode({
      id: 'path_1',
      type: 'node',
      nodeType: 'custom:path',
      x: 20,
      y: 20,
      width: 100,
      height: 60,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      data: { broken: true }
    });

    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800 });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const renderer = new LeaferRenderer(engine, container, { enableFrameScheduler: false });

    // 1. 动态晚注册节点类型且首次校验失败：自动降级为占位框，compose 不被调用
    engine.nodeTypes.register({
      type: 'custom:path',
      label: '路径',
      defaultData: { broken: false },
      validate: (node) => {
        validateCalls++;
        return (node.data as { broken?: boolean })?.broken ? '路径锚点非法' : null;
      },
      compose: () => {
        composeCalls++;
        return [{ kind: 'path', d: 'M 0 0 L 100 60', stroke: '$accent', strokeWidth: 2 }];
      }
    });
    renderer.renderFrame();
    expect(validateCalls).toBe(1);
    expect(composeCalls).toBe(0);
    expect(errorSpy).toHaveBeenCalledOnce();

    // 2. 后续无关帧 (如平移视口) 不重复执行 validate 或抛错
    engine.session.setViewport({ x: 10, y: 10 });
    renderer.renderFrame();
    expect(validateCalls).toBe(1);
    expect(errorSpy).toHaveBeenCalledOnce();

    // 3. 修复节点数据后恢复正常 compose 绘制
    engine.documentStore.updateNode('path_1', { data: { broken: false } });
    renderer.renderFrame();
    expect(composeCalls).toBe(1);

    // 4. 进入 beginMaintenance 时立即清空瞬态覆盖层 (保留持久覆盖层)
    const ephemeralGroup = renderer.contentLayer.parent!.children[2] as unknown as { children: unknown[] };
    engine.host.overlay.setPrimitives('draft:ink', [{ kind: 'path', d: 'M 0 0 L 10 10' }], { transient: true });
    engine.host.overlay.setPrimitives('selection:outline', [{ kind: 'rect', x: 0, y: 0, width: 10, height: 10 }]);
    expect(ephemeralGroup.children.length).toBe(2);

    const maintenance = engine.beginMaintenance();
    expect(ephemeralGroup.children.length).toBe(1);
    maintenance.resume();

    // 5. 覆盖层图元颜色引用解析：$red 等调色板变量经主题自动转为真实色值
    engine.host.overlay.setPrimitives('draft:palette', [{ kind: 'path', d: 'M 0 0 L 10 10', stroke: '$red' }]);
    const paletteSession = (ephemeralGroup.children as Array<{ children: Array<{ stroke: string }> }>).at(-1);
    expect(paletteSession?.children[0]?.stroke).toBe(engine.session.theme.palette.red);

    errorSpy.mockRestore();
    renderer.destroy();
    engine.destroy();
  });
});
