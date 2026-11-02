export type WeekWindow = { start: string; end: string; timezone: "Etc/UTC" };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The directory date is the closing Sunday, never the machine's current date. */
export function weekWindow(week: string): WeekWindow {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error("Week must be a Sunday YYYY-MM-DD");
  const end = new Date(`${week}T16:30:00.000Z`);
  if (!Number.isFinite(end.getTime()) || end.toISOString().slice(0, 10) !== week || end.getUTCDay() !== 0) {
    throw new Error("Week must be a Sunday YYYY-MM-DD");
  }
  return { start: new Date(end.getTime() - WEEK_MS).toISOString(), end: end.toISOString(), timezone: "Etc/UTC" };
}

export function inWindow(at: string, window: WeekWindow): boolean {
  const time = Date.parse(at);
  return time >= Date.parse(window.start) && time < Date.parse(window.end);
}
