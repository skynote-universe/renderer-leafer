import { describe, it, expect } from 'vitest';
import { FrameCommitScheduler } from '../src/scheduler/frame-commit-scheduler';
import { AdaptiveLodController } from '../src/scheduler/adaptive-lod';
import { selectBudgetedItems } from '../src/scheduler/display-object-budget';

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

  it('selectBudgetedItems 对象预算筛选与保护项', () => {
    const items = [
      { id: '1', score: 10 },
      { id: '2', score: 20 },
      { id: '3', score: 30 }
    ];

    const result = selectBudgetedItems(items, {
      limit: 2,
      getId: item => item.id,
      protectedIds: new Set(['1']),
      score: item => item.score
    });

    expect(result.items.some(it => it.id === '1')).toBe(true);
    expect(result.items.length).toBe(2);
  });
});
