/**
 * @file display-object-budget.ts
 * @description 场景图元对象配额预算控制器
 */

export interface BudgetSelectionOptions<TItem> {
  limit: number;
  getId(item: TItem): string;
  protectedIds: ReadonlySet<string>;
  score(item: TItem): number;
}

export interface BudgetSelectionResult<TItem> {
  items: TItem[];
  droppedCount: number;
}

export function resolveBudgetEntityLimit(
  maxEntities: number,
  maxObjects: number,
  estimatedObjectsPerEntity: number
): number {
  const entityLimit = Math.max(0, Math.floor(maxEntities));
  const objectLimit = Math.max(0, Math.floor(maxObjects));
  const estimatedCost = Math.max(1, estimatedObjectsPerEntity);
  return Math.min(entityLimit, Math.floor(objectLimit / estimatedCost));
}

export function selectBudgetedItems<TItem>(
  candidates: readonly TItem[],
  options: BudgetSelectionOptions<TItem>
): BudgetSelectionResult<TItem> {
  const seenIds = new Set<string>();
  const protectedItems: TItem[] = [];
  const regularItems: Array<{ item: TItem; index: number }> = [];

  candidates.forEach((item, index) => {
    const id = options.getId(item);
    if (seenIds.has(id)) {
      return;
    }
    seenIds.add(id);
    if (options.protectedIds.has(id)) {
      protectedItems.push(item);
    } else {
      regularItems.push({ item, index });
    }
  });

  const regularLimit = Math.max(0, Math.floor(options.limit) - protectedItems.length);
  if (regularItems.length > regularLimit) {
    regularItems.sort((left, right) => {
      const scoreDelta = options.score(left.item) - options.score(right.item);
      return scoreDelta === 0 ? left.index - right.index : scoreDelta;
    });
  }

  const selectedRegularItems = regularItems
    .slice(0, regularLimit)
    .map(({ item }) => item);
  const items = [...selectedRegularItems, ...protectedItems];
  return {
    items,
    droppedCount: Math.max(0, seenIds.size - items.length)
  };
}
