// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkyNoteEngine, type AssetAdapter } from '@skynote/core';
import { PREVIEW_CONTENT_ATTRIBUTE, PREVIEW_TARGET_ATTRIBUTE } from '../src/overlay/preview-frame';
import { ContentPreviews } from '../src/overlay/content-previews';
import { previewOutline } from '../src/overlay/preview-clip';

function fixture(assets?: AssetAdapter) {
  const engine = new SkyNoteEngine({ assets });
  engine.nodeTypes.register({
    type: 'video',
    label: '视频',
    defaultData: {},
    createContent: () => ({ width: 100, height: 60, video: { assetId: 'source' } })
  });
  engine.session.setViewportSize({ width: 350, height: 200 });
  const nodeId = engine.documentStore.createNodeWithAsset(
    { nodeType: 'video', x: 20, y: 30 },
    { id: 'source', src: 'stored', mimeType: 'video/mp4' }
  )!;
  const host = document.createElement('div');
  document.body.append(host);
  engine.session.setSelection({ nodeIds: [nodeId] });
  return { engine, host, nodeId };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setMode(engine: SkyNoteEngine, ids: string[], displayMode: 'card' | 'preview'): void {
  engine.documentStore.commit({
    label: '设置视频显示方式',
    patches: ids.map((id) => ({
      op: 'set',
      path: ['content', 'nodes', id, 'video', 'displayMode'],
      value: displayMode
    }))
  });
}

function setPoster(engine: SkyNoteEngine, nodeId: string, poster: { id: string; src: string; mimeType: string }): void {
  engine.documentStore.updateNodesWithAssets([nodeId], [poster], (node) => {
    const video = (node as { video?: Record<string, unknown> }).video;
    return video ? ({ video: { ...video, posterAssetId: poster.id } } as Record<string, unknown>) : {};
  });
}

describe('视频预览层', () => {
  it('使用原生 poster，替换封面不重建视频，过期和卸载的 URL 都会释放', async () => {
    let finishOldPoster!: (url: string) => void;
    const release = vi.fn();
    const resolve = vi.fn((src: string) =>
      src === 'old-poster'
        ? new Promise<string>((resolve) => {
            finishOldPoster = resolve;
          })
        : Promise.resolve(`blob:${src}`)
    );
    const { engine, host, nodeId } = fixture({ upload: vi.fn(), resolve, release });
    setMode(engine, [nodeId], 'preview');
    setPoster(engine, nodeId, { id: 'old', src: 'old-poster', mimeType: 'image/png' });
    const previews = new ContentPreviews(engine, host);
    previews.sync([nodeId], false);
    const video = host.querySelector('video')!;
    await vi.waitFor(() => expect(finishOldPoster).toBeTypeOf('function'));
    setPoster(engine, nodeId, { id: 'new', src: 'new-poster', mimeType: 'image/png' });
    previews.sync([nodeId], false);
    finishOldPoster('blob:old-poster');
    await vi.waitFor(() => expect(video.getAttribute('poster')).toBe('blob:new-poster'));
    expect(video.style.objectFit).toBe('cover');
    video.dispatchEvent(new Event('play'));
    expect(video.style.objectFit).toBe('contain');
    expect(release).toHaveBeenCalledWith('old-poster', 'blob:old-poster');
    expect(host.querySelector('video')).toBe(video);
    expect(video.getAttribute('src')).toBe('blob:stored');
    previews.destroy();
    expect(release).toHaveBeenCalledWith('new-poster', 'blob:new-poster');
    expect(release).toHaveBeenCalledWith('stored', 'blob:stored');
    engine.destroy();
  });

  it('快速加载仍短暂显示加载提示，加载期间隐藏交互提示避免遮挡，错误可立即替换提示', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { engine, host, nodeId } = fixture({ upload: vi.fn(), resolve: async () => 'blob:source' });
    setMode(engine, [nodeId], 'preview');
    const preview = new ContentPreviews(engine, host);
    preview.sync([nodeId], false);
    const media = host.querySelector('video')!;
    const status = host.querySelector<HTMLElement>('.skynote-video-preview-status')!;
    const hint = host.querySelector<HTMLElement>('.skynote-video-preview-hint')!;
    expect(status.hidden).toBe(false);
    expect(hint.hidden).toBe(true);
    media.dispatchEvent(new Event('loadedmetadata'));
    vi.advanceTimersByTime(120);
    expect(status.hidden).toBe(false);
    expect(hint.hidden).toBe(true);
    vi.advanceTimersByTime(140);
    expect(status.hidden).toBe(true);
    expect(hint.hidden).toBe(false);
    media.dispatchEvent(new Event('error'));
    expect(status.hidden).toBe(false);
    expect(hint.hidden).toBe(true);
    expect(status.textContent).toContain('视频无法播放');
    expect(status.textContent).toContain('替换视频');
    preview.destroy();
    engine.destroy();
  });

  it('失去选区仍保留媒体，选中且完成手势后才开放 DOM 输入', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const release = vi.fn();
    const { engine, host, nodeId } = fixture({
      upload: vi.fn(),
      resolve: async () => 'blob:source',
      release
    });
    const preview = new ContentPreviews(engine, host);
    preview.sync([nodeId], false);
    expect(host.querySelector('video')).toBeNull();
    setMode(engine, [nodeId], 'preview');
    preview.sync([nodeId], false);
    await vi.waitFor(() => expect(host.querySelector('video')?.getAttribute('src')).toBe('blob:source'));
    const media = host.querySelector('video')!;
    const content = host.querySelector<HTMLElement>(`[${PREVIEW_CONTENT_ATTRIBUTE}]`)!;
    const hint = host.querySelector<HTMLElement>('.skynote-video-preview-hint')!;
    expect(media.controls).toBe(true);
    expect(play).not.toHaveBeenCalled();
    expect(content.inert).toBe(true);
    expect(content.style.inset).toBe('0px');
    // 加载未完成前隐藏居中交互提示，避免遮挡加载动画
    expect(hint.hidden).toBe(true);
    media.dispatchEvent(new Event('loadedmetadata'));
    await vi.waitFor(() => expect(hint.hidden).toBe(false));
    expect(hint.textContent).toBe('再次点击或按 Enter 操作视频');
    engine.session.setSelection({ nodeIds: [] });
    preview.sync([nodeId], false);
    expect(host.querySelector('video')).toBe(media);
    const shield = host.querySelector<HTMLElement>(`[${PREVIEW_TARGET_ATTRIBUTE}]`)!;
    expect(shield.style.inset).toBe(content.style.inset);
    expect(shield.hidden).toBe(false);
    expect(hint.hidden).toBe(true);
    expect(shield.getAttribute(PREVIEW_TARGET_ATTRIBUTE)).toBe(nodeId);
    engine.session.setSelection({ nodeIds: [nodeId] });
    preview.sync([nodeId], true);
    expect(shield.hidden).toBe(false);
    expect(hint.hidden).toBe(true);
    preview.sync([nodeId], false);
    expect(shield.hidden).toBe(false);
    expect(hint.hidden).toBe(false);
    preview.focus(nodeId);
    expect(shield.hidden).toBe(true);
    expect(hint.hidden).toBe(true);
    expect(document.activeElement).toBe(media);
    expect(media?.style.outlineStyle).toBe('none');
    host.tabIndex = 0;
    host.focus();
    expect(shield.hidden).toBe(false);
    expect(hint.hidden).toBe(false);
    setMode(engine, [nodeId], 'card');
    preview.sync([nodeId], false);
    expect(host.querySelector('video')).toBeNull();
    expect(release).toHaveBeenCalledExactlyOnceWith('stored', 'blob:source');
    preview.destroy();
    engine.destroy();
  });

  it('离屏暂停释放媒体并记住进度，滚出视口的播放继续，主动隐藏则暂停', async () => {
    const release = vi.fn();
    const { engine, host, nodeId } = fixture({ upload: vi.fn(), resolve: (src) => `blob:${src}`, release });
    engine.nodeTypes.register({
      type: 'group',
      label: '容器',
      defaultData: {},
      acceptsChildren: true,
      createContent: () => ({ width: 200, height: 160 })
    });
    engine.layouts.register({ id: 'tree', label: '树', collapsible: true, arrange: () => new Map() });
    const rootId = engine.documentStore.createNode({ nodeType: 'group', x: 0, y: 0, autoWrap: false })!;
    engine.documentStore.commit({
      label: '将视频放入可折叠布局',
      patches: [
        { op: 'set', path: ['content', 'nodes', rootId, 'layout'], value: { type: 'tree' } },
        { op: 'set', path: ['content', 'nodes', nodeId, 'parentId'], value: rootId },
        { op: 'set', path: ['content', 'nodes', nodeId, 'layoutItem'], value: {} }
      ]
    });
    expect(engine.documentStore.getNode(nodeId)).toMatchObject({ parentId: rootId, layoutItem: {} });
    expect(engine.documentStore.getNode(rootId)?.layout).toMatchObject({ type: 'tree' });
    setMode(engine, [nodeId], 'preview');
    const previews = new ContentPreviews(engine, host);
    const show = () => {
      previews.sync([nodeId], false);
      return host.querySelector('video')!;
    };
    const first = show();
    await vi.waitFor(() => expect(first.getAttribute('src')).toBe('blob:stored'));
    first.currentTime = 8;
    first.playbackRate = 1.5;
    first.muted = true;
    previews.sync([], false);
    expect(host.querySelector('video')).toBeNull();
    expect(release).toHaveBeenCalledWith('stored', 'blob:stored');

    const resumed = show();
    expect(resumed.playbackRate).toBe(1.5);
    expect(resumed.muted).toBe(true);
    vi.spyOn(resumed, 'duration', 'get').mockReturnValue(60);
    resumed.dispatchEvent(new Event('loadedmetadata'));
    expect(resumed.currentTime).toBe(8);
    vi.spyOn(resumed, 'paused', 'get').mockReturnValue(false);
    const pause = vi.spyOn(resumed, 'pause');
    previews.sync([], false);
    expect(host.querySelector('video')).toBe(resumed);
    expect(host.querySelector<HTMLElement>('.skynote-video-preview')?.hidden).toBe(true);
    expect(pause).not.toHaveBeenCalled();

    engine.documentStore.updateNode(rootId, { layoutState: { collapsed: true } });
    expect(engine.visibility.isNodeVisible(nodeId)).toBe(false);
    previews.sync([], false);
    expect(host.querySelector('video')).toBeNull();
    expect(pause).toHaveBeenCalledOnce();
    engine.documentStore.updateNode(rootId, { layoutState: { collapsed: false } });
    expect(show().paused).toBe(true);
    previews.destroy();
    engine.destroy();
  });

  it('视频源缺失时保留封面并提示替换，换回有效视频源后可以进入播放器', async () => {
    const { engine, host, nodeId } = fixture({ upload: vi.fn(), resolve: (src) => `blob:${src}` });
    setMode(engine, [nodeId], 'preview');
    setPoster(engine, nodeId, { id: 'poster', src: 'cover', mimeType: 'image/png' });
    engine.documentStore.commit({
      label: '移除视频资产记录',
      patches: [{ op: 'unset', path: ['assets', 'source'] }]
    });
    const mountControls = vi.fn(() => () => {});
    const previews = new ContentPreviews(engine, host, { mountVideoControls: mountControls });
    previews.sync([nodeId], false);
    const media = host.querySelector('video')!;
    await vi.waitFor(() => expect(media.getAttribute('poster')).toBe('blob:cover'));
    expect(media.hasAttribute('src')).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('视频资产不可用，请选中节点后替换视频');
    expect(previews.focus(nodeId)).toBe(false);
    expect(mountControls).not.toHaveBeenCalled();

    engine.documentStore.commit({
      label: '恢复视频资产记录',
      patches: [
        { op: 'set', path: ['assets', 'source'], value: { id: 'source', src: 'new-source', mimeType: 'video/mp4' } }
      ]
    });
    previews.sync([nodeId], false);
    expect(previews.focus(nodeId)).toBe(true);
    expect(mountControls).toHaveBeenCalledOnce();
    expect(previews.exitFocus()).toBe(true);
    expect(host.querySelector<HTMLElement>(`[${PREVIEW_CONTENT_ATTRIBUTE}]`)?.inert).toBe(true);
    previews.destroy();
    engine.destroy();
  });

  it('多个可见预览的加载与选中相互独立', async () => {
    const { engine, host, nodeId } = fixture({
      upload: vi.fn(),
      resolve: async () => 'blob:source'
    });
    const second = engine.documentStore.createNode({ nodeType: 'video', x: 140, y: 30 })!;
    setMode(engine, [nodeId, second], 'preview');
    const previews = new ContentPreviews(engine, host);
    previews.sync([nodeId, second], false);
    expect(host.querySelectorAll('video')).toHaveLength(2);
    const secondContent = host.querySelector<HTMLElement>(`[data-node-id="${second}"] [${PREVIEW_CONTENT_ATTRIBUTE}]`)!;
    expect(secondContent.inert).toBe(true);
    engine.session.setSelection({ nodeIds: [second] });
    previews.sync([nodeId, second], false);
    expect(secondContent.inert).toBe(true);
    previews.focus(second);
    expect(secondContent.inert).toBe(false);
    engine.session.setViewport({ x: 20, y: 30 });
    previews.updateViewport();
    expect(host.querySelector<HTMLElement>('.skynote-content-preview-world')?.style.transform).toBe(
      'translate3d(20px, 30px, 0)'
    );
    previews.destroy();
    engine.destroy();
  });

  it('按祖先画框和视口裁切预览', () => {
    const { engine, nodeId } = fixture();
    engine.nodeTypes.register({
      type: 'frame',
      label: '画框',
      defaultData: {},
      acceptsChildren: true,
      clipChildren: true,
      createContent: () => ({ width: 80, height: 50 })
    });
    const frame = engine.documentStore.createNode({ nodeType: 'frame', x: 12, y: 8, autoWrap: false })!;
    const nested = engine.documentStore.createNode({ nodeType: 'video', parentId: frame, x: 15, y: 10 })!;
    const points = previewOutline(engine, engine.documentStore.getNode(nested)!);
    expect(points).toHaveLength(4);
    expect(Math.min(...points.map((p) => p.x))).toBeCloseTo(27);
    expect(Math.max(...points.map((p) => p.x))).toBeCloseTo(92);
    expect(Math.max(...points.map((p) => p.y))).toBeCloseTo(58);
    expect(previewOutline(engine, engine.documentStore.getNode(nodeId)!)).toHaveLength(4);
    engine.destroy();
  });
});

