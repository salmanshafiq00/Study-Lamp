const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const stamp = Date.UTC(year, month - 1, day);
  return new Date(stamp).getUTCFullYear() === year
    && new Date(stamp).getUTCMonth() === month - 1
    && new Date(stamp).getUTCDate() === day;
}

export function addDaysToIsoDate(date: string, days: number): string {
  if (!isValidIsoDate(date)) throw new Error(`Invalid ISO date: ${date}`);
  if (!Number.isInteger(days)) throw new Error("days must be an integer");

  const [yearText, monthText, dayText] = date.split("-");
  const utcDate = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  utcDate.setUTCDate(utcDate.getUTCDate() + days);

  const year = utcDate.getUTCFullYear();
  const month = String(utcDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utcDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isoDatePart(rfc3339: string | null | undefined): string | null {
  if (typeof rfc3339 !== "string" || rfc3339.length < 10) return null;
  const datePart = rfc3339.slice(0, 10);
  return isValidIsoDate(datePart) ? datePart : null;
}

/** Today's date in the user's LOCAL time zone as yyyy-MM-dd (never toISOString(), which is UTC). */
export function localIsoDate(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
