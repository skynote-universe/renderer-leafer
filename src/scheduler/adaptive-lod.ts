/**
 * @file adaptive-lod.ts
 * @description 自适应细节级别 (LOD) 与视口动态降级控制器
 */

export type SkyNoteLodLevel = 'full' | 'reduced' | 'minimal';
export type SkyNoteDeviceTier = 'low' | 'standard' | 'high';

export interface AdaptiveLodDeviceProfile {
  hardwareConcurrency?: number | null;
  deviceMemoryGb?: number | null;
  devicePixelRatio?: number | null;
}

export interface AdaptiveLodOptions {
  enabled: boolean;
  sampleWindowMs: number;
  recoveryDelayMs: number;
  /**
   * 计时类降级至少需要的帧样本数：样本太少时 P95 就是个别慢帧 (首次排版、GC)，据此降级会误判
   */
  timingMinSamples: number;
  /**
   * 计时类降级要求的最少可见实体数 (节点 + 连线)：小场景的慢帧不是实体数量造成的，降级省不下时间，
   * 反而要把全部内容换成占位块再换回来，这两次重建本身就会让画面闪烁
   */
  timingMinVisibleEntities: number;
  reducedRenderP95Ms: number;
  minimalRenderP95Ms: number;
  reducedVisibleNodes: number;
  minimalVisibleNodes: number;
  reducedVisibleConnectors: number;
  minimalVisibleConnectors: number;
  reducedNodeObjects: number;
  minimalNodeObjects: number;
  reducedConnectorObjects: number;
  minimalConnectorObjects: number;
}

export interface AdaptiveLodInput {
  now: number;
  zoom: number;
  documentNodes: number;
  documentConnectors: number;
  visibleNodes: number;
  visibleConnectors: number;
  nodeObjects: number;
  connectorObjects: number;
  isInteracting: boolean;
}

export interface SkyNoteAdaptiveLodState {
  level: SkyNoteLodLevel;
  desiredLevel: SkyNoteLodLevel;
  deviceTier: SkyNoteDeviceTier;
  renderP95Ms: number;
  sampleCount: number;
  isInteracting: boolean;
  reasons: string[];
}

export const DEFAULT_ADAPTIVE_LOD_OPTIONS: Readonly<AdaptiveLodOptions> = Object.freeze({
  enabled: true,
  sampleWindowMs: 2_000,
  recoveryDelayMs: 800,
  timingMinSamples: 20,
  timingMinVisibleEntities: 300,
  reducedRenderP95Ms: 16,
  minimalRenderP95Ms: 28,
  reducedVisibleNodes: 1_200,
  minimalVisibleNodes: 4_000,
  reducedVisibleConnectors: 800,
  minimalVisibleConnectors: 3_000,
  reducedNodeObjects: 10_000,
  minimalNodeObjects: 28_000,
  reducedConnectorObjects: 4_000,
  minimalConnectorObjects: 12_000
});

interface FrameSample {
  at: number;
  duration: number;
}

const LEVEL_VALUE: Readonly<Record<SkyNoteLodLevel, number>> = {
  full: 0,
  reduced: 1,
  minimal: 2
};

export class AdaptiveLodController {
  private readonly options: AdaptiveLodOptions;
  private readonly deviceTier: SkyNoteDeviceTier;
  private readonly capacityScale: number;
  private readonly samples: FrameSample[] = [];
  private level: SkyNoteLodLevel = 'full';
  private lastPressureAt = Number.NEGATIVE_INFINITY;
  private state: SkyNoteAdaptiveLodState;

  constructor(options: Partial<AdaptiveLodOptions> = {}, deviceProfile: AdaptiveLodDeviceProfile = {}) {
    this.options = normalizeOptions(options);
    this.deviceTier = resolveDeviceTier(deviceProfile);
    this.capacityScale = this.deviceTier === 'low' ? 0.7 : this.deviceTier === 'high' ? 1.2 : 1;
    this.state = {
      level: 'full',
      desiredLevel: 'full',
      deviceTier: this.deviceTier,
      renderP95Ms: 0,
      sampleCount: 0,
      isInteracting: false,
      reasons: []
    };
  }

  recordFrame(duration: number, now: number): void {
    if (Number.isFinite(duration) && duration >= 0) {
      this.samples.push({ duration, at: now });
    }
    this.pruneSamples(now);
  }

  evaluate(input: AdaptiveLodInput): SkyNoteAdaptiveLodState {
    this.pruneSamples(input.now);
    const renderP95Ms = percentile95(this.samples.map((sample) => sample.duration));
    const decision = this.resolveDesiredLevel(input, renderP95Ms);

    if (LEVEL_VALUE[decision.level] >= LEVEL_VALUE[this.level]) {
      if (decision.level !== 'full') {
        this.lastPressureAt = input.now;
      }
      this.level = decision.level;
    } else if (input.now - this.lastPressureAt >= this.options.recoveryDelayMs) {
      this.level = decision.level;
    }

    const reasons = [...decision.reasons];
    if (this.level !== decision.level) {
      reasons.push('recovery-hysteresis');
    }
    this.state = {
      level: this.level,
      desiredLevel: decision.level,
      deviceTier: this.deviceTier,
      renderP95Ms,
      sampleCount: this.samples.length,
      isInteracting: input.isInteracting,
      reasons
    };
    return this.getState();
  }

