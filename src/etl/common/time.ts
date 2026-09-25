import { DateTime } from "luxon";

export function todayMidnightISO(tz: string): string {
  return DateTime.now().setZone(tz).startOf("day").toISO({ suppressMilliseconds: true })!;
}

export function inExecutionWindow(tz: string): boolean {
  const now = DateTime.now().setZone(tz);
  const start = now.set({ hour: 7, minute: 0, second: 0, millisecond: 0 });
  const end = now.set({ hour: 22, minute: 0, second: 0, millisecond: 0 });
  return now >= start && now <= end;
}
