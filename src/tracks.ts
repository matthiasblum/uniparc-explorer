// Rendering of the matches of a sequence: one track per member database (InterPro matches
// solid, InterPro-N predictions hatched), and a table.
import type { Match } from "./annotations.ts";
import { compareDatabases, databaseColours } from "./palette.ts";
import { esc, fmt, sci } from "./util.ts";

const LANE = 12, BAR = 9, MAX_LANES = 4;   // lanes per source and database

const isPrediction = (m: Match) => m.source === "InterPro-N";
const span = (m: Match) => [Math.min(...m.locations.map((l) => l.start)), Math.max(...m.locations.map((l) => l.end))];
// No-break spaces around the dash, so that a range never wraps
export const positions = (m: Match) => m.locations.map((l) => `${l.start}\u00a0–\u00a0${l.end}`).join(", ");

const patternId = (db: string) => `hatch-${db.replace(/[^A-Za-z0-9]/g, "_")}`;

/** Small solid or hatched sample of a colour, for the tracks, table and legend. */
export function swatch(colour: string, predicted: boolean) {
  return `<span class="swatch${predicted ? " hatched" : ""}" style="--c:${colour}"></span>`;
}

export function axis(length: number) {
  const pct = (p: number) => `${(((p - 1) / length) * 100).toFixed(3)}%`;
  const step = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((s) => length / s <= 8) ?? 20000;
  const ticks: number[] = [];
  for (let p = step; p < length * 0.93; p += step) ticks.push(p);     // keep clear of the end label
  return `<div class="track-label"></div>
    <svg class="axis" height="20" aria-hidden="true">
      <line x1="0" x2="100%" y1="18" y2="18"/>
      <text x="0" y="12">1</text>
      ${ticks.map((p) => `<line x1="${pct(p)}" x2="${pct(p)}" y1="14" y2="18"/><text x="${pct(p)}" y="12" text-anchor="middle">${p}</text>`).join("")}
      <text x="100%" y="12" text-anchor="end">${length}</text>
    </svg>`;
}

/** Placeholder shown while the matches are read: the axis and grey, pulsing tracks. */
export function skeletonHtml(length: number) {
  const widths = [[4, 38], [30, 62], [12, 81], [55, 30]];
  return `<div class="tracks skeleton" aria-hidden="true">${axis(length)}
    ${widths.map(([x, w]) => `<div class="track-label"><span class="bone" style="width:${50 + w}px"></span></div>
      <svg height="${BAR}"><rect x="${x}%" width="${w}%" height="${BAR}" rx="2"/></svg>`).join("")}
  </div>`;
}

export function legendHtml() {
  return `<div class="legend">
    <span>${swatch("var(--ink-2)", false)} InterPro (member database models)</span>
    <span>${swatch("var(--ink-2)", true)} InterPro-N (deep-learning predictions)</span>
  </div>`;
}

