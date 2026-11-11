// Structures and models of a sequence, from 3D-Beacons (looked up by MD5), and a 3D viewer.
// The viewer (3Dmol.js) is only loaded when a structure is shown.
import type { AtomSpec, GLViewer } from "3dmol";
import { swatch } from "./tracks.ts";
import { esc } from "./util.ts";

const API = "https://www.ebi.ac.uk/pdbe/pdbe-kb/3dbeacons/api/v2/sequence/summary";

export interface Structure {
  model_identifier: string;
  provider: string;
  experimental_method: string | null;
  model_url: string;
  model_format: string;
  model_page_url: string | null;
  created: string | null;
  resolution: number | null;
  confidence_type: string | null;
  confidence_avg_local_score: number | null;
  oligomeric_state: string | null;
  entities: { identifier: string | null; identifier_category: string | null; chain_ids: string[] | null }[];
}

/** The structures of a sequence: experimental ones first (best resolution first), then models (most confident first). */
export async function findStructures(md5: string, signal: AbortSignal): Promise<Structure[]> {
  const res = await fetch(`${API}?id=${md5}&type=md5`, { signal });
  if (res.status === 404) return [];      // no structures for this sequence
  if (!res.ok) throw new Error(`3D-Beacons: HTTP ${res.status}`);
  const structures: Structure[] = ((await res.json()).structures ?? []).map((s: { summary: Structure }) => s.summary);
  const key = (s: Structure) => (s.resolution !== null ? s.resolution : 1000 - (s.confidence_avg_local_score ?? 0));
  return structures.sort((a, b) => key(a) - key(b));
}

// 3Dmol.js format of each 3D-Beacons format that the viewer reads as text
const FORMATS: Record<string, string> = { MMCIF: "cif", PDB: "pdb" };
const isUrl = (url: string | null): url is string => !!url && url.startsWith("https://");
export const viewable = (s: Structure) => s.model_format in FORMATS && isUrl(s.model_url);
const isPlddt = (s: Structure) => s.confidence_type === "pLDDT";

// AlphaFold DB colours for the per-residue confidence (pLDDT), stored in the B-factor column
const PLDDT: [number, string, string][] = [
  [90, "#0053d6", "Very high (> 90)"],
  [70, "#65cbf3", "High (70–90)"],
  [50, "#ffdb13", "Low (50–70)"],
  [-Infinity, "#ff7d45", "Very low (< 50)"],
];
const plddtColour = (b: number) => PLDDT.find(([min]) => b > min)![1];

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

function quality(s: Structure) {
  if (s.resolution !== null) return `${s.resolution.toFixed(1)} Å`;
  if (s.confidence_avg_local_score !== null) {
    return `${esc(s.confidence_type ?? "")} ${s.confidence_avg_local_score.toFixed(1)}`;
  }
  return "";
}

function uniprotLinks(s: Structure) {
  const accessions = [...new Set(s.entities.filter((e) => e.identifier_category === "UNIPROT" && e.identifier).map((e) => e.identifier!))];
  return accessions.map((a) => `<a href="https://www.uniprot.org/uniprotkb/${encodeURIComponent(a)}/entry" target="_blank" rel="noopener">${esc(a)}</a>`).join(", ");
}

export function structuresHtml(structures: Structure[]) {
  const rows = structures.map((s, i) => `<tr data-s="${i}">
      <td>${isUrl(s.model_page_url)
        ? `<a href="${esc(s.model_page_url)}" target="_blank" rel="noopener">${esc(s.model_identifier)}</a>`
        : esc(s.model_identifier)}</td>
      <td class="nowrap">${esc(s.provider)}</td>
      <td>${s.experimental_method ? esc(titleCase(s.experimental_method)) : ""}</td>
      <td>${uniprotLinks(s)}</td>
      <td>${s.oligomeric_state ? esc(titleCase(s.oligomeric_state)) : ""}</td>
      <td class="num nowrap">${quality(s)}</td>
      <td>${viewable(s) ? `<button type="button" data-s="${i}">View</button>` : ""}</td>
    </tr>`).join("");
  return `<div class="structure-head"><span class="status" id="structure-status"></span><div class="legend" id="structure-legend"></div></div>
    <div class="structure-viewer" id="structure-viewer"></div>
    <div class="table-wrap"><table class="structures">
      <thead><tr><th>Model</th><th>Provider</th><th>Method</th><th>UniProtKB</th><th>Oligomeric state</th><th>Confidence / resolution</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note">${structures.length} structure${structures.length === 1 ? "" : "s"} from
      <a href="https://www.ebi.ac.uk/pdbe/pdbe-kb/3dbeacons/" target="_blank" rel="noopener">3D-Beacons</a>
      with this exact sequence.</p>`;
}

