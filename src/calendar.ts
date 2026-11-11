// Calendar heatmap of the sequences added to UniParc per day: one row of weeks per year.
import { DAY_CLASSES, dayClass } from "./palette.ts";
import type { Summary } from "./summary.ts";
import { DAY_MS, fmt, isoDay, longDate, parseDay } from "./util.ts";

// A day is a square plus a gap: `step` pixels, between MIN_STEP and MAX_STEP depending on the width
const GAP = 2, LEFT = 32, TOP = 16, MIN_STEP = 12, MAX_STEP = 24;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export class Calendar {
  readonly days = new Map<string, [number, string]>();   // date -> [sequences, first UPI]
  readonly first: number;
  readonly last: number;
  private readonly firstUpis: [string, string][];         // [first UPI, date], ascending
  private readonly summary: Summary;

  constructor(summary: Summary) {
    this.summary = summary;
    for (const [d, n, upi] of summary.days) this.days.set(d, [n, upi]);
    this.first = parseDay(summary.calendarStart);
    this.last = parseDay(summary.days[summary.days.length - 1][0]);
    this.firstUpis = summary.days.map(([d, , upi]) => [upi, d]);
  }

  /** Day a UPI was added: UPIs are assigned in order, so it is the last day whose first UPI is not after it.
   *  "before" for UPIs older than the calendar, null for UPIs newer than the dataset. */
  dayOf(upi: string): string | "before" | null {
    const lastUpi = this.summary.upiRanges[this.summary.upiRanges.length - 1][1];
    if (upi > lastUpi) return null;
    let lo = 0, hi = this.firstUpis.length - 1, best: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.firstUpis[mid][0] <= upi) { best = this.firstUpis[mid][1]; lo = mid + 1; } else hi = mid - 1;
    }
    return best ?? "before";
  }

  /** Week columns of a year (weeks start on Monday), and the column of January 1. */
  private static weeks(year: number) {
    const jan1 = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
    const offset = (new Date(jan1).getUTCDay() + 6) % 7;
    return { jan1, end, offset, weeks: Math.ceil((offset + (end - jan1) / DAY_MS) / 7) };
  }

  private get years() {
    const y0 = new Date(this.first).getUTCFullYear(), y1 = new Date(this.last).getUTCFullYear();
    return Array.from({ length: y1 - y0 + 1 }, (_, i) => y1 - i);     // most recent first
  }

  /** Size of a day for year grids that fit in `width` pixels. */
  step(width: number) {
    const weeks = Math.max(...this.years.map((y) => Calendar.weeks(y).weeks));
    return Math.max(MIN_STEP, Math.min(MAX_STEP, Math.floor((width - LEFT) / weeks)));
  }

  private yearSvg(year: number, step: number) {
    const { jan1, end, offset, weeks } = Calendar.weeks(year);
    const cell = step - GAP;
    const parts: string[] = [];
    for (let m = 0; m < 12; m++) {
      const col = Math.floor((offset + (Date.UTC(year, m, 1) - jan1) / DAY_MS) / 7);
      parts.push(`<text x="${LEFT + col * step}" y="11">${MONTHS[m]}</text>`);
    }
    for (const [row, name] of [[0, "Mon"], [2, "Wed"], [4, "Fri"]] as const) {
      parts.push(`<text x="0" y="${TOP + row * step + cell / 2 + 4}">${name}</text>`);
    }
    for (let t = jan1, i = offset; t < end; t += DAY_MS, i++) {
      if (t < this.first || t > this.last) continue;
      const d = isoDay(t);
      const n = this.days.get(d)?.[0] ?? 0;
      parts.push(`<rect data-d="${d}" class="c${dayClass(n)}" x="${LEFT + Math.floor(i / 7) * step}" y="${TOP + (i % 7) * step}" width="${cell}" height="${cell}" rx="2"/>`);
    }
    const width = LEFT + weeks * step, height = TOP + 7 * step;
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Sequences added per day in ${year}">${parts.join("")}</svg>`;
  }

  html(step = MIN_STEP) {
    const perYear = new Map<number, number>();
    for (const [d, n] of this.summary.days) perYear.set(+d.slice(0, 4), (perYear.get(+d.slice(0, 4)) ?? 0) + n);
    return this.years.map((y) =>
      `<div class="cal-year"><div class="cal-head">${y}<span>${fmt(perYear.get(y) ?? 0)}</span></div>${this.yearSvg(y, step)}</div>`).join("");
  }

  legendHtml() {
    const short = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : String(n));
    const labels = ["0", `1–${short(DAY_CLASSES[0])}`];
    for (let i = 1; i < DAY_CLASSES.length; i++) labels.push(`${short(DAY_CLASSES[i - 1])}–${short(DAY_CLASSES[i])}`);
    labels.push(`≥ ${short(DAY_CLASSES[DAY_CLASSES.length - 1])}`);
    return `<span class="muted">Sequences per day</span>` +
      labels.map((l, i) => `<span class="cal-key"><svg width="10" height="10"><rect class="c${i}" width="10" height="10" rx="1.5"/></svg>${l}</span>`).join("");
  }

  tooltip(d: string) {
    const entry = this.days.get(d);
    if (!entry) return `No sequences added on ${longDate(parseDay(d))}`;
    const [n, upi] = entry;
    return `<div class="tip-title">${fmt(n)} sequence${n === 1 ? "" : "s"}</div>
      <div>${longDate(parseDay(d))}</div><div class="tip-meta">From ${upi} · click to open it</div>`;
  }
}