  getState(): SkyNoteAdaptiveLodState {
    return {
      ...this.state,
      reasons: [...this.state.reasons]
    };
  }

  private resolveDesiredLevel(
    input: AdaptiveLodInput,
    renderP95Ms: number
  ): { level: SkyNoteLodLevel; reasons: string[] } {
    const reasons: string[] = [];
    let level: SkyNoteLodLevel = 'full';
    const promote = (nextLevel: SkyNoteLodLevel, reason: string) => {
      if (LEVEL_VALUE[nextLevel] > LEVEL_VALUE[level]) {
        level = nextLevel;
      }
      reasons.push(reason);
    };
    const scaled = (value: number) => Math.max(1, Math.floor(value * (this.options.enabled ? this.capacityScale : 1)));

    if (input.zoom < 0.12) promote('minimal', 'very-low-zoom');
    // 06 号设计文档约定：缩放低于 30% 时卡片内容已不可读，停止排版改绘占位块
    else if (input.zoom < 0.3) promote('reduced', 'low-zoom');
    else if (input.documentNodes >= 5_000 && input.zoom < 0.55) {
      promote('reduced', 'low-zoom-large-document');
    }

    if (input.visibleNodes >= scaled(this.options.minimalVisibleNodes)) {
      promote('minimal', 'visible-node-pressure');
    } else if (input.visibleNodes >= scaled(this.options.reducedVisibleNodes)) {
      promote('reduced', 'visible-node-pressure');
    }
    if (input.visibleConnectors >= scaled(this.options.minimalVisibleConnectors)) {
      promote('minimal', 'visible-connector-pressure');
    } else if (input.visibleConnectors >= scaled(this.options.reducedVisibleConnectors)) {
      promote('reduced', 'visible-connector-pressure');
    }
    if (input.nodeObjects >= scaled(this.options.minimalNodeObjects)) {
      promote('minimal', 'node-object-pressure');
    } else if (input.nodeObjects >= scaled(this.options.reducedNodeObjects)) {
      promote('reduced', 'node-object-pressure');
    }
    if (input.connectorObjects >= scaled(this.options.minimalConnectorObjects)) {
      promote('minimal', 'connector-object-pressure');
    } else if (input.connectorObjects >= scaled(this.options.reducedConnectorObjects)) {
      promote('reduced', 'connector-object-pressure');
    }

    const timingReliable =
      this.samples.length >= this.options.timingMinSamples &&
      input.visibleNodes + input.visibleConnectors >= this.options.timingMinVisibleEntities;
    if (this.options.enabled && timingReliable) {
      if (renderP95Ms >= this.options.minimalRenderP95Ms) {
        promote('minimal', 'render-time-pressure');
      } else if (renderP95Ms >= this.options.reducedRenderP95Ms) {
        promote('reduced', 'render-time-pressure');
      }
      if (input.isInteracting && renderP95Ms >= 20) {
        promote('minimal', 'interaction-frame-pressure');
      }
    }

    if (
      this.options.enabled &&
      input.isInteracting &&
      (input.documentNodes >= 5_000 || input.documentConnectors >= 3_000)
    ) {
      promote('reduced', 'active-interaction');
    }

    return { level, reasons };
  }

  private pruneSamples(now: number): void {
    const oldestAllowed = now - this.options.sampleWindowMs;
    while (this.samples[0]?.at < oldestAllowed) {
      this.samples.shift();
    }
  }
}

function normalizeOptions(options: Partial<AdaptiveLodOptions>): AdaptiveLodOptions {
  const merged = { ...DEFAULT_ADAPTIVE_LOD_OPTIONS, ...options };
  return {
    enabled: merged.enabled !== false,
    sampleWindowMs: positive(merged.sampleWindowMs, 2_000),
    recoveryDelayMs: positive(merged.recoveryDelayMs, 800),
    timingMinSamples: positive(merged.timingMinSamples, 20),
    timingMinVisibleEntities: positive(merged.timingMinVisibleEntities, 300),
    reducedRenderP95Ms: positive(merged.reducedRenderP95Ms, 16),
    minimalRenderP95Ms: positive(merged.minimalRenderP95Ms, 28),
    reducedVisibleNodes: positive(merged.reducedVisibleNodes, 1_200),
    minimalVisibleNodes: positive(merged.minimalVisibleNodes, 4_000),
    reducedVisibleConnectors: positive(merged.reducedVisibleConnectors, 800),
    minimalVisibleConnectors: positive(merged.minimalVisibleConnectors, 3_000),
    reducedNodeObjects: positive(merged.reducedNodeObjects, 10_000),
    minimalNodeObjects: positive(merged.minimalNodeObjects, 28_000),
    reducedConnectorObjects: positive(merged.reducedConnectorObjects, 4_000),
    minimalConnectorObjects: positive(merged.minimalConnectorObjects, 12_000)
  };
}

function resolveDeviceTier(profile: AdaptiveLodDeviceProfile): SkyNoteDeviceTier {
  const cores = profile.hardwareConcurrency ?? null;
  const memory = profile.deviceMemoryGb ?? null;
  if ((cores !== null && cores <= 4) || (memory !== null && memory <= 4)) {
    return 'low';
  }
  if ((cores !== null || memory !== null) && (cores === null || cores >= 12) && (memory === null || memory >= 12)) {
    return 'high';
  }
  return 'standard';
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(2));
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
