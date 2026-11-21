import { getPlainText, type AssetAdapter, type NodeEntity, type SkyNoteEngine } from '@skynote/core';
import { getVideoAsset, getVideoFields } from '../node/video-fields';
import type { VideoControlsMount } from '../types';
import { PreviewFrame } from './preview-frame';
import type { ContentPreviewInstance, ContentPreviewRenderer } from './preview-registry';

interface PreviewPoster {
  readonly src: string;
  readonly controller: AbortController;
  url?: string;
}

export interface PreviewPlayback {
  readonly source: string;
  readonly time: number;
  readonly rate: number;
  readonly volume: number;
  readonly muted: boolean;
}

export class VideoPreview extends PreviewFrame implements ContentPreviewInstance {
  private readonly hint: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private readonly video: HTMLVideoElement;
  private readonly controller = new AbortController();
  private url?: string;
  private poster?: PreviewPoster;
  private hasPlayed = false;
  private failed = false;
  private hintRequested = false;
  private restoreTime?: number;
  private releaseControls?: () => void;

  constructor(
    doc: Document,
    nodeId: string,
    readonly source: string | undefined,
    private readonly assets: AssetAdapter,
    mountControls: VideoControlsMount | undefined,
    playback: PreviewPlayback | undefined,
    onExit: (restoreFocus?: boolean) => void,
    onInactive: () => void
  ) {
    super(doc, nodeId);
    this.element.className = 'skynote-video-preview';
    this.content.addEventListener(
      'focusout',
      (event) => {
        if (
          doc.fullscreenElement !== this.content &&
          !(typeof this.content.showPopover === 'function' && this.content.matches(':popover-open')) &&
          !this.content.contains(event.relatedTarget as Node | null)
        )
          onExit();
      },
      { signal: this.controller.signal }
    );
    this.hint = doc.createElement('span');
    this.hint.className = 'skynote-video-preview-hint';
    this.hint.textContent = '再次点击或按 Enter 操作视频';
    this.hint.hidden = true;
    this.shield.append(this.hint);
    this.video = doc.createElement('video');
    this.video.tabIndex = 0;
    this.video.playsInline = true;
    this.video.preload = 'metadata';
    this.video.controls = true;
    this.restoreTime = playback?.time;
    if (playback) {
      this.video.defaultPlaybackRate = playback.rate;
      this.video.playbackRate = playback.rate;
      this.video.volume = playback.volume;
      this.video.muted = playback.muted;
      if (playback.time > 0) {
        this.hasPlayed = true;
        this.video.preload = 'auto';
      }
    }
    this.video.setAttribute('aria-label', '视频');
    Object.assign(this.hint.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: 'max-content',
      maxWidth: 'calc(100% - 8px)',
      boxSizing: 'border-box',
      padding: '4px 8px',
      borderRadius: '9999px',
      fontSize: '12px',
      lineHeight: '16px',
      textAlign: 'center',
      overflowWrap: 'anywhere',
      color: 'var(--sn-text, CanvasText)',
      background: 'var(--sn-surface, Canvas)',
      boxShadow: 'var(--sn-shadow-tooltip, 0 2px 8px rgb(0 0 0 / 18%))',
      pointerEvents: 'none'
    });
    // 画布选框已经标明焦点节点。只移除视频元素外框，控件继续使用自己的键盘焦点样式。
    Object.assign(this.video.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      outlineStyle: 'none'
    });
    this.content.append(this.video);

    const { signal } = this.controller;
    const loading = this.createStatus({
      className: 'skynote-video-preview-status',
      text: '正在加载视频',
      animate: Boolean(source),
      signal
    });
    const { status, spinner, message } = loading;
    this.status = status;
    const showFailure = (text: string) => {
      loading.cancel();
      this.failed = true;
      this.video.controls = false;
      onExit(true);
      this.setInteractive(false);
      if (this.video.hasAttribute('src')) {
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
      }
      if (this.poster?.url) {
        this.video.setAttribute('poster', this.poster.url);
        this.video.style.objectFit = 'cover';
      }
      spinner.remove();
      message.textContent = `${text}，请选中节点后替换视频`;
      status.hidden = false;
      this.syncHint();
    };
    this.video.addEventListener(
      'loadedmetadata',
      () => {
        const time = this.restoreTime;
        this.restoreTime = undefined;
        if (time && Number.isFinite(this.video.duration)) this.video.currentTime = Math.min(time, this.video.duration);
        loading.finish(() => this.syncHint());
      },
      { signal, once: true }
    );
    this.video.addEventListener('error', () => showFailure('视频无法播放'), { signal });
    this.video.addEventListener(
      'play',
      () => {
        this.hasPlayed = true;
        this.video.style.objectFit = 'contain';
      },
      { signal, once: true }
    );
    for (const type of ['pause', 'ended'])
      this.video.addEventListener(
        type,
        () => {
          if (this.element.hidden) onInactive();
        },
        { signal }
      );
    if (source && mountControls) {
      try {
        this.releaseControls = mountControls(this.content, this.video, signal);
        this.video.controls = false;
      } catch (error) {
        console.warn('[SkyNote:Video] 自定义控件挂载失败，回退原生播放器', error);
      }
    }
    // 控件先消费倍速菜单和窗口内全屏的 Esc，其余 Esc 交给画布焦点栈。
    this.content.addEventListener(
      'keydown',
      (event) => {
        if (
          event.isComposing ||
          event.keyCode === 229 ||
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          doc.fullscreenElement === this.content ||
          (typeof this.content.showPopover === 'function' && this.content.matches(':popover-open'))
        )
          event.stopPropagation();
      },
      { signal }
    );
    if (!source) {
      showFailure('视频资产不可用');
      return;
    }
    void Promise.resolve()
      .then(() => assets.resolve(source, { signal }))
      .then((url) => {
        if (signal.aborted) assets.release?.(source, url);
        else {
          this.url = url;
          this.video.src = url;
        }
      })
      .catch(() => {
        if (!signal.aborted) showFailure('视频资产不可用');
      });
  }

  get playing(): boolean {
    return !this.video.paused && !this.video.ended;
  }

  get keepAliveWhenOffscreen(): boolean {
    return this.playing;
  }

  get canInteract(): boolean {
    return !this.failed;
  }

  get playback(): PreviewPlayback | undefined {
    if (!this.source) return undefined;
    const { currentTime, playbackRate, volume, muted } = this.video;
    const time = this.restoreTime ?? currentTime;
    if (!(time || playbackRate !== 1 || volume !== 1 || muted)) return undefined;
    return { source: this.source, time, rate: playbackRate, volume, muted };
  }

  captureState(): PreviewPlayback | undefined {
    return this.playback;
  }

  update(engine: SkyNoteEngine, node: Readonly<NodeEntity>): void {
    const posterId = getVideoFields(node)?.posterAssetId;
    const poster = posterId ? engine.documentStore.getView().assets?.[posterId] : undefined;
    this.setPoster(poster?.mimeType.startsWith('image/') ? poster.src : undefined);
    const titleBlock = node.textBlocks?.find((block) => block.slot === 'title');
    const label = (titleBlock ? getPlainText(titleBlock).trim() : '') || '视频';
    if (this.video.getAttribute('aria-label') !== label) this.video.setAttribute('aria-label', label);
  }

  setPoster(src: string | undefined): void {
    if (this.poster?.src === src) return;
    if (this.poster) {
      const previous = this.poster;
      this.poster = undefined;
      previous.controller.abort();
      this.video.removeAttribute('poster');
      this.video.style.objectFit = 'contain';
      if (previous.url) this.assets.release?.(previous.src, previous.url);
    }
    if (!src) return;
    const poster: PreviewPoster = { src, controller: new AbortController() };
    this.poster = poster;
    const { signal } = poster.controller;
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return this.assets.resolve(src, { signal });
      })
      .then((url) => {
        if (signal.aborted) this.assets.release?.(src, url);
        else {
          poster.url = url;
          if (!this.hasPlayed || this.failed) {
            this.video.setAttribute('poster', url);
            this.video.style.objectFit = 'cover';
          }
        }
      })
      .catch(() => {
        // 封面不可用时继续加载并显示视频。
      });
  }

  override setInteractive(interactive: boolean, showHint = false): void {
    super.setInteractive(interactive);
    this.hintRequested = !interactive && showHint;
    this.syncHint();
  }

  /** 加载中或异常状态浮层展示期间隐藏居中交互提示，避免重叠遮挡 */
  private syncHint(): void {
    this.hint.hidden = !this.hintRequested || !this.status.hidden;
  }

  focus(): void {
    this.video.focus({ preventScroll: true });
  }

  destroy(): void {
    this.controller.abort();
    this.setPoster(undefined);
    try {
      this.releaseControls?.();
    } catch (error) {
      console.warn('[SkyNote:Video] 自定义控件释放失败', error);
    } finally {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.element.remove();
      if (this.source && this.url) this.assets.release?.(this.source, this.url);
    }
  }
}

export function createVideoPreviewRenderer(mountControls?: VideoControlsMount): ContentPreviewRenderer {
  return {
    nodeType: 'video',
    resolveSource(engine, node) {
      if (!engine.assets || getVideoFields(node)?.displayMode !== 'preview') return undefined;
      return { source: getVideoAsset(engine, node)?.src };
    },
    create({ doc, engine, node, source, savedState, onExit, requestRender }) {
      const playback =
        savedState && typeof savedState === 'object' && (savedState as PreviewPlayback).source === source
          ? (savedState as PreviewPlayback)
          : undefined;
      return new VideoPreview(doc, node.id, source, engine.assets!, mountControls, playback, onExit, requestRender);
    },
    shouldKeepSavedState(engine, node, savedState) {
      const saved = savedState as PreviewPlayback | undefined;
      return (
        !!saved && getVideoFields(node)?.displayMode === 'preview' && getVideoAsset(engine, node)?.src === saved.source
      );
    }
  };
}
