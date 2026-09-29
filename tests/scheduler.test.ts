import { describe, it, expect } from 'vitest';
import { FrameCommitScheduler } from '../src/scheduler/frame-commit-scheduler';
import { AdaptiveLodController } from '../src/scheduler/adaptive-lod';

describe('Renderer Schedulers', () => {
  it('FrameCommitScheduler 分帧提交与预算限制', () => {
    const scheduler = new FrameCommitScheduler({
      enabled: true,
      activationThreshold: 2,
      frameBudgetMs: 5,
      minItemsPerFrame: 2,
      maxItemsPerFrame: 10
    });

    const result = scheduler.reconcileAndCommit({
      nodeIds: ['n1', 'n2', 'n3', 'n4', 'n5'],
      nodePriorityIds: ['n1'],
      connectorIds: [],
      connectorPriorityIds: []
    });

    expect(result.committedNodeIds.size).toBeGreaterThanOrEqual(2);
  });

  it('FrameCommitScheduler 按回传的实测挂载成本调整每帧提交量', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `n${i}`);
    const run = (scheduler: FrameCommitScheduler) =>
      scheduler.reconcileAndCommit({ nodeIds: ids, nodePriorityIds: [], connectorIds: [], connectorPriorityIds: [] });

    const slow = new FrameCommitScheduler({ activationThreshold: 10, frameBudgetMs: 6, nodeBudgetRatio: 0.5 });
    const firstBatch = run(slow).state.lastNodeBatch;
    // 实测每个节点 1ms (远高于初始估值)，后续批次应随之缩小
    for (let i = 0; i < 10; i++) slow.recordNodePhase(10, 10);
    expect(run(slow).state.lastNodeBatch).toBeLessThan(firstBatch / 4);

    // 无新挂载实体时不影响估值
    const before = slow.getState().estimatedNodeMsPerItem;
    slow.recordNodePhase(5, 0);
    expect(slow.getState().estimatedNodeMsPerItem).toBe(before);
  });

  it('FrameCommitScheduler 目标未变且已全部提交时保持稳定，目标变化后补交新增实体并优先选中实体', () => {
    const scheduler = new FrameCommitScheduler({ enabled: false });
    const target = (nodeIds: string[], priority: Iterable<string> = []) =>
      scheduler.reconcileAndCommit({ nodeIds, nodePriorityIds: priority, connectorIds: [], connectorPriorityIds: [] });

    const first = target(['a', 'b']);
    const revision = first.state.revision;
    expect([...first.committedNodeIds]).toEqual(['a', 'b']);
    expect(target(['b', 'a']).state.revision).toBe(revision);

    const changed = target(['a', 'c'], new Set(['c', 'x']));
    expect(changed.state.revision).toBe(revision + 1);
    expect([...changed.committedNodeIds].sort()).toEqual(['a', 'c']);
  });

  it('AdaptiveLodController LOD 等级评估', () => {
    const controller = new AdaptiveLodController({
      enabled: true
    });

    // 正常缩放与低节点数 -> full
    const stateNormal = controller.evaluate({
      now: 1000,
      zoom: 1,
      documentNodes: 100,
      documentConnectors: 50,
      visibleNodes: 50,
      visibleConnectors: 25,
      nodeObjects: 100,
      connectorObjects: 50,
      isInteracting: false
    });
    expect(stateNormal.level).toBe('full');

    // 极端微缩 (zoom < 0.12) -> minimal
    const stateLowZoom = controller.evaluate({
      now: 2000,
      zoom: 0.05,
      documentNodes: 100,
      documentConnectors: 50,
      visibleNodes: 50,
      visibleConnectors: 25,
      nodeObjects: 100,
      connectorObjects: 50,
      isInteracting: false
    });
    expect(stateLowZoom.level).toBe('minimal');
  });
});
