import { describe, it, expect } from 'vitest';
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
  tracker.endFrame((id) => hidden.push(id), (id) => evicted.push(id));
  return { entered, hidden, evicted };
}

describe('VisibilityTracker', () => {
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
