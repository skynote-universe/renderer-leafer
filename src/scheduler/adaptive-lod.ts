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
  viewportInteractionPressure?: boolean;
  viewportGatePassed?: boolean;
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

/** 数量或耗时达到阈值时触发，false 关闭对应档位。 */
export interface LodThresholds {
  reduced?: number | false;
  minimal?: number | false;
}

export interface LodEntityThresholds {
  nodes?: LodThresholds | false;
  connectors?: LodThresholds | false;
}

export interface LeaferLodRules {
  /** 使用含视口边缘缓冲的渲染候选数。 */
  viewport?:
    | (LodEntityThresholds & {
        /** 仅交互期间，实际视口内节点数严格超过该值时至少降到 reduced。 */
        interactionNodesAbove?: number;
      })
    | false;
  document?: (LodEntityThresholds & { when?: 'interacting' | 'always' }) | false;
  cache?: LodEntityThresholds | false;
  /** 缩放比例低于阈值时触发。 */
  zoom?:
    | (LodThresholds & {
        largeDocument?: { nodes?: number; below?: number } | false;
      })
    | false;
  timing?:
    | (LodThresholds & {
        minSamples?: number;
        minVisibleEntities?: number;
        interactionMinimal?: number | false;
      })
    | false;
}

export interface LeaferLodMetrics extends Readonly<AdaptiveLodInput> {
  readonly renderP95Ms: number;
  readonly sampleCount: number;
  readonly deviceTier: SkyNoteDeviceTier;
}

export interface LeaferLodOptions {
  /** 抗抖恢复延迟，单位毫秒。0 表示立即恢复。 */
  recoveryDelayMs?: number;
  /** 仅当实际视口内节点数严格超过该值时允许 LOD，低于或等于门槛立即恢复。 */
  viewportNodesAbove?: number;
  /** 省略规则使用默认值。显式数量阈值按实际数量比较。 */
  rules?: LeaferLodRules;
  /** 同步纯函数。返回 undefined 使用内置规则建议，异常或无效结果同样回退。 */
  decide?: (metrics: LeaferLodMetrics, suggestedLevel: SkyNoteLodLevel) => SkyNoteLodLevel | undefined;
}

interface ThresholdPair {
  reduced: number;
  minimal: number;
}

interface ResolvedEntityThresholds {
  nodes: ThresholdPair;
  connectors: ThresholdPair;
}