describe('网页链接预览', () => {
  it('按宿主开关挂载隔离网页，与视频共享选区、层叠和离屏生命周期', () => {
    const { engine, host, nodeId } = fixture({ upload: vi.fn(), resolve: (src) => src });
    engine.nodeTypes.register({
      type: 'web-link',
      label: '网页链接',
      defaultData: {},
      createContent: () => ({
        width: 100,
        height: 80,
        textBlocks: [{ id: 'title', slot: 'title', runs: [{ text: '测试网页' }] }],
        webLink: { url: 'https://example.test/', displayMode: 'preview' }
      })
    });
    const page = engine.documentStore.createNode({ nodeType: 'web-link', x: 25, y: 35 })!;
    engine.documentStore.updateNode(page, { style: { strokeWidth: 2 } });
    setMode(engine, [nodeId], 'preview');
    const disabled = new ContentPreviews(engine, host);
    disabled.sync([page], false);
    expect(host.querySelector('iframe')).toBeNull();
    disabled.destroy();

    const previews = new ContentPreviews(engine, host, { enableWebLinkPreviews: true });
    previews.sync([page, nodeId], false);
    const frame = host.querySelector('iframe')!;
    const overlay = frame.closest<HTMLElement>('.skynote-web-link-preview')!;
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
    );
    expect(frame.referrerPolicy).toBe('no-referrer');
    expect(frame.title).toBe('测试网页');
    expect(frame.parentElement?.style.inset).toBe('2px');
    expect(frame.style.width).toBe('96px');
    expect(frame.style.height).toBe('76px');
    expect(frame.style.transform).toBe('scale(1, 1)');
    engine.documentStore.updateNode(page, { style: { radius: [20, 8, 1, 100] } });
    engine.session.setViewport({ zoom: 1.5 });
    previews.sync([page, nodeId], false);
    expect(frame.parentElement?.style.inset).toBe('3px');
    // 画布缩放时 iframe 保持逻辑宽高不变，通过 CSS scale 等比缩放，不触发内部网页重排
    expect(frame.style.width).toBe('96px');
    expect(frame.style.height).toBe('76px');
    expect(frame.style.transform).toBe('scale(1.5, 1.5)');
    expect(frame.parentElement?.style.borderRadius).toBe('27px 9px 0px 57px');
    expect(overlay.querySelector<HTMLElement>(`[${PREVIEW_TARGET_ATTRIBUTE}]`)?.style.borderRadius).toBe(
      '27px 9px 0px 57px'
    );
    expect(overlay.style.zIndex).toBe('1');
    expect(host.querySelector<HTMLElement>('.skynote-video-preview')?.style.zIndex).toBe('0');
    expect(previews.focus(page)).toBe(false);
    host.tabIndex = 0;
    engine.session.setSelection({ nodeIds: [page] });
    previews.sync([page, nodeId], false);
    expect(frame.parentElement?.inert).toBe(true);
    expect(previews.focus(page)).toBe(true);
    expect(frame.parentElement?.inert).toBe(false);
    expect(overlay.querySelector('button, a')).toBeNull();
    expect(previews.exitFocus()).toBe(true);
    expect(frame.parentElement?.inert).toBe(true);
    expect(document.activeElement).toBe(host);
    expect(host.querySelector('iframe')).toBe(frame);
    engine.documentStore.commit({
      label: '更改网页链接',
      patches: [{ op: 'set', path: ['content', 'nodes', page, 'webLink', 'url'], value: 'https://other.test/' }]
    });
    previews.sync([page, nodeId], false);
    expect(host.querySelector('iframe')).not.toBe(frame);
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://other.test/');
    previews.sync([nodeId], false);
    expect(host.querySelector('iframe')).toBeNull();
    previews.destroy();
    engine.destroy();
  });

  it('网页预览加载完成前显示 loading 且隐藏居中提示词，加载完成后切换显示交互提示', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { engine, host } = fixture({ upload: vi.fn(), resolve: () => 'blob:source' });
    engine.nodeTypes.register({
      type: 'web-link',
      label: '网页链接',
      defaultData: {},
      createContent: () => ({
        width: 180,
        height: 120,
        webLink: { url: 'https://example.test/', displayMode: 'preview' }
      })
    });
    const page = engine.documentStore.createNode({ nodeType: 'web-link', x: 25, y: 35 })!;
    engine.documentStore.updateNode(page, { style: { strokeWidth: 2, radius: 12 } });
    engine.session.setSelection({ nodeIds: [page] });
    const previews = new ContentPreviews(engine, host, { enableWebLinkPreviews: true });
    previews.sync([page], false);

    const frame = host.querySelector('iframe')!;
    const status = host.querySelector<HTMLElement>('.skynote-web-link-preview-status')!;
    const hint = host.querySelector<HTMLElement>('.skynote-web-link-preview-hint')!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('正在加载网页');
    expect(status.style.inset).toBe('2px');
    expect(status.style.borderRadius).toBe('10px');
    expect(hint.hidden).toBe(true);

    frame.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(120);
    expect(status.hidden).toBe(false);
    expect(hint.hidden).toBe(true);
    vi.advanceTimersByTime(140);
    expect(status.hidden).toBe(true);
    expect(hint.hidden).toBe(false);

    previews.destroy();
    engine.destroy();
  });

  it('跨源与同源网页预览均允许 allow-same-origin 以支持 ES Module 与页面自身存储', () => {
    const { engine, host } = fixture({ upload: vi.fn(), resolve: () => 'blob:source' });
    engine.nodeTypes.register({
      type: 'web-link',
      label: '网页链接',
      defaultData: {},
      createContent: () => ({ width: 180, height: 120 })
    });
    const crossOriginId = engine.documentStore.createNode({ nodeType: 'web-link', x: 0, y: 0 })!;
    const sameOriginId = engine.documentStore.createNode({ nodeType: 'web-link', x: 200, y: 0 })!;
    engine.documentStore.commit({
      label: '设置跨源与同源网页',
      patches: [
        {
          op: 'set',
          path: ['content', 'nodes', crossOriginId, 'webLink'],
          value: { url: 'https://example.test/docs', displayMode: 'preview' }
        },
        {
          op: 'set',
          path: ['content', 'nodes', sameOriginId, 'webLink'],
          value: { url: `${window.location.origin}/board/1`, displayMode: 'preview' }
        }
      ]
    });
    const previews = new ContentPreviews(engine, host, { enableWebLinkPreviews: true });
    previews.sync([crossOriginId, sameOriginId], false);

    const crossFrame = host.querySelector<HTMLIFrameElement>(`[data-node-id="${crossOriginId}"] iframe`)!;
    const sameFrame = host.querySelector<HTMLIFrameElement>(`[data-node-id="${sameOriginId}"] iframe`)!;
    const expectedSandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
    expect(crossFrame.getAttribute('sandbox')).toBe(expectedSandbox);
    expect(sameFrame.getAttribute('sandbox')).toBe(expectedSandbox);

    previews.destroy();
    engine.destroy();
  });

  it('只读模式下无需选中即可聚焦网页和视频预览，不显示常驻提示胶囊且退出聚焦后保持整洁', () => {
    const { engine, host, nodeId } = fixture({ upload: vi.fn(), resolve: () => 'blob:source' });
    engine.nodeTypes.register({
      type: 'web-link',
      label: '网页链接',
      defaultData: {},
      createContent: () => ({
        width: 180,
        height: 120,
        webLink: { url: 'https://example.test/', displayMode: 'preview' }
      })
    });
    const pageId = engine.documentStore.createNode({ nodeType: 'web-link', x: 200, y: 30 })!;
    setMode(engine, [nodeId], 'preview');
    engine.session.setReadOnly(true);
    engine.session.setSelection({ nodeIds: [] });

    const previews = new ContentPreviews(engine, host, { enableWebLinkPreviews: true });
    previews.sync([nodeId, pageId], false);

    const videoShield = host.querySelector<HTMLElement>(`[data-node-id="${nodeId}"] [${PREVIEW_TARGET_ATTRIBUTE}]`)!;
    const pageShield = host.querySelector<HTMLElement>(`[data-node-id="${pageId}"] [${PREVIEW_TARGET_ATTRIBUTE}]`)!;
    const videoHint = host.querySelector<HTMLElement>('.skynote-video-preview-hint')!;
    const pageHint = host.querySelector<HTMLElement>('.skynote-web-link-preview-hint')!;

    expect(videoShield.style.cursor).toBe('pointer');
    expect(pageShield.style.cursor).toBe('pointer');
    expect(videoHint.hidden).toBe(true);
    expect(pageHint.hidden).toBe(true);
    expect(previews.canFocus(nodeId)).toBe(true);
    expect(previews.canFocus(pageId)).toBe(true);

    expect(previews.focus(pageId)).toBe(true);
    expect(pageShield.hidden).toBe(true);
    expect(previews.exitFocus()).toBe(true);
    expect(pageShield.hidden).toBe(false);
    expect(pageHint.hidden).toBe(true);

    expect(previews.focus(nodeId)).toBe(true);
    expect(videoShield.hidden).toBe(true);
    expect(previews.exitFocus()).toBe(true);
    expect(videoShield.hidden).toBe(false);
    expect(videoHint.hidden).toBe(true);

    previews.destroy();
    engine.destroy();
  });
});
