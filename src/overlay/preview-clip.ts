import {
  applyMatrix,
  resolveNodeStyle,
  type CornerRadius,
  type NodeEntity,
  type Point,
  type SkyNoteEngine
} from '@skynote/core';

export function previewOutline(engine: SkyNoteEngine, node: Readonly<NodeEntity>, clipToViewport = true): Point[] {
  const { viewport, viewportSize } = engine.session;

  function screenOutline(entity: Readonly<NodeEntity>, radius: CornerRadius = 0): Point[] {
    const matrix = engine.entityStore.getWorldTransform(entity.id);
    if (!matrix) return [];
    const { width, height } = entity;
    const [tl, tr, br, bl] = typeof radius === 'number' ? [radius, radius, radius, radius] : radius;
    const clampRadius = (value: number) => Math.max(0, Math.min(value, width / 2, height / 2));
    const corners = [
      { x: width, y: 0, r: clampRadius(tr), dx: -1, dy: 1 },
      { x: width, y: height, r: clampRadius(br), dx: -1, dy: -1 },
      { x: 0, y: height, r: clampRadius(bl), dx: 1, dy: -1 },
      { x: 0, y: 0, r: clampRadius(tl), dx: 1, dy: 1 }
    ].flatMap(({ x, y, r, dx, dy }, corner) => {
      if (!r) return [{ x, y }];
      return Array.from({ length: 7 }, (_, step) => {
        const angle = ((corner - 1 + step / 6) * Math.PI) / 2;
        return { x: x + r * (dx + Math.cos(angle)), y: y + r * (dy + Math.sin(angle)) };
      });
    });
    return corners.map(({ x, y }) => {
      const world = applyMatrix(matrix, x, y);
      return { x: world.x * viewport.zoom + viewport.x, y: world.y * viewport.zoom + viewport.y };
    });
  }

  let outline = screenOutline(node, resolveNodeStyle(node, engine.nodeTypes.get(node.nodeType)).radius);
  if (clipToViewport)
    outline = intersect(outline, [
      { x: 0, y: 0 },
      { x: viewportSize.width, y: 0 },
      { x: viewportSize.width, y: viewportSize.height },
      { x: 0, y: viewportSize.height }
    ]);
  for (const id of engine.entityStore.getAncestorIds(node.id)) {
    const parent = engine.entityStore.getNode(id)?.entity;
    const definition = parent && engine.nodeTypes.get(parent.nodeType);
    if (parent && definition?.clipChildren)
      outline = intersect(outline, screenOutline(parent, resolveNodeStyle(parent, definition).radius));
  }
  return outline;
}

/** 将预览外形逐边裁到祖先画框内，保留旋转后的可交互区域。 */
function intersect(subject: Point[], clip: Point[]): Point[] {
  if (clip.length < 3) return [];
  for (const [index, start] of clip.entries()) {
    if (!subject.length) break;
    const end = clip[(index + 1) % clip.length];
    const distance = (p: Point) => (end.x - start.x) * (p.y - start.y) - (end.y - start.y) * (p.x - start.x);
    const output: Point[] = [];
    let previous = subject[subject.length - 1];
    let before = distance(previous);
    for (const current of subject) {
      const after = distance(current);
      if (before < 0 !== after < 0) {
        const t = before / (before - after);
        output.push({ x: previous.x + (current.x - previous.x) * t, y: previous.y + (current.y - previous.y) * t });
      }
      if (after >= 0) output.push(current);
      previous = current;
      before = after;
    }
    subject = output;
  }
  return subject;
}
