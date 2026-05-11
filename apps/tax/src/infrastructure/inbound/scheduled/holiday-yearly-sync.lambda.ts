// Lambda entry: yearly KASI holiday sync (cron 03:00 KST Jan 1) — populates holiday_cache and the DDB mirror.

export const handler = async (): Promise<{ ok: boolean; pending: string }> => ({
  ok: true,
  pending: 'Wave-4: wire KasiHolidayClient + holiday-cache repository + DDB mirror writer',
});
