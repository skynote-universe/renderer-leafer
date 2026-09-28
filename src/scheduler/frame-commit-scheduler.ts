/**
 * @file frame-commit-scheduler.ts
 * @description 海量节点分帧提交与时间预算调度器
 */

export interface FrameCommitOptions {
  enabled: boolean;
  activationThreshold: number;
  frameBudgetMs: number;
  nodeBudgetRatio: number;
  minItemsPerFrame: number;
  maxItemsPerFrame: number;
  initialNodeMsPerItem: number;
  initialConnectorMsPerItem: number;
}

export interface FrameCommitTarget {
  nodeIds: readonly string[];
  nodePriorityIds: readonly string[];
  connectorIds: readonly string[];
  connectorPriorityIds: readonly string[];
  urgentConnectorIds?: readonly string[];
}

export interface SkyNoteFrameCommitState {
  revision: number;
  active: boolean;
  pendingNodes: number;
  pendingConnectors: number;
  committedNodes: number;
  committedConnectors: number;
  lastNodeBatch: number;
  lastConnectorBatch: number;
  estimatedNodeMsPerItem: number;
  estimatedConnectorMsPerItem: number;
}

export interface FrameCommitResult {
  committedNodeIds: ReadonlySet<string>;
  committedConnectorIds: ReadonlySet<string>;
  state: SkyNoteFrameCommitState;
}

export const DEFAULT_FRAME_COMMIT_OPTIONS: Readonly<FrameCommitOptions> = Object.freeze({
  enabled: true,
  activationThreshold: 160,
  frameBudgetMs: 6,
  nodeBudgetRatio: 0.68,
  minItemsPerFrame: 4,
  maxItemsPerFrame: 500,
  initialNodeMsPerItem: 0.07,
  initialConnectorMsPerItem: 0.025
});

class CommitQueue {
  readonly committed = new Set<string>();
  private target = new Set<string>();
  private pending: string[] = [];

  reconcile(targetIds: readonly string[], priorityIds: readonly string[]): boolean {
    const nextTarget = new Set(targetIds);
    const changed = !setsEqual(this.target, nextTarget);
    for (const id of this.committed) {
      if (!nextTarget.has(id)) this.committed.delete(id);
    }
    this.target = nextTarget;
    const orderedIds = uniqueOrdered([...priorityIds, ...targetIds]);
    this.pending = orderedIds.filter(
      id => nextTarget.has(id) && !this.committed.has(id)
    );
    return changed;
  }

  commit(
    limit: number,
    staged: boolean,
    enabled: boolean,
    maximumCount = this.pending.length
  ): number {
    const availableCount = Math.min(this.pending.length, maximumCount);
    const count =
      !enabled || !staged
        ? availableCount
        : Math.min(availableCount, Math.max(0, limit));
    for (let index = 0; index < count; index += 1) {
      this.committed.add(this.pending[index]);
    }
    this.pending.splice(0, count);
    return count;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  countPending(ids: ReadonlySet<string>): number {
    return this.pending.reduce(
      (count, id) => count + (ids.has(id) ? 1 : 0),
      0
    );
  }
}

export class FrameCommitScheduler {
  private readonly options: FrameCommitOptions;
  private readonly nodes = new CommitQueue();
  private readonly connectors = new CommitQueue();
  private revision = 0;
  private estimatedNodeMsPerItem: number;
  private estimatedConnectorMsPerItem: number;
  private nodeStaged = false;
  private connectorStaged = false;
  private state: SkyNoteFrameCommitState;

  constructor(options: Partial<FrameCommitOptions> = {}) {
    this.options = normalizeOptions(options);
    this.estimatedNodeMsPerItem = this.options.initialNodeMsPerItem;
    this.estimatedConnectorMsPerItem = this.options.initialConnectorMsPerItem;
    this.state = this.createState(0, 0);
  }