export function tracksHtml(matches: Match[], length: number, colours: Map<string, string>) {
  const pct = (p: number) => `${(((p - 1) / length) * 100).toFixed(3)}%`;
  const wpct = (s: number, e: number) => `${(Math.max((e - s + 1) / length, 0.004) * 100).toFixed(3)}%`;

  const byDb = new Map<string, Match[]>();
  for (const m of matches) byDb.set(m.database, [...(byDb.get(m.database) ?? []), m]);
  const dbs = [...byDb.keys()].sort(compareDatabases);

  const defs = dbs.filter((db) => byDb.get(db)!.some(isPrediction)).map((db) => {
    const c = colours.get(db)!;
    return `<pattern id="${patternId(db)}" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
      <rect width="5" height="5" fill="${c}" fill-opacity="0.18"/><rect width="2.2" height="5" fill="${c}"/></pattern>`;
  });

  const rows = [axis(length)];
  for (const db of dbs) {
    const bars: string[] = [];
    const colour = colours.get(db)!;
    let lanesUsed = 0, hidden = 0;
    for (const predicted of [false, true]) {
      const list = byDb.get(db)!.filter((m) => isPrediction(m) === predicted)
        .map((m) => ({ m, s: span(m) })).sort((a, b) => a.s[0] - b.s[0]);
      const lanes: number[] = [];               // end of the last match in each lane
      for (const { m, s: [s, e] } of list) {
        let lane = lanes.findIndex((end) => end < s);
        if (lane < 0) {
          if (lanes.length === MAX_LANES) { hidden++; continue; }
          lane = lanes.push(0) - 1;
        }
        lanes[lane] = e;
        const y = (lanesUsed + lane) * LANE;
        const id = matches.indexOf(m);
        for (const loc of m.locations) {
          const frags = loc.fragments?.length ? loc.fragments : [loc];
          if (frags.length > 1) {
            bars.push(`<line x1="${pct(loc.start)}" x2="${pct(loc.end + 1)}" y1="${y + BAR / 2}" y2="${y + BAR / 2}" stroke="${colour}"/>`);
          }
          for (const f of frags) {
            bars.push(`<rect class="bar" data-m="${id}" x="${pct(f.start)}" width="${wpct(f.start, f.end)}" y="${y}" height="${BAR}" rx="1.5"
              fill="${predicted ? `url(#${patternId(db)})` : colour}" stroke="${colour}" stroke-width="${predicted ? 1 : 0}"/>`);
          }
        }
      }
      lanesUsed += lanes.length;
    }
    const more = hidden ? ` <span class="muted" title="Overlapping matches not drawn; see the table">+${hidden}</span>` : "";
    rows.push(`<div class="track-label">${swatch(colour, false)}${esc(db)}${more}</div>
      <svg height="${lanesUsed * LANE - (LANE - BAR)}" role="img" aria-label="${esc(db)} matches">${bars.join("")}</svg>`);
  }
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${defs.join("")}</defs></svg>
    <div class="tracks">${rows.join("")}</div>`;
}

export function tooltipHtml(m: Match) {
  const scores = m.locations.map((l) => l.score).filter((s) => s !== null);
  return `<div class="tip-title">${esc(m.signature_accession)}${m.signature_name ? ` · ${esc(m.signature_name)}` : ""}</div>
    ${m.signature_description ? `<div>${esc(m.signature_description)}</div>` : ""}
    ${m.entry_accession ? `<div>${esc(m.entry_accession)} · ${esc(m.entry_description || m.entry_name || "")}</div>` : ""}
    <div class="tip-meta">${esc(m.database)} ${esc(m.database_version)} · ${positions(m)}${m.evalue !== null ? ` · E-value ${sci(m.evalue)}` : ""}
      ${isPrediction(m) && scores.length ? ` · score ${scores.map(sci).join(", ")}` : ""}</div>`;
}

export function tableHtml(matches: Match[], colours: Map<string, string>) {
  const sorted = [...matches].sort((a, b) =>
    compareDatabases(a.database, b.database) || a.source.localeCompare(b.source) || span(a)[0] - span(b)[0]);
  return `<div class="table-wrap"><table>
    <thead><tr><th>Database</th><th>Source</th><th>Signature</th><th>InterPro entry</th><th>Positions</th></tr></thead>
    <tbody>${sorted.map((m) => `<tr>
      <td class="nowrap">${swatch(colours.get(m.database)!, isPrediction(m))} ${esc(m.database)} <span class="muted">${esc(m.database_version)}</span></td>
      <td class="nowrap">${esc(m.source)}</td>
      <td><a href="https://www.ebi.ac.uk/interpro/search/text/${encodeURIComponent(m.signature_accession)}/">${esc(m.signature_accession)}</a>
        <div class="sub">${esc(m.signature_description || m.signature_name || "")}</div></td>
      <td>${m.entry_accession
        ? `<a href="https://www.ebi.ac.uk/interpro/entry/InterPro/${esc(m.entry_accession)}/">${esc(m.entry_accession)}</a>
           <div class="sub">${esc(m.entry_description || m.entry_name || "")}</div>`
        : `<span class="muted">—</span>`}</td>
      <td class="num">${positions(m)}</td>
    </tr>`).join("")}</tbody>
  </table></div>
  <p class="note">${fmt(matches.length)} match${matches.length === 1 ? "" : "es"}. InterPro-N matches are not integrated in InterPro entries.</p>`;
}
