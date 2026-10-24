import './setup';
import { Group, Rect } from 'leafer-ui';
import { expect, it, vi } from 'vitest';
import { withDetachedBranches } from '../src/layers/scene-subtree-mutation';
import type { SceneChildrenChange } from '../src/layers/scene-subtree-mutation';

it.each([false, true])('相交根的父排除与子排序计划同时生效，反序=%s', (reverse) => {
  const root = new Group();
  const removed = new Group();
  const content = new Rect();
  removed.add(content);
  const branch = new Group();
  const a = new Group();
  const b = new Group();
  branch.addMany(a, b);
  const leaf = new Rect();
  root.addMany(removed, branch, leaf);
  try {
    const changes = new Map<Group, SceneChildrenChange>([
      [root, { removed: new Set([removed]) }],
      [branch, { ordered: [b, a] }]
    ]);
    withDetachedBranches(reverse ? [branch, root] : [root, branch], () => {}, changes);
    expect(root.children).toEqual([branch, leaf]);
    expect(branch.children).toEqual([b, a]);
    expect(removed.parent).toBeNull();
    expect(removed.children).toEqual([content]);
  } finally {
    root.destroy();
    removed.destroy();
  }
});

it('变更抛错后恢复分支和混排叶子的原始顺序及对象', () => {
  const root = new Group();
  const left = new Rect();
  const branch = new Group();
  const right = new Rect();
  const nested = new Group();
  branch.add(nested);
  root.addMany(left, branch, right);
  try {
    expect(() =>
      withDetachedBranches([root], () => {
        expect(root.children).toEqual([left, right]);
        expect(branch.children).toEqual([]);
        throw new Error('失败');
      })
    ).toThrow('失败');
    expect(root.children).toEqual([left, branch, right]);
    expect(branch.children).toEqual([nested]);
  } finally {
    root.destroy();
  }
});

it.each([200, 400])('%s层分支变更的公开移除调用保持线性', (depth) => {
  const root = new Group();
  let parent = root;
  for (let i = 0; i < depth; i++) {
    const child = new Group();
    parent.add(child);
    parent = child;
  }
  const removes = vi.spyOn(Group.prototype, 'remove');
  try {
    withDetachedBranches([root], () => {});
    expect(removes.mock.calls.length).toBeLessThanOrEqual(depth * 2);
  } finally {
    removes.mockRestore();
    withDetachedBranches([root], () => root.remove());
    // 逐层销毁，测试清理本身不依赖原生递归深度。
    let current: Group | undefined = root;
    while (current) {
      const child = current.children[0] as Group | undefined;
      child?.remove();
      current.destroy();
      current = child;
    }
  }
});