const plddtLegendHtml = () =>
  `<span class="muted">pLDDT</span>${PLDDT.map(([, colour, label]) => `<span>${swatch(colour, false)} ${label}</span>`).join("")}`;

const GREY = "#c9ced6";

// One viewer at a time: browsers limit the number of WebGL contexts
let viewer: GLViewer | null = null;
let viewerEl: HTMLElement | null = null;
let shown: Structure | null = null;
// The match highlighted, kept when another structure is shown; null: default colours
let highlighted: Parameters<typeof highlight> | null = null;

/** Shows a structure in `el`: cartoon coloured by pLDDT for predicted models, by chain position otherwise. */
export async function showStructure(el: HTMLElement, s: Structure, signal: AbortSignal) {
  const [mod, data] = await Promise.all([
    import("3dmol"),
    fetch(s.model_url, { signal }).then((res) => {
      if (!res.ok) throw new Error(`${s.provider}: HTTP ${res.status}`);
      return res.text();
    }),
  ]);
  if (signal.aborted) return;
  // 3Dmol.js is a CommonJS bundle: its functions may be on the default export
  const $3Dmol = mod.default ?? mod;

  if (viewer && viewerEl === el) {
    viewer.clear();
  } else {
    viewer?.getCanvas()?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    viewer = $3Dmol.createViewer(el, { backgroundColor: "white" });
    viewerEl = el;
  }
  const v = viewer;
  shown = s;
  v.addModel(data, FORMATS[s.model_format]);

  // Residue (and its pLDDT) under the pointer
  const plddt = isPlddt(s);
  type Hovered = AtomSpec & { label?: ReturnType<GLViewer["addLabel"]> };
  v.setHoverable({}, true,
    (atom: Hovered) => {
      if (atom.label) return;
      const text = `${atom.resn} ${atom.resi}${atom.chain ? ` (${atom.chain})` : ""}${plddt ? ` · pLDDT ${(atom.b ?? 0).toFixed(1)}` : ""}`;
      atom.label = v.addLabel(text, {
        position: { x: atom.x ?? 0, y: atom.y ?? 0, z: atom.z ?? 0 },
        backgroundColor: "#1b2430", backgroundOpacity: 0.85, fontColor: "white", fontSize: 12,
      });
    },
    (atom: Hovered) => {
      if (atom.label) { v.removeLabel(atom.label); delete atom.label; }
    });
  if (highlighted) highlight(...highlighted);
  else resetColours();
  v.zoomTo();
}

/** Default colours of the structure shown, and its legend. */
export function resetColours() {
  highlighted = null;
  if (!viewer || !shown) return;
  const plddt = isPlddt(shown);
  viewer.setStyle({}, { cartoon: plddt ? { colorfunc: (atom: AtomSpec) => plddtColour(atom.b ?? 0) } : { color: "spectrum" } });
  viewer.render();
  setLegend(plddt ? plddtLegendHtml() : "");
}

/** Colours the residues in `ranges` (sequence positions) of the structure shown, the rest in grey.
 *  The structures have exactly the same sequence, so positions are residue numbers. */
export function highlight(ranges: [number, number][], colour: string, label: string) {
  highlighted = [ranges, colour, label];
  if (!viewer || !shown) return;
  viewer.setStyle({}, { cartoon: { color: GREY } });
  // In a complex, only the chains of this sequence
  const chains = [...new Set(shown.entities.flatMap((e) => e.chain_ids ?? []))];
  const resi = ranges.map(([start, end]) => `${start}-${end}` as const);
  for (const chain of chains.length ? chains : [undefined]) {
    viewer.setStyle(chain ? { chain, resi } : { resi }, { cartoon: { color: colour } });
  }
  viewer.render();
  setLegend(`<span>${swatch(colour, false)} ${label}</span><span>${swatch(GREY, false)} Rest of the structure</span>
    <button type="button" id="structure-reset">Colour by ${isPlddt(shown) ? "pLDDT" : "chain position"}</button>`);
}

/** Frees the viewer, e.g. before showing another sequence. */
export function closeStructure() {
  viewer?.getCanvas()?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
  viewer = viewerEl = shown = highlighted = null;
}

function setLegend(html: string) {
  const legend = document.getElementById("structure-legend");
  if (legend) legend.innerHTML = html;
}
