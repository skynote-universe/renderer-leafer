/**
 * @file visibility-tracker.ts
 * @description 图层可见集合与离屏缓存 LRU 追踪 (节点层与连线层共用)
 *
 * 设计考量 (Why):
 * 1. 每帧只在「上一帧可见集合」与「本帧可见集合」之间做差集，开销只随可见规模增长。
 * 2. 离屏实体保留图元以便回到视野时就地复用；Set 的插入序即 LRU 序 (最早离开视野者在前)，
 *    进出队与淘汰均为 O(1)，内存不随浏览过的画布面积无限增长。
 */

export class VisibilityTracker {
  private shown = new Set<string>();
  private nextShown = new Set<string>();
  private readonly offscreen = new Set<string>();

  constructor(
    private readonly offscreenLimit: number,
    private readonly hideChildrenFirst = false
  ) {}

  /** 当前挂载在场景树上的实体 */
  get shownIds(): ReadonlySet<string> {
    return this.shown;
  }

  beginFrame(): void {
    this.nextShown = new Set();
  }

  /** 本帧是否已标记可见 (祖先节点可能被多个子节点重复请求挂载) */
  isMarked(id: string): boolean {
    return this.nextShown.has(id);
  }

  /** 标记实体本帧可见；是否新进入场景由调用方在渲染前以 shownIds 判定 (endFrame 前 shownIds 仍是上一帧集合) */
  markShown(id: string): void {
    this.nextShown.add(id);
    this.offscreen.delete(id);
  }

  /**
   * 结束本帧：离开视野者交给 onHide 并进入 LRU 队尾，超出限额者从队首出队后交给 onEvict
   * 先出队再回调，保证回调中缓存缺失时淘汰循环依旧前进
   */
  endFrame(onHide: (ids: readonly string[]) => void, onEvict: (id: string) => void): void {
    const leaving: string[] = [];
    for (const id of this.shown) {
      if (this.nextShown.has(id)) continue;
      leaving.push(id);
      this.offscreen.add(id);
    }
    // 节点按祖先先于后代标记：反向摘除避免原生场景树递归解绑，LRU 插入顺序仍保持不变。
    if (this.hideChildrenFirst) leaving.reverse();
    if (leaving.length) onHide(leaving);
    this.shown = this.nextShown;

    while (this.offscreen.size > this.offscreenLimit) {
      const oldest = this.offscreen.values().next().value!;
      this.offscreen.delete(oldest);
      onEvict(oldest);
    }
  }

  /** 实体被销毁时移出全部集合 */
  forget(id: string): void {
    this.shown.delete(id);
    this.nextShown.delete(id);
    this.offscreen.delete(id);
  }
}
