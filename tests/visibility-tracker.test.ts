import { describe, it, expect, vi } from 'vitest';
import { VisibilityTracker } from '../src/layers/visibility-tracker';

function runFrame(tracker: VisibilityTracker, visible: string[]) {
  const entered: string[] = [];
  const hidden: string[] = [];
  const evicted: string[] = [];
  tracker.beginFrame();
  for (const id of visible) {
    if (!tracker.shownIds.has(id)) entered.push(id);
    tracker.markShown(id);
  }
  tracker.endFrame(
    (ids) => hidden.push(...ids),
    (id) => evicted.push(id)
  );
  return { entered, hidden, evicted };
}

describe('VisibilityTracker', () => {
  it('离场一次通知整批且先于LRU淘汰，空闲帧不通知', () => {
    const tracker = new VisibilityTracker(1, true);
    runFrame(tracker, ['parent', 'child', 'leaf']);
    tracker.beginFrame();
    const events: string[] = [];
    const hide = vi.fn((ids: readonly string[]) => events.push(`hide:${ids.join(',')}`));
    tracker.endFrame(hide, (id) => events.push(`evict:${id}`));
    expect(hide).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['hide:leaf,child,parent', 'evict:parent', 'evict:child']);
    tracker.beginFrame();
    tracker.endFrame(hide, () => {});
    expect(hide).toHaveBeenCalledTimes(1);
  });
  it('节点可按后代优先摘除，LRU仍按原离场顺序淘汰', () => {
    const tracker = new VisibilityTracker(1, true);
    runFrame(tracker, ['parent', 'child', 'leaf']);
    expect(runFrame(tracker, [])).toEqual({
      entered: [],
      hidden: ['leaf', 'child', 'parent'],
      evicted: ['parent', 'child']
    });
  });
  it('按帧差集报告进入与离开视野的实体，离屏超额时按最早离开者优先淘汰', () => {
    const tracker = new VisibilityTracker(2);

    expect(runFrame(tracker, ['a', 'b'])).toEqual({ entered: ['a', 'b'], hidden: [], evicted: [] });
    expect(runFrame(tracker, ['b', 'c'])).toEqual({ entered: ['c'], hidden: ['a'], evicted: [] });
    expect(runFrame(tracker, ['d'])).toEqual({ entered: ['d'], hidden: ['b', 'c'], evicted: ['a'] });

    // b 回到视野：从离屏队列移出，不会被淘汰
    expect(runFrame(tracker, ['b'])).toEqual({ entered: ['b'], hidden: ['d'], evicted: [] });
    expect([...tracker.shownIds]).toEqual(['b']);
  });

  it('forget 之后实体不再出现在任何集合中', () => {
    const tracker = new VisibilityTracker(0);
    runFrame(tracker, ['a']);
    tracker.forget('a');
    expect(tracker.shownIds.size).toBe(0);
    expect(runFrame(tracker, [])).toEqual({ entered: [], hidden: [], evicted: [] });
  });
});
