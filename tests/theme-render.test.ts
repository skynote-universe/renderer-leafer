import './setup';
import { describe, it, expect } from 'vitest';
import { SkyNoteEngine, DARK_CANVAS_THEME_SEED, LIGHT_CANVAS_THEME_SEED } from '@skynote/core';
import type { NodeEntity, ConnectorEntity, CanvasTheme } from '@skynote/core';
import { createLeaferRenderer, type LeaferRenderer } from '../src/leafer-renderer';

function makeNode(id: string, x: number, nodeType = 'rect'): NodeEntity {
  return { id, type: 'node', nodeType, x, y: 0, width: 50, height: 50, rotation: 0, zIndex: 1, locked: false };
}

function mountRenderer(engine: SkyNoteEngine): LeaferRenderer {
  const renderer = createLeaferRenderer(engine);
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 1000 });
  Object.defineProperty(container, 'clientHeight', { value: 800 });
  renderer.mount(container);
  return renderer;
}

/** 读取内容层中第 index 个节点的首个图元 */
function firstShapeOf(renderer: LeaferRenderer, index: number): Record<string, unknown> {
  const outerGroup = renderer.getContentLayer()!.children[index] as unknown as { children: { children: Record<string, unknown>[] }[] };
  return outerGroup.children[0].children[0];
}

describe('LeaferRenderer 主题驱动配色', () => {
  it('未设置颜色的节点取主题缺省色，显式色值保持不变；切换主题后重绘并更新画布底色', () => {
    const engine = new SkyNoteEngine({ theme: { seed: LIGHT_CANVAS_THEME_SEED } });
    engine.documentStore.addNode(makeNode('plain', 0));
    engine.documentStore.addNode({ ...makeNode('custom', 100), style: { fill: '#FF0000' } });
    const renderer = mountRenderer(engine);
    const light = engine.session.theme;

    expect(firstShapeOf(renderer, 0).fill).toBe(light.nodeFill);
    expect(firstShapeOf(renderer, 0).stroke).toBe(light.nodeStroke);

    engine.session.setTheme({ seed: DARK_CANVAS_THEME_SEED });
    renderer.renderFrame();
    const dark = engine.session.theme;

    expect(firstShapeOf(renderer, 0).fill).toBe(dark.nodeFill);
    expect(firstShapeOf(renderer, 1).fill).toBe('#FF0000');
    const leafer = renderer.getContentLayer()!.parent!.parent as unknown as { fill: string };
    expect(leafer.fill).toBe(dark.background);
    renderer.destroy();
  });

  it('compose() 接收当前主题，$名称引用从调色板解析', () => {
    const engine = new SkyNoteEngine({
      theme: { seed: { ...LIGHT_CANVAS_THEME_SEED, palette: { brand: '#123456' } } }
    });
    const seenThemes: CanvasTheme[] = [];
    engine.nodeTypes.register({
      type: 'badge',
      compose: (node: NodeEntity, context: { theme: CanvasTheme }) => {
        seenThemes.push(context.theme);
        return [{ kind: 'rect', x: 0, y: 0, width: node.width, height: node.height, fill: '$brand' }];
      }
    } as never);
    engine.documentStore.addNode(makeNode('b', 0, 'badge'));

    const renderer = mountRenderer(engine);
    expect(seenThemes[0]).toBe(engine.session.theme);
    expect(firstShapeOf(renderer, 0).fill).toBe('#123456');
    renderer.destroy();
  });

  it('空心箭头随主题取画布底色，深色主题下不再是白色', () => {
    const engine = new SkyNoteEngine({ theme: { seed: DARK_CANVAS_THEME_SEED } });
    engine.documentStore.addNode(makeNode('a', 0));
    engine.documentStore.addNode(makeNode('b', 300));
    const connector: ConnectorEntity = {
      id: 'c1',
      type: 'connector',
      connectorType: 'straight',
      from: { nodeId: 'a' },
      to: { nodeId: 'b' },
      zIndex: 0,
      locked: false,
      style: { endArrow: 'standard:triangle' }
    };
    engine.documentStore.commit({ patches: [{ op: 'set', path: ['content', 'connectors', 'c1'], value: connector }] });

    const renderer = mountRenderer(engine);
    const connectorGroup = renderer
      .getContentLayer()!
      .children.find((child) => (child as unknown as { children: unknown[] }).children.length === 2) as unknown as {
      children: Record<string, unknown>[];
    };
    const [line, marker] = connectorGroup.children;
    expect(line.stroke).toBe(engine.session.theme.connectorStroke);
    expect(marker.fill).toBe(DARK_CANVAS_THEME_SEED.background);
    renderer.destroy();
  });
});