interface ResolvedRules {
  viewport: ResolvedEntityThresholds & { interactionNodesAbove?: number };
  cache: ResolvedEntityThresholds;
  document?: ResolvedEntityThresholds & { when: 'interacting' | 'always' };
  zoom?: ThresholdPair & { largeDocument?: { nodes: number; below: number } };
  timing?: ThresholdPair & { minSamples: number; minVisibleEntities: number; interactionMinimal: number };
}
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
  readonly viewportNodesAbove: number | undefined;
  private readonly deviceTier: SkyNoteDeviceTier;
  private readonly rules: ResolvedRules;
  private readonly decide: LeaferLodOptions['decide'];
  private readonly samples: FrameSample[] = [];
  private level: SkyNoteLodLevel = 'full';
  private lastPressureAt = Number.NEGATIVE_INFINITY;
  private state: SkyNoteAdaptiveLodState;

  constructor(
    options: Partial<AdaptiveLodOptions> & LeaferLodOptions = {},
    deviceProfile: AdaptiveLodDeviceProfile = {}
  ) {
    this.options = normalizeOptions(options);
    this.viewportNodesAbove =
      options.viewportNodesAbove === undefined
        ? undefined
        : validateRuleValue(options.viewportNodesAbove, options.viewportNodesAbove, 'viewportNodesAbove');
    this.deviceTier = resolveDeviceTier(deviceProfile);
    this.rules = resolveRules(this.options, options.rules, this.deviceTier);
    this.decide = options.decide;
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

  get viewportInteractionNodesAbove(): number | undefined {
    return this.rules.viewport.interactionNodesAbove;
  }

  /** 下次允许回升的绝对时刻，按 evaluate 使用的时钟表示。 */
  get recoveryAt(): number | undefined {
    if (this.level === this.state.desiredLevel) return undefined;
    return this.lastPressureAt + this.options.recoveryDelayMs;
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
    const viewportBlocked = this.viewportNodesAbove !== undefined && !input.viewportGatePassed;
    const decision: { level: SkyNoteLodLevel; reasons: string[] } = viewportBlocked
      ? { level: 'full', reasons: ['viewport-node-gate'] }
      : this.resolveDesiredLevel(input, renderP95Ms);
    if (!viewportBlocked && this.decide) {
      try {
        const custom = this.decide(
          { ...input, renderP95Ms, sampleCount: this.samples.length, deviceTier: this.deviceTier },
          decision.level
        );
        if (custom === 'full' || custom === 'reduced' || custom === 'minimal') {
          decision.level = custom;
          decision.reasons.push('custom-policy');
        }
      } catch {
        // 宿主策略错误时继续使用内置规则，避免中断绘制。
      }
    }

    if (viewportBlocked || LEVEL_VALUE[decision.level] >= LEVEL_VALUE[this.level]) {
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
    const applyThreshold = (pair: ThresholdPair, value: number, reason: string): void => {
      if (value >= pair.minimal) promote('minimal', reason);
      else if (value >= pair.reduced) promote('reduced', reason);
    };
    const { zoom, viewport, cache, timing, document } = this.rules;
    if (zoom) {
      if (input.zoom < zoom.minimal) promote('minimal', 'very-low-zoom');
      else if (input.zoom < zoom.reduced) promote('reduced', 'low-zoom');
      else if (
        zoom.largeDocument &&
        input.documentNodes >= zoom.largeDocument.nodes &&
        input.zoom < zoom.largeDocument.below
      ) {
        promote('reduced', 'low-zoom-large-document');
      }
    }

    applyThreshold(viewport.nodes, input.visibleNodes, 'visible-node-pressure');
    applyThreshold(viewport.connectors, input.visibleConnectors, 'visible-connector-pressure');
    if (input.isInteracting && input.viewportInteractionPressure) promote('reduced', 'viewport-interaction');
    applyThreshold(cache.nodes, input.nodeObjects, 'node-object-pressure');
    applyThreshold(cache.connectors, input.connectorObjects, 'connector-object-pressure');

    if (
      timing &&
      this.samples.length >= timing.minSamples &&
      input.visibleNodes + input.visibleConnectors >= timing.minVisibleEntities
    ) {
      applyThreshold(timing, renderP95Ms, 'render-time-pressure');
      if (input.isInteracting && renderP95Ms >= timing.interactionMinimal) {
        promote('minimal', 'interaction-frame-pressure');
      }
    }

    if (document && (document.when === 'always' || input.isInteracting)) {
      const reason = document.when === 'always' ? 'document-pressure' : 'active-interaction';
      if (input.documentNodes >= document.nodes.minimal || input.documentConnectors >= document.connectors.minimal) {
        promote('minimal', reason);
      } else if (
        input.documentNodes >= document.nodes.reduced ||
        input.documentConnectors >= document.connectors.reduced
      ) {
        promote('reduced', reason);
      }
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

function resolveRules(options: AdaptiveLodOptions, rules: LeaferLodRules = {}, tier: SkyNoteDeviceTier): ResolvedRules {
  const scale = options.enabled ? (tier === 'low' ? 0.7 : tier === 'high' ? 1.2 : 1) : 1;
  const scaled = (value: number): number => Math.max(1, Math.floor(value * scale));
  const settings = {
    viewport: resolveEntityThresholds(
      rules.viewport,
      { reduced: scaled(options.reducedVisibleNodes), minimal: scaled(options.minimalVisibleNodes) },
      { reduced: scaled(options.reducedVisibleConnectors), minimal: scaled(options.minimalVisibleConnectors) },
      'viewport'
    ),
    cache: resolveEntityThresholds(
      rules.cache,
      { reduced: scaled(options.reducedNodeObjects), minimal: scaled(options.minimalNodeObjects) },
      { reduced: scaled(options.reducedConnectorObjects), minimal: scaled(options.minimalConnectorObjects) },
      'cache'
    )
  };
  const result: ResolvedRules = settings;
  const interactionNodesAbove = rules.viewport === false ? undefined : rules.viewport?.interactionNodesAbove;
  if (interactionNodesAbove !== undefined) {
    result.viewport.interactionNodesAbove = validateRuleValue(
      interactionNodesAbove,
      interactionNodesAbove,
      'viewport.interactionNodesAbove'
    );
  }
  if (rules.document !== false && (options.enabled || rules.document)) {
    result.document = {
      ...resolveEntityThresholds(
        rules.document,
        { reduced: 5_000, minimal: Infinity },
        { reduced: 3_000, minimal: Infinity },
        'document'
      ),
      when: rules.document?.when ?? 'interacting'
    };
  }
  if (rules.zoom !== false) {
    const large = rules.zoom?.largeDocument;
    result.zoom = {
      ...resolveThresholds(rules.zoom, { reduced: 0.3, minimal: 0.12 }, 'zoom', true),
      largeDocument:
        large === false
          ? undefined
          : {
              nodes: validateRuleValue(large?.nodes, 5_000, 'zoom.largeDocument.nodes'),
              below: validateRuleValue(large?.below, 0.55, 'zoom.largeDocument.below')
            }
    };
  }
  if (rules.timing !== false && (options.enabled || rules.timing)) {
    result.timing = {
      ...resolveThresholds(
        rules.timing,
        { reduced: options.reducedRenderP95Ms, minimal: options.minimalRenderP95Ms },
        'timing'
      ),
      minSamples: validateRuleValue(rules.timing?.minSamples, options.timingMinSamples, 'timing.minSamples'),
      minVisibleEntities: validateRuleValue(
        rules.timing?.minVisibleEntities,
        options.timingMinVisibleEntities,
        'timing.minVisibleEntities'
      ),
      interactionMinimal:
        rules.timing?.interactionMinimal === false
          ? Infinity
          : validateRuleValue(rules.timing?.interactionMinimal, 20, 'timing.interactionMinimal')
    };
  }
  return result;
}

function resolveEntityThresholds(
  configured: LodEntityThresholds | false | undefined,
  nodes: ThresholdPair,
  connectors: ThresholdPair,
  name: string
): ResolvedEntityThresholds {
  return {
    nodes: resolveThresholds(configured === false ? false : configured?.nodes, nodes, `${name}.nodes`),
    connectors: resolveThresholds(
      configured === false ? false : configured?.connectors,
      connectors,
      `${name}.connectors`
    )
  };
}

function resolveThresholds(
  configured: LodThresholds | false | undefined,
  defaults: ThresholdPair,
  name: string,
  below = false
): ThresholdPair {
  const disabled = below ? -Infinity : Infinity;
  if (configured === false) return { reduced: disabled, minimal: disabled };
  const reduced =
    configured?.reduced === false
      ? disabled
      : validateRuleValue(configured?.reduced, defaults.reduced, `${name}.reduced`);
  const minimal =
    configured?.minimal === false
      ? disabled
      : validateRuleValue(configured?.minimal, defaults.minimal, `${name}.minimal`);
  if (configured && reduced !== disabled && minimal !== disabled && (below ? minimal > reduced : minimal < reduced)) {
    throw new RangeError(`LOD rule ${name}.minimal must be at least as strict as reduced`);
  }
  return { reduced, minimal };
}

function validateRuleValue(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`LOD rule ${name} must be a positive finite number`);
  return value;
}
function normalizeOptions(options: Partial<AdaptiveLodOptions>): AdaptiveLodOptions {
  const merged = { ...DEFAULT_ADAPTIVE_LOD_OPTIONS, ...options };
  return {
    enabled: merged.enabled !== false,
    sampleWindowMs: positive(merged.sampleWindowMs, 2_000),
    recoveryDelayMs: merged.recoveryDelayMs === 0 ? 0 : positive(merged.recoveryDelayMs, 800),
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
