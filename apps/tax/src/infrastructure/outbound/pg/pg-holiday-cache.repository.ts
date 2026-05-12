// Persists KASI holiday items into the holiday_cache table (SoT for business-day roll-forward).

import { withRlsContext } from './pg-rls.context.js';
import type { KasiHolidayItem } from '../kasi/kasi-holiday.client.js';

export class PgHolidayCacheRepository {
  async upsertMany(year: number, items: ReadonlyArray<KasiHolidayItem>): Promise<{ inserted: number }> {
    if (items.length === 0) return { inserted: 0 };
    return withRlsContext({ isTaxAdmin: true, cognitoSub: 'system' }, async (client) => {
      let count = 0;
      for (const item of items) {
        await client.query(
          `INSERT INTO holiday_cache (date, year, name, is_holiday, is_substitute)
           VALUES ($1::date, $2::int, $3, $4, $5)
           ON CONFLICT (date) DO UPDATE
             SET name = EXCLUDED.name,
                 is_holiday = EXCLUDED.is_holiday,
                 is_substitute = EXCLUDED.is_substitute,
                 synced_at = now()`,
          [item.date, year, item.name, item.isHoliday, item.isSubstitute],
        );
        count += 1;
      }
      return { inserted: count };
    });
  }
}
