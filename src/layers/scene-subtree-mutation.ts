import type { Group } from 'leafer';

export type SceneChildrenChange = { readonly removed: ReadonlySet<Group> } | { readonly ordered: Group['children'] };

/** 按最终父子关系批量换挂；单目标保留局部路径，多目标一次处理旧树并集。 */
export function mountSceneGroups(mounts: ReadonlyMap<Group, Group>): void {
  if (!mounts.size) return;
  if (mounts.size === 1) {
    for (const [group, parent] of mounts) withDetachedBranches([group], () => parent.add(group));
    return;
  }
  const outgoing = new Map<Group, Set<Group>>();
  const incoming = new Map<Group, Group[]>();
  for (const [group, target] of mounts) {
    const source = group.parent as Group | null;
    if (source === target) continue;
    if (source) {
      let removed = outgoing.get(source);
      if (!removed) outgoing.set(source, (removed = new Set()));
      removed.add(group);
    }
    let added = incoming.get(target);
    if (!added) incoming.set(target, (added = []));
    added.push(group);
  }
  const changes = new Map<Group, SceneChildrenChange>();
  for (const parent of new Set([...outgoing.keys(), ...incoming.keys()])) {
    const removed = outgoing.get(parent);
    const ordered = parent.children.filter((child) => !removed?.has(child as Group));
    for (const group of incoming.get(parent) ?? []) ordered.push(group);
    changes.set(parent, { ordered });
  }
  // 离屏缓存根可能没有实际父容器，仍须将其内部子树纳入安全拆装。
  withDetachedBranches([...changes.keys(), ...mounts.keys()], () => {}, changes);
}

/** 按实际父容器建立排除计划，归并相交根后批量摘除，保留兄弟及各图元内部结构。 */
export function detachSceneGroups(groups: Iterable<Group>): void {
  const buckets = new Map<Group, Set<Group>>();
  for (const group of groups) {
    const parent = group.parent as Group | null;
    if (!parent) continue;
    let removed = buckets.get(parent);
    if (!removed) {
      removed = new Set();
      buckets.set(parent, removed);
    }
    removed.add(group);
  }
  const roots: Group[] = [];
  const singles: Group[] = [];
  const changes = new Map<Group, SceneChildrenChange>();
  for (const [parent, removed] of buckets) {
    changes.set(parent, { removed });
    if (removed.size === 1)
      for (const group of removed) {
        roots.push(group);
        singles.push(group);
      }
    else roots.push(parent);
  }
  if (!roots.length) return;
  withDetachedBranches(
    roots,
    () => {
      for (const group of singles) group.remove();
    },
    changes
  );
}

/**
 * 原生换挂会递归绑定整棵分支；先逐层断开分支，变更后自顶向下恢复，限定原生调用深度。
 * 只遍历选中子树，默认保留图元、叶子内容和兄弟顺序，不触碰第三方私有状态。
 * 相交根先归并，按各父容器的排除/排序计划恢复；被摘下成员的内部结构仍保留。
 * 回调接收已快照父容器集合，避免在分支已摘下时依赖其兄弟下标；这些容器由计划恢复。
 */
export function withDetachedBranches(
  roots: Iterable<Group>,
  mutate: (detachedParents: ReadonlySet<Group>) => void,
  changes?: ReadonlyMap<Group, SceneChildrenChange>
): void {
  const requested = new Set(roots);
  const covered = new Map<Group, boolean>();
  const topmost: Group[] = [];
  for (const root of requested) {
    const path: Group[] = [];
    let current = root.parent as Group | null;
    let nested = false;
    while (current) {
      if (requested.has(current)) {
        nested = true;
        break;
      }
      const hit = covered.get(current);
      if (hit !== undefined) {
        nested = hit;
        break;
      }
      path.push(current);
      current = current.parent as Group | null;
    }
    for (const group of path) covered.set(group, nested);
    if (!nested) topmost.push(root);
  }
  const parents: { group: Group; children: Group['children'] }[] = [];
  const detachedParents = new Set<Group>();
  const collect = (parent: Group): void => {
    if (changes?.has(parent) || parent.children.some((child) => child.isBranch)) {
      parents.push({ group: parent, children: [...parent.children] });
      detachedParents.add(parent);
    }
  };
  for (const root of topmost) collect(root);
  for (let i = 0; i < parents.length; i++)
    for (const child of parents[i].children) if (child.isBranch) collect(child as Group);
  // 逐兄弟 remove 会反复 indexOf；批量清空后仅保留叶子，原生绑定深度仍被分支边界截断。
  for (let i = parents.length - 1; i >= 0; i--) {
    const { group, children } = parents[i];
    group.removeAll();
    for (const child of children) if (!child.isBranch) group.add(child);
  }
  try {
    mutate(detachedParents);
  } finally {
    // 改挂可能反转旧祖先关系，必须按最终父子关系自顶向下恢复，不能沿用旧树遍历顺序。
    const restore = new Map<Group, Group['children']>();
    const nested = new Set<Group>();
    for (const { group, children } of parents) {
      const change = changes?.get(group);
      const ordered = change && 'ordered' in change ? change.ordered : children;
      const kept =
        change && 'removed' in change ? ordered.filter((child) => !change.removed.has(child as Group)) : ordered;
      restore.set(group, kept);
      for (const child of kept) if (detachedParents.has(child as Group)) nested.add(child as Group);
    }
    const queue = parents.filter(({ group }) => !nested.has(group)).map(({ group }) => group);
    for (let i = 0; i < queue.length; i++) {
      const group = queue[i];
      group.removeAll();
      // 全部按原顺序追加，避免向混排叶子中逐个插入分支导致平方搬移。
      for (const child of restore.get(group)!) {
        group.add(child);
        if (restore.has(child as Group)) queue.push(child as Group);
      }
    }
  }
}
