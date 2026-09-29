/**
 * @file stable-order.ts
 * @description 实体稳定序号：层级规则完全并列时的确定性排序依据
 *
 * 首次出现时分配单调递增序号，实体图元销毁时释放；保证同一会话内并列实体的上下关系不随帧抖动。
 */

export class StableOrder {
  private readonly orders = new Map<string, number>();
  private sequence = 0;

  get(id: string): number {
    let order = this.orders.get(id);
    if (order === undefined) {
      order = ++this.sequence;
      this.orders.set(id, order);
    }
    return order;
  }

  release(id: string): void {
    this.orders.delete(id);
  }
}
