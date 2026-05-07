// CostCounter port: atomic daily increment with limit enforcement.

export interface CostCounter {
  incrementAndCheck(userId: string, date: string, limit: number): Promise<{ allowed: boolean; count: number }>;
}
