// Lambda entry: yearly KASI holiday sync. Pulls current + next year's holidays, upserts holiday_cache.

import { KasiHolidayClient } from '../../outbound/kasi/kasi-holiday.client.js';
import { PgHolidayCacheRepository } from '../../outbound/pg/pg-holiday-cache.repository.js';
import { logger } from '../../../shared/logging/logger.js';

interface SyncEvent {
  readonly years?: ReadonlyArray<number>;
}

interface SyncResult {
  readonly ok: boolean;
  readonly years: ReadonlyArray<{ year: number; inserted: number }>;
}

const DEFAULT_FORWARD_YEARS = 2;

const resolveYears = (event: SyncEvent): ReadonlyArray<number> => {
  if (event.years && event.years.length > 0) return event.years;
  const current = new Date().getUTCFullYear();
  return Array.from({ length: DEFAULT_FORWARD_YEARS }, (_, i) => current + i);
};

export const handler = async (event: SyncEvent = {}): Promise<SyncResult> => {
  const client = new KasiHolidayClient({ serviceKey: process.env.HOLIDAY_API_SERVICE_KEY ?? '' });
  const repo = new PgHolidayCacheRepository();
  const years = resolveYears(event);
  const results: { year: number; inserted: number }[] = [];
  for (const year of years) {
    const items = await client.fetchYear(year);
    const { inserted } = await repo.upsertMany(year, items);
    logger.info({ year, fetched: items.length, inserted }, 'KASI holiday sync ok');
    results.push({ year, inserted });
  }
  return { ok: true, years: results };
};