  reconcileAndCommit(target: FrameCommitTarget): FrameCommitResult {
    const nodesChanged = this.nodes.reconcile(
      target.nodeIds,
      target.nodePriorityIds
    );
    const connectorsChanged = this.connectors.reconcile(
      target.connectorIds,
      target.connectorPriorityIds
    );
    const targetChanged = nodesChanged || connectorsChanged;
    if (targetChanged) this.revision += 1;
    if (nodesChanged) {
      this.nodeStaged =
        this.options.enabled &&
        this.nodes.pendingCount > this.options.activationThreshold;
    }
    if (connectorsChanged) {
      this.connectorStaged =
        this.options.enabled &&
        this.connectors.pendingCount > this.options.activationThreshold;
    }

    const nodeLimit = this.resolveLimit(
      this.options.frameBudgetMs * this.options.nodeBudgetRatio,
      this.estimatedNodeMsPerItem
    );
    const connectorLimit = this.resolveLimit(
      this.options.frameBudgetMs * (1 - this.options.nodeBudgetRatio),
      this.estimatedConnectorMsPerItem
    );
    const lastNodeBatch = this.nodes.commit(
      nodeLimit,
      this.nodeStaged,
      this.options.enabled
    );
    const urgentConnectorIds = new Set(target.urgentConnectorIds ?? []);
    const connectorAllowance =
      this.nodes.pendingCount === 0
        ? this.connectors.pendingCount
        : this.connectors.countPending(urgentConnectorIds);
    const lastConnectorBatch = this.connectors.commit(
      connectorLimit,
      this.connectorStaged,
      this.options.enabled,
      connectorAllowance
    );
    if (this.nodes.pendingCount === 0) this.nodeStaged = false;
    if (this.connectors.pendingCount === 0) this.connectorStaged = false;
    this.state = this.createState(lastNodeBatch, lastConnectorBatch);
    return {
      committedNodeIds: this.nodes.committed,
      committedConnectorIds: this.connectors.committed,
      state: this.getState()
    };
  }

  recordNodePhase(durationMs: number, committedItems: number): void {
    this.estimatedNodeMsPerItem = updateEstimate(
      this.estimatedNodeMsPerItem,
      durationMs,
      committedItems
    );
    this.state = this.createState(
      this.state.lastNodeBatch,
      this.state.lastConnectorBatch
    );
  }

  recordConnectorPhase(durationMs: number, committedItems: number): void {
    this.estimatedConnectorMsPerItem = updateEstimate(
      this.estimatedConnectorMsPerItem,
      durationMs,
      committedItems
    );
    this.state = this.createState(
      this.state.lastNodeBatch,
      this.state.lastConnectorBatch
    );
  }

  getState(): SkyNoteFrameCommitState {
    return { ...this.state };
  }

  private resolveLimit(budgetMs: number, estimateMs: number): number {
    return Math.max(
      this.options.minItemsPerFrame,
      Math.min(
        this.options.maxItemsPerFrame,
        Math.floor(budgetMs / Math.max(0.001, estimateMs))
      )
    );
  }

  private createState(
    lastNodeBatch: number,
    lastConnectorBatch: number
  ): SkyNoteFrameCommitState {
    return {
      revision: this.revision,
      active: this.nodes.pendingCount > 0 || this.connectors.pendingCount > 0,
      pendingNodes: this.nodes.pendingCount,
      pendingConnectors: this.connectors.pendingCount,
      committedNodes: this.nodes.committed.size,
      committedConnectors: this.connectors.committed.size,
      lastNodeBatch,
      lastConnectorBatch,
      estimatedNodeMsPerItem: round(this.estimatedNodeMsPerItem),
      estimatedConnectorMsPerItem: round(this.estimatedConnectorMsPerItem)
    };
  }
}

function normalizeOptions(options: Partial<FrameCommitOptions>): FrameCommitOptions {
  const merged = { ...DEFAULT_FRAME_COMMIT_OPTIONS, ...options };
  return {
    enabled: merged.enabled !== false,
    activationThreshold: nonNegative(merged.activationThreshold, 160),
    frameBudgetMs: positive(merged.frameBudgetMs, 6),
    nodeBudgetRatio: Math.min(0.9, Math.max(0.1, merged.nodeBudgetRatio)),
    minItemsPerFrame: positiveInteger(merged.minItemsPerFrame, 4),
    maxItemsPerFrame: positiveInteger(merged.maxItemsPerFrame, 500),
    initialNodeMsPerItem: positive(merged.initialNodeMsPerItem, 0.07),
    initialConnectorMsPerItem: positive(
      merged.initialConnectorMsPerItem,
      0.025
    )
  };
}

function updateEstimate(
  current: number,
  durationMs: number,
  committedItems: number
): number {
  if (!Number.isFinite(durationMs) || durationMs < 0 || committedItems <= 0) {
    return current;
  }
  const observed = durationMs / committedItems;
  return Math.max(0.001, current * 0.75 + observed * 0.25);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function uniqueOrdered(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
