// In-memory CostCounter for unit tests.

import type { CostCounter } from '../../src/application/ports/cost-counter.port.js';

export class InMemoryCostCounter implements CostCounter {
  private counts: Map<string, number> = new Map();

  async incrementAndCheck(userId: string, date: string, limit: number): Promise<{ allowed: boolean; count: number }> {
    const key = `${userId}#${date}`;
    const current = this.counts.get(key) ?? 0;
    if (current >= limit) return { allowed: false, count: current };
    this.counts.set(key, current + 1);
    return { allowed: true, count: current + 1 };
  }

  getCount(userId: string, date: string): number {
    return this.counts.get(`${userId}#${date}`) ?? 0;
  }
}
