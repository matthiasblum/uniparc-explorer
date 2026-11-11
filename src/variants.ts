// Sequence neighbourhood: the single-residue substitutions of a sequence that are themselves
// UniParc sequences. Each variant has its own MD5, so the scan checks all 19 × length of them
// against UniParc, 100 checksums per UniProt API request.
import { axis } from "./tracks.ts";
import { findChecksums, md5 } from "./uniparc.ts";
import { fmt } from "./util.ts";

/** Rows of the map: hydrophobic, aromatic, polar, special, then charged residues. */
export const RESIDUES = "AVILMFYWSTNQCGPDEKRH";
export const MAX_LENGTH = 2000;
const ROW = 12, BATCH = 100, CONCURRENCY = 4;

export interface Variant {
  pos: number;      // 1-based
  from: string;
  to: string;
  md5: string;
  upi?: string;
}

export const label = (v: Pick<Variant, "pos" | "from" | "to">) => `${v.from}${v.pos}${v.to}`;

export function variantsOf(sequence: string): Variant[] {
  const out: Variant[] = [];
  for (let i = 0; i < sequence.length; i++) {
    for (const to of RESIDUES) {
      if (to !== sequence[i]) out.push({ pos: i + 1, from: sequence[i], to, md5: md5(sequence.slice(0, i) + to + sequence.slice(i + 1)) });
    }
  }
  return out;
}

/** Checks all variants, N- to C-terminus; `progress` gets each batch's hits and the last position checked. */
export async function scan(variants: Variant[], progress: (found: Variant[], upTo: number) => void, signal: AbortSignal) {
  const byMd5 = new Map(variants.map((v) => [v.md5, v]));
  const batches: Variant[][] = [];
  for (let i = 0; i < variants.length; i += BATCH) batches.push(variants.slice(i, i + BATCH));
  const done = new Array<boolean>(batches.length).fill(false);
  let next = 0, upTo = 0;

  async function worker() {
    while (next < batches.length && !signal.aborted) {
      const i = next++;
      const hits = await findChecksums(batches[i].map((v) => v.md5), signal);
      const found = hits.map(({ upi, md5 }) => Object.assign(byMd5.get(md5)!, { upi })).filter((v) => v);
      done[i] = true;
      while (upTo < batches.length && done[upTo]) upTo++;     // positions before this are all checked
      if (!signal.aborted) progress(found, upTo === batches.length ? Infinity : batches[upTo][0].pos - 1);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/** The map: one row per residue, one column per position; the sequence's own residues in grey. */
/** `hasBack`: whether this sequence was reached by a step, so that one variant leads back. */
export function mapHtml(sequence: string, hasBack: boolean) {
  const L = sequence.length;
  const x = (p: number) => `${(((p - 1) / L) * 100).toFixed(3)}%`;
  const w = `${Math.max(100 / L, 0.35).toFixed(3)}%`;
  const height = RESIDUES.length * ROW;
  const own = [...sequence].map((c, i) => {
    const row = RESIDUES.indexOf(c);
    return row < 0 ? "" : `<rect class="wt" x="${x(i + 1)}" y="${row * ROW + 1}" width="${w}" height="${ROW - 2}"/>`;
  }).join("");
  const letters = [...RESIDUES].map((c, i) => `<text x="100%" y="${i * ROW + ROW - 2}" text-anchor="end">${c}</text>`).join("");
  const stripes = [...RESIDUES].map((_, i) => (i % 2 ? `<rect class="stripe" x="0" width="100%" y="${i * ROW}" height="${ROW}"/>` : "")).join("");
  const key = (cls: string, text: string) => `<span><svg width="10" height="10"><rect class="${cls}" width="10" height="10" rx="1.5"/></svg>${text}</span>`;
  return `<div class="legend vmap-key">${key("hit", "Variant in UniParc")}${hasBack ? key("hit back", "Previous sequence") : ""}${key("wt", "Residue of this sequence")}
      <span class="muted">Rows: amino acids; columns: positions.</span></div>
    <div class="tracks vmap">${axis(L)}
    <div class="track-label vmap-letters"><svg height="${height}" aria-hidden="true">${letters}</svg></div>
    <svg height="${height}" id="vmap" role="img" aria-label="Single-residue variants found in UniParc">
      ${stripes}<rect id="vmap-pending" class="pending" x="0" width="100%" y="0" height="${height}"/>${own}<g id="vmap-hits"></g>
    </svg>
  </div>`;
}

/** Updates the map: hides the not-yet-checked shade up to `upTo` and adds the hits. */
export function updateMap(sequence: string, found: Variant[], upTo: number, back: string | null) {
  const L = sequence.length;
  const pending = document.getElementById("vmap-pending");
  if (pending) {
    const from = Math.min(upTo, L) / L;
    pending.setAttribute("x", `${(from * 100).toFixed(3)}%`);
    pending.setAttribute("width", `${((1 - from) * 100).toFixed(3)}%`);
  }
  const g = document.getElementById("vmap-hits");
  if (!g) return;
  const w = Math.max(100 / L, 0.35);
  for (const v of found) {
    const cls = label(v) === back ? "hit back" : "hit";
    g.insertAdjacentHTML("beforeend", `<rect class="${cls}" data-v="${label(v)}" data-upi="${v.upi}"
      x="${(((v.pos - 1) / L) * 100 - (w - 100 / L) / 2).toFixed(3)}%" y="${RESIDUES.indexOf(v.to) * ROW}" width="${w.toFixed(3)}%" height="${ROW}" rx="1.5"/>`);
  }
}

const MAX_CHIPS = 60;

/** The variants found, as links; after MAX_CHIPS, the rest are behind a "show all" button. */
export function chipsHtml(found: Variant[], back: string | null, all = false) {
  const sorted = [...found].sort((a, b) => a.pos - b.pos || a.to.localeCompare(b.to));
  const shown = all ? sorted : sorted.slice(0, MAX_CHIPS);
  return shown.map((v) => `<a class="chip${label(v) === back ? " back" : ""}" href="#${v.upi}" data-v="${label(v)}" data-upi="${v.upi}">${label(v)}</a>`).join("") +
    (shown.length < sorted.length ? `<button type="button" class="chip more" id="all-chips">Show all ${fmt(sorted.length)}</button>` : "");
}
