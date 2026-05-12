// Business-day roll-forward helper using the dynamic holiday_cache table.

const SATURDAY = 6;
const SUNDAY = 0;
const MAX_ROLL_DAYS = 30;

export interface HolidayCalendar {
  isHoliday(date: string): boolean;
}

export const rollForwardToBusinessDay = (
  statutoryDueDate: string,
  calendar: HolidayCalendar,
): string => {
  let current = new Date(`${statutoryDueDate}T00:00:00Z`);
  for (let i = 0; i < MAX_ROLL_DAYS; i += 1) {
    const dow = current.getUTCDay();
    const iso = current.toISOString().slice(0, 10);
    const weekend = dow === SATURDAY || dow === SUNDAY;
    if (!weekend && !calendar.isHoliday(iso)) {
      return iso;
    }
    current = new Date(current.getTime() + 86_400_000);
  }
  throw new Error(`Failed to find a business day within ${MAX_ROLL_DAYS} days of ${statutoryDueDate}`);
};

export const subtractBusinessDays = (
  fromDate: string,
  businessDays: number,
  calendar: HolidayCalendar,
): string => {
  let current = new Date(`${fromDate}T00:00:00Z`);
  let remaining = businessDays;
  while (remaining > 0) {
    current = new Date(current.getTime() - 86_400_000);
    const dow = current.getUTCDay();
    const iso = current.toISOString().slice(0, 10);
    const weekend = dow === SATURDAY || dow === SUNDAY;
    if (!weekend && !calendar.isHoliday(iso)) remaining -= 1;
  }
  return current.toISOString().slice(0, 10);
};
