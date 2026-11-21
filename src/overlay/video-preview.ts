import type { AssetAdapter } from '@skynote/core';
import type { VideoControlsMount } from '../types';
import { PreviewFrame } from './preview-frame';

const MIN_LOADING_DISPLAY_MS = 240;

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

export class VideoPreview extends PreviewFrame {
  private readonly hint: HTMLSpanElement;
  private readonly video: HTMLVideoElement;
  private readonly controller = new AbortController();
  private url?: string;
  private poster?: PreviewPoster;
  private hasPlayed = false;
  private failed = false;
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
    const status = doc.createElement('div');
    status.className = 'skynote-video-preview-status';
    status.setAttribute('role', 'status');
    const badge = doc.createElement('span');
    const spinner = doc.createElement('span');
    spinner.setAttribute('aria-hidden', 'true');
    const message = doc.createElement('span');
    message.textContent = '正在加载视频';
    badge.append(spinner, message);
    status.append(badge);
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
    Object.assign(status.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      background: 'color-mix(in srgb, var(--sn-canvas, Canvas) 48%, transparent)'
    });
    Object.assign(badge.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      maxWidth: '90%',
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 10px',
      borderRadius: '9999px',
      fontSize: '12px',
      color: 'var(--sn-text, CanvasText)',
      background: 'var(--sn-surface, Canvas)'
    });
    Object.assign(spinner.style, {
      width: '14px',
      height: '14px',
      flexShrink: '0',
      borderRadius: '50%',
      border: '2px solid var(--sn-border, currentColor)',
      borderTopColor: 'var(--sn-accent, currentColor)'
    });
    this.content.append(this.video);
    this.surface.insertBefore(status, this.shield);

    const { signal } = this.controller;
    const reduceMotion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const animation =
      source && !reduceMotion
        ? spinner.animate?.([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
            duration: 800,
            iterations: Infinity
          })
        : undefined;
    // 循环动画在加载结束或节点卸载时取消，finished 会以 AbortError 结束。
    void animation?.finished.catch(() => {});
    const loadingStarted = performance.now();
    let loadingTimer: ReturnType<typeof setTimeout> | undefined;
    const finishLoading = () => {
      clearTimeout(loadingTimer);
      animation?.cancel();
    };
    signal.addEventListener('abort', finishLoading, { once: true });
    const showFailure = (text: string) => {
      finishLoading();
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
    };
    this.video.addEventListener(
      'loadedmetadata',
      () => {
        const time = this.restoreTime;
        this.restoreTime = undefined;
        if (time && Number.isFinite(this.video.duration)) this.video.currentTime = Math.min(time, this.video.duration);
        loadingTimer = setTimeout(
          () => {
            animation?.cancel();
            status.hidden = true;
          },
          Math.max(0, MIN_LOADING_DISPLAY_MS - (performance.now() - loadingStarted))
        );
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
    this.hint.hidden = !showHint;
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
