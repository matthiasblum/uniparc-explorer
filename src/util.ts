export const fmt = (n: number) => n.toLocaleString("en-GB");

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const DAY_MS = 86_400_000;
export const parseDay = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const longDate = (t: number) =>
  new Date(t).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
export const shortDate = (t: number) =>
  new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Numbers in tables: 3 significant digits, scientific notation when small. */
export const sci = (x: number | null | undefined) =>
  x === null || x === undefined ? "" : x !== 0 && Math.abs(x) < 1e-3 ? x.toExponential(1) : String(+x.toPrecision(3));

export function bytes(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`;
}

const tooltip = () => document.getElementById("tooltip")!;

export function showTooltip(html: string, target: Element) {
  const tip = tooltip();
  tip.innerHTML = html;
  tip.hidden = false;
  const r = target.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const x = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8));
  const y = r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

export const hideTooltip = () => { tooltip().hidden = true; };
