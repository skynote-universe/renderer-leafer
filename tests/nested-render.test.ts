import './setup';
import { describe, it, expect } from 'vitest';
import { Box, type Group } from 'leafer';
import { SkyNoteEngine } from '@skynote/core';
import type { ConnectorEntity, NodeEntity, RectBounds } from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';
import type { NodeLayer } from '../src/layers/node-layer';
import type { ConnectorLayer } from '../src/layers/connector-layer';

function makeNode(id: string, patch: Partial<NodeEntity> = {}): NodeEntity {
  return {
    id,
    type: 'node',
    nodeType: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 'a0',
    locked: false,
    ...patch
  };
}

function makeConnector(id: string, from: string, to: string): ConnectorEntity {
  return {
    id,
    type: 'connector',
    connectorType: 'straight',
    from: { nodeId: from },
    to: { nodeId: to },
    zIndex: 'a0',
    locked: false
  };
}

function mount(engine: SkyNoteEngine): LeaferRenderer {
  const renderer = new LeaferRenderer(engine, { enableFrameScheduler: false });
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 1000 });
  Object.defineProperty(container, 'clientHeight', { value: 800 });
  renderer.mount(container);
  return renderer;
}

function layers(renderer: LeaferRenderer) {
  return renderer as unknown as { nodeLayer: NodeLayer; connectorLayer: ConnectorLayer };
}

/** 图元相对内容层 (即世界坐标，视口变换在内容层之上) 的包围盒 */
function sceneBounds(renderer: LeaferRenderer, group: Group) {
  return group.getBounds('box', renderer.getContentLayer()!);
}

function expectBoundsClose(actual: { x: number; y: number; width: number; height: number }, expected: RectBounds) {
  expect(actual.x).toBeCloseTo(expected.left, 4);
  expect(actual.y).toBeCloseTo(expected.top, 4);
  expect(actual.width).toBeCloseTo(expected.width, 4);
  expect(actual.height).toBeCloseTo(expected.height, 4);
}

