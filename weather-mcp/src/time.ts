const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_FORECAST_MS = 5 * 24 * HOUR_MS;

export class InputError extends Error {}

export interface WorkPeriod {
  start: Date;
  end: Date;
}

export interface SearchPeriod extends WorkPeriod {}

export interface CandidatePeriod extends WorkPeriod {
  duration_hours: number;
}

function parseMoscowDateTime(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new InputError("Дата и время должны иметь формат YYYY-MM-DDTHH:mm по МСК.");
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText].map(Number);
  const localAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (localAsUtc.getUTCFullYear() !== year || localAsUtc.getUTCMonth() !== month - 1 || localAsUtc.getUTCDate() !== day || localAsUtc.getUTCHours() !== hour || localAsUtc.getUTCMinutes() !== minute) {
    throw new InputError("Указана несуществующая дата или время.");
  }
  return new Date(localAsUtc.getTime() - MOSCOW_OFFSET_MS);
}

export function parseSearchPeriod(searchStart: string, searchEnd: string, now: Date): SearchPeriod {
  const start = parseMoscowDateTime(searchStart);
  const end = parseMoscowDateTime(searchEnd);
  if (start.getTime() <= now.getTime()) throw new InputError("Начало поиска должно быть позже текущего момента.");
  if (end.getTime() <= start.getTime()) throw new InputError("Конец поиска должен быть позже его начала.");
  if (end.getTime() > now.getTime() + MAX_FORECAST_MS) throw new InputError("Весь период поиска должен завершиться не позднее пяти суток от текущего момента.");
  return { start, end };
}

export function buildCandidatePeriods(period: SearchPeriod, durationHours: number): CandidatePeriod[] {
  const candidates: CandidatePeriod[] = [];
  const durationMs = durationHours * HOUR_MS;
  const firstStart = Math.ceil(period.start.getTime() / HOUR_MS) * HOUR_MS;
  for (let start = firstStart; start + durationMs <= period.end.getTime(); start += HOUR_MS) {
    candidates.push({ start: new Date(start), end: new Date(start + durationMs), duration_hours: durationHours });
  }
  return candidates;
}

export function parseWorkPeriod(startAt: string, durationHours: number, now = new Date()): WorkPeriod {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(startAt);
  if (!match) {
    throw new InputError("Дата и время должны иметь формат YYYY-MM-DDTHH:mm по МСК.");
  }

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText].map(Number);
  const localAsUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    localAsUtc.getUTCFullYear() !== year ||
    localAsUtc.getUTCMonth() !== month - 1 ||
    localAsUtc.getUTCDate() !== day ||
    localAsUtc.getUTCHours() !== hour ||
    localAsUtc.getUTCMinutes() !== minute
  ) {
    throw new InputError("Указана несуществующая дата или время.");
  }
  if (!Number.isFinite(durationHours) || durationHours <= 0) {
    throw new InputError("Продолжительность должна быть положительным числом часов.");
  }

  const start = new Date(localAsUtc.getTime() - MOSCOW_OFFSET_MS);
  const end = new Date(start.getTime() + durationHours * HOUR_MS);
  if (!Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) {
    throw new InputError("Продолжительность работ слишком мала для оценки прогноза.");
  }
  if (start.getTime() < now.getTime()) {
    throw new InputError("Начало работ должно быть не раньше текущего момента.");
  }
  if (end.getTime() > now.getTime() + MAX_FORECAST_MS) {
    throw new InputError("Работы должны завершиться не позднее пяти суток от текущего момента.");
  }
  return { start, end };
}

export function intersectsHour(hourStart: Date, period: WorkPeriod): boolean {
  return hourStart.getTime() < period.end.getTime() && hourStart.getTime() + HOUR_MS > period.start.getTime();
}