describe('嵌套渲染 (ADR-114)', () => {
  it('子节点挂在父节点的子容器中，旋转容器内子节点的场景包围盒与内核世界包围盒一致', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { x: 100, y: 100, width: 300, height: 200, rotation: 30 }));
    store.addNode(makeNode('card', { x: 20, y: 30, width: 60, height: 40, rotation: 15, parentId: 'frame' }));
    const renderer = mount(engine);
    const { nodeLayer } = layers(renderer);

    const cardGroup = nodeLayer.getGroup('card')!;
    expect(cardGroup.parent).toBe(nodeLayer.getChildrenContainer('frame'));
    expect(renderer.getContentLayer()!.children).toEqual([nodeLayer.getGroup('frame')]);
    expectBoundsClose(sceneBounds(renderer, cardGroup), engine.getNodeWorldBounds('card')!);

    // 移动容器：只有容器图元变化，子节点随之移动且与内核一致
    store.moveNodes(['frame'], { x: 50, y: -20 });
    renderer.renderFrame();
    expect(cardGroup.x).toBe(20);
    expectBoundsClose(sceneBounds(renderer, cardGroup), engine.getNodeWorldBounds('card')!);
    renderer.destroy();
  });

  it('子节点可见而父节点不在视锥内时，父节点仍被挂载以承载子节点', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    // 父框在视口左侧之外，子节点伸入视口
    store.addNode(makeNode('frame', { x: -3000, y: 0, width: 100, height: 100 }));
    store.addNode(makeNode('card', { x: 3100, y: 10, width: 50, height: 50, parentId: 'frame' }));
    const renderer = mount(engine);
    const { nodeLayer } = layers(renderer);

    expect(nodeLayer.shownIds.has('card')).toBe(true);
    expect(nodeLayer.shownIds.has('frame')).toBe(true);
    expect(nodeLayer.getGroup('card')!.parent).toBe(nodeLayer.getChildrenContainer('frame'));
    renderer.destroy();
  });

  it('裁剪型容器用 overflow: hide 的 Box 承载子节点；超出容器的部分不可拾取', () => {
    const engine = new SkyNoteEngine();
    engine.nodeTypes.register({ type: 'frame', label: '画框', defaultData: {}, clipChildren: true });
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { nodeType: 'frame', width: 200, height: 200 }));
    store.addNode(makeNode('card', { x: 150, y: 50, width: 100, height: 50, parentId: 'frame' }));
    const renderer = mount(engine);

    const childrenContainer = layers(renderer).nodeLayer.getChildrenContainer('frame')!;
    expect(childrenContainer).toBeInstanceOf(Box);
    expect((childrenContainer as Box).overflow).toBe('hide');

    expect(renderer.hitTest({ x: 180, y: 70 })?.id).toBe('card');
    // 卡片超出画框的部分 (x > 200) 被裁剪，落在其上只可能命中空白
    expect(renderer.hitTest({ x: 230, y: 70 })).toBeUndefined();
    renderer.destroy();
  });

  it('连线挂载：同容器连线挂在容器内，跨容器连线挂在公共祖先并紧贴容器上方，路由保持世界坐标', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('outside', { x: 600, y: 100, width: 50, height: 50, zIndex: 'a0' }));
    store.addNode(makeNode('frame', { x: 100, y: 100, width: 300, height: 300, rotation: 20, zIndex: 'a1' }));
    store.addNode(makeNode('b', { x: 20, y: 20, width: 40, height: 40, parentId: 'frame', zIndex: 'a0' }));
    store.addNode(makeNode('c', { x: 200, y: 200, width: 40, height: 40, parentId: 'frame', zIndex: 'a1' }));
    for (const connector of [makeConnector('inner', 'b', 'c'), makeConnector('cross', 'outside', 'b')]) {
      store.commit({ patches: [{ op: 'set', path: ['content', 'connectors', connector.id], value: connector }] });
    }
    const renderer = mount(engine);
    const { nodeLayer, connectorLayer } = layers(renderer);
    const contentLayer = renderer.getContentLayer()!;

    const inner = connectorLayer.getGroup('inner')!;
    const frameChildren = nodeLayer.getChildrenContainer('frame')!;
    expect(inner.parent).toBe(frameChildren);
    // 容器内：连线紧贴较高端点 c 下方
    expect(frameChildren.children).toEqual([nodeLayer.getGroup('b'), inner, nodeLayer.getGroup('c')]);

    const cross = connectorLayer.getGroup('cross')!;
    expect(contentLayer.children).toEqual([nodeLayer.getGroup('outside'), nodeLayer.getGroup('frame'), cross]);

    // 连线图元以容器逆矩阵抵消容器旋转，场景包围盒等于内核路由包围盒
    expectBoundsClose(sceneBounds(renderer, inner), engine.getConnectorRoute('inner')!.bounds);
    expectBoundsClose(sceneBounds(renderer, cross), engine.getConnectorRoute('cross')!.bounds);

    store.moveNodes(['frame'], { x: 40 });
    store.updateNode('frame', { rotation: 45 });
    renderer.renderFrame();
    expectBoundsClose(sceneBounds(renderer, inner), engine.getConnectorRoute('inner')!.bounds);
    renderer.destroy();
  });

  it('改挂容器后图元换挂到新容器并按新层级定位，移出到根层级同样生效', () => {
    const engine = new SkyNoteEngine();
    const store = engine.documentStore;
    store.addNode(makeNode('frame', { x: 100, y: 100, width: 300, height: 300, rotation: 10, zIndex: 'a0' }));
    store.addNode(makeNode('existing', { parentId: 'frame', width: 20, height: 20 }));
    store.addNode(makeNode('card', { x: 150, y: 150, width: 40, height: 40, zIndex: 'a1' }));
    const renderer = mount(engine);
    const { nodeLayer } = layers(renderer);
    const before = engine.getNodeWorldBounds('card')!;

    store.reparentNodes(['card'], 'frame');
    renderer.renderFrame();
    const cardGroup = nodeLayer.getGroup('card')!;
    expect(nodeLayer.getChildrenContainer('frame')!.children).toEqual([nodeLayer.getGroup('existing'), cardGroup]);
    expectBoundsClose(sceneBounds(renderer, cardGroup), before);

    store.reparentNodes(['card'], undefined);
    renderer.renderFrame();
    expect(cardGroup.parent).toBe(renderer.getContentLayer());
    expectBoundsClose(sceneBounds(renderer, cardGroup), before);
    renderer.destroy();
  });
});
