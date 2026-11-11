import "./style.css";
import { Calendar } from "./calendar.ts";
import { config } from "./config.ts";
import summaryJson from "./data/summary.json";
import type { Summary } from "./summary.ts";
import { databaseColours } from "./palette.ts";
import { legendHtml, skeletonHtml, tableHtml, tooltipHtml, tracksHtml } from "./tracks.ts";
import { accessionQuery, classify, lookup, md5 } from "./uniparc.ts";
import type { Sequence } from "./uniparc.ts";
import { esc, fmt, hideTooltip, longDate, parseDay, shortDate, showTooltip } from "./util.ts";
import { MAX_LENGTH, chipsHtml, label, mapHtml, scan, updateMap, variantsOf } from "./variants.ts";
import type { Variant } from "./variants.ts";

const summary = summaryJson as Summary;
const calendar = new Calendar(summary);
const loadAnnotations = () => import("./annotations.ts");   // hyparquet is only needed for searches

// ------------------------------------------------------------------ overview
document.getElementById("release")!.textContent =
  `UniProt release ${config.uniprotRelease} · InterPro ${config.interproRelease}`;
document.getElementById("stats")!.innerHTML =
  `<b>${fmt(summary.numSequences)}</b> sequences · <b>${fmt(summary.numMatches)}</b> InterPro matches`;

document.getElementById("calendar-legend")!.innerHTML = calendar.legendHtml();
document.getElementById("calendar-note")!.innerHTML = `Days from ${shortDate(calendar.first)} to ${shortDate(calendar.last)}, the last day in UniProt ${config.uniprotRelease}.
  Select a day to open the first sequence added that day.`;

const calendarEl = document.getElementById("calendar")!;
calendarEl.addEventListener("mouseover", (e) => {
  const d = (e.target as Element).getAttribute?.("data-d");
  if (d) showTooltip(calendar.tooltip(d), e.target as Element);
});
calendarEl.addEventListener("mouseout", hideTooltip);
calendarEl.addEventListener("click", (e) => {
  const d = (e.target as Element).getAttribute?.("data-d");
  const upi = d && calendar.days.get(d)?.[1];
  if (upi) go(upi);
});
window.addEventListener("scroll", hideTooltip, { passive: true });

let selectedDay: string | null = null;
function markDay(day: string | null) {
  selectedDay = day;
  calendarEl.querySelectorAll("rect.selected").forEach((r) => r.classList.remove("selected"));
  if (day) calendarEl.querySelector(`rect[data-d="${day}"]`)?.classList.add("selected");
}

// The squares fill the width of the panel: drawn small first, then redrawn whenever the
// space for a year's grid (from its left edge to the end of the row) gives a different size.
let calendarStep = 0;
function drawCalendar() {
  const row = calendarEl.querySelector(".cal-year"), grid = row?.querySelector("svg");
  const step = row && grid ? calendar.step(row.getBoundingClientRect().right - grid.getBoundingClientRect().left) : calendar.step(0);
  if (step === calendarStep) return;
  calendarStep = step;
  calendarEl.innerHTML = calendar.html(step);
  markDay(selectedDay);
}
drawCalendar();
new ResizeObserver(drawCalendar).observe(calendarEl);

// ------------------------------------------------------------------ search
const result = document.getElementById("result")!;
let current: AbortController | null = null;

/** A panel; `id` panels have an identifier as title, shown in monospace. */
function panel(title: string, body: string, extra = "", kind: "" | "id" = "") {
  return `<section class="panel"><header class="panel-head"><h2 class="${kind}">${title}</h2>${extra}</header><div class="panel-body">${body}</div></section>`;
}

function message(html: string, kind: "info" | "error" = "info") {
  result.hidden = false;
  result.innerHTML = `<div class="message ${kind}">${html}</div>`;
}

function sequenceHtml(seq: string) {
  const width = String(seq.length).length;
  const lines: string[] = [];
  for (let i = 0; i < seq.length; i += 60) {
    const chunk = seq.slice(i, i + 60).match(/.{1,10}/g)!.join(" ");
    lines.push(`<span class="pos">${String(i + 1).padStart(width)}</span>  ${chunk}`);
  }
  return lines.join("\n");
}

function sequenceSkeleton(what: string) {
  result.hidden = false;
  result.innerHTML = panel(what, `
    <div class="status">Looking up the sequence in UniParc…</div>
    <div class="facts skeleton">${'<span class="bone" style="width:9em"></span>'.repeat(4)}</div>
    <div class="skeleton">${'<span class="bone line"></span>'.repeat(3)}</div>`, "", "id");
}

function renderSequence(entry: Sequence, day: string | "before" | null) {
  const added = day === "before" ? `before ${shortDate(calendar.first)}`
    : day ? `<a href="#" id="added-day">${longDate(parseDay(day))}</a>` : "after this release";
  result.innerHTML =
    panel(entry.upi, `
      <dl class="facts">
        <div><dt>Length</dt><dd>${fmt(entry.length)} aa</dd></div>
        <div><dt>Added to UniParc</dt><dd>${added}</dd></div>
        <div><dt>MD5</dt><dd><code>${entry.md5}</code></dd></div>
        <div><dt>CRC64</dt><dd><code>${entry.crc64}</code></dd></div>
      </dl>
      <div class="seq-tools">
        <button type="button" id="copy-seq">Copy sequence</button>
        <button type="button" id="fasta">Download FASTA</button>
      </div>
      <pre class="seq">${sequenceHtml(entry.sequence)}</pre>`,
      `<a class="ext" href="https://www.uniprot.org/uniparc/${entry.upi}/entry" target="_blank" rel="noopener">UniParc entry ↗</a>`, "id") +
    panel("InterPro matches", `<div id="matches"></div>`, legendHtml()) +
    `<section class="panel" id="neighbourhood"></section>`;

  document.getElementById("copy-seq")!.onclick = async (e) => {
    const button = e.target as HTMLButtonElement;
    await navigator.clipboard.writeText(entry.sequence);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy sequence"), 1500);
  };
  document.getElementById("fasta")!.onclick = () => {
    const body = `>${entry.upi}\n${entry.sequence.match(/.{1,60}/g)!.join("\n")}\n`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    a.download = `${entry.upi}.fasta`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  if (day && day !== "before") {
    document.getElementById("added-day")!.onclick = (e) => {
      e.preventDefault();
      calendarEl.querySelector(`rect[data-d="${day}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  }
}

async function renderMatches(entry: Sequence, signal: AbortSignal) {
  const box = document.getElementById("matches")!;
  const status = (msg: string) => {
    if (!signal.aborted) document.getElementById("matches-status")!.textContent = `${msg} from Hugging Face…`;
  };
  box.innerHTML = `<div class="status" id="matches-status">Loading the Parquet reader…</div>${skeletonHtml(entry.length)}`;
  const t0 = performance.now();
  let matches;
  try {
    const { findMatches } = await loadAnnotations();
    matches = await findMatches(summary, entry.md5, status);
  } catch (e) {
    if (!signal.aborted) box.innerHTML = `<div class="message error">Could not read the annotations: ${esc((e as Error).message)}</div>`;
    return;
  }
  if (signal.aborted) return;
  if (!matches.length) {
    box.innerHTML = `<p class="muted">No InterPro matches for this sequence.</p>`;
    return;
  }
  const colours = databaseColours(matches.map((m) => m.database));
  box.innerHTML = tracksHtml(matches, entry.length, colours) + tableHtml(matches, colours) +
    `<p class="note">Read from Parquet in ${((performance.now() - t0) / 1000).toFixed(1)} s.</p>`;
  box.addEventListener("mouseover", (e) => {
    const id = (e.target as Element).getAttribute?.("data-m");
    if (id !== null && id !== undefined) showTooltip(tooltipHtml(matches[+id]), e.target as Element);
  });
  box.addEventListener("mouseout", hideTooltip);
}

// ------------------------------------------------------------------ neighbourhood
// A walk through sequence space: each step goes to a variant that differs by one residue.
interface Step { upi: string; via: Variant | null }
let nextTrail: Step[] | null = null;

function step(trail: Step[], to: Step) {
  nextTrail = [...trail, to];
  go(to.upi, "neighbourhood");
}

function trailHtml(trail: Step[]) {
  if (trail.length < 2) return "";
  return `<div class="trail"><span class="muted">Path:</span> ${trail.map((s, i) =>
    `${s.via ? `<span class="trail-step">${label(s.via)}</span> ` : ""}${i === trail.length - 1
      ? `<code>${s.upi}</code>` : `<a href="#${s.upi}" data-trail="${i}"><code>${s.upi}</code></a>`}`).join(" → ")}</div>`;
}

function renderNeighbourhood(entry: Sequence, trail: Step[], autoStart: boolean, signal: AbortSignal) {
  const box = document.getElementById("neighbourhood")!;
  const variants = variantsOf(entry.sequence);
  const last = trail.at(-1)!.via;
  const back = last ? `${last.to}${last.pos}${last.from}` : null;      // the substitution that leads back
  const tooLong = entry.length > MAX_LENGTH;
  box.innerHTML = `<header class="panel-head"><h2>Sequence neighbourhood</h2></header>
    <div class="panel-body">
      <p class="lead">Every single-residue substitution of this sequence is another sequence, with its own checksum.
        The scan looks up all ${fmt(variants.length)} of them (19 × ${fmt(entry.length)}) to find the variant sequences
        available in UniParc. Select a variant to open it and explore its own neighbourhood.</p>
      ${trailHtml(trail)}
      <div class="actions">
        <button type="button" class="primary" id="scan"${tooLong ? " disabled" : ""}>Scan ${fmt(variants.length)} variants</button>
        <button type="button" id="step" hidden>Step to a random neighbour</button>
        <span class="status" id="scan-status">${tooLong ? `Scans are limited to sequences of up to ${fmt(MAX_LENGTH)} residues.` : ""}</span>
      </div>
      <div id="vmap-box"></div>
      <div class="chips" id="chips"></div>
    </div>`;

  box.querySelectorAll<HTMLAnchorElement>("a[data-trail]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const i = +a.dataset.trail!;
    nextTrail = trail.slice(0, i + 1);
    go(trail[i].upi, "neighbourhood");
  }));

  const found: Variant[] = [];
  const open = (el: Element | null) => {
    const v = found.find((f) => label(f) === el?.getAttribute("data-v"));
    if (v) step(trail, { upi: v.upi!, via: v });
  };
  let allChips = false;
  box.addEventListener("click", (e) => {
    if ((e.target as Element).id === "all-chips") {
      allChips = true;
      document.getElementById("chips")!.innerHTML = chipsHtml(found, back, true);
      return;
    }
    const el = (e.target as Element).closest?.("[data-v]");
    if (el) { e.preventDefault(); open(el); }
  });
  box.addEventListener("mouseover", (e) => {
    const el = (e.target as Element).closest?.("rect[data-v]");
    if (!el) return;
    const v = el.getAttribute("data-v")!;
    showTooltip(`<div class="tip-title">${v} · ${el.getAttribute("data-upi")}</div>
      <div class="tip-meta">${v === back ? "Previous sequence · " : ""}click to visit</div>`, el);
  });
  box.addEventListener("mouseout", hideTooltip);

  const start = async () => {
    const button = document.getElementById("scan") as HTMLButtonElement, status = document.getElementById("scan-status")!;
    button.disabled = true;
    document.getElementById("vmap-box")!.innerHTML = mapHtml(entry.sequence, back !== null);
    let checked = 0;
    const t0 = performance.now();
    try {
      await scan(variants, (hits, upTo) => {
        found.push(...hits);
        checked = upTo === Infinity ? variants.length : Math.max(checked, variants.findIndex((v) => v.pos > upTo));
        updateMap(entry.sequence, hits, upTo, back);
        document.getElementById("chips")!.innerHTML = chipsHtml(found, back, allChips);
        status.textContent = upTo === Infinity ? "" : `Checked ${fmt(checked)} of ${fmt(variants.length)} variants: ${fmt(found.length)} found…`;
      }, signal);
    } catch (e) {
      if (!signal.aborted) status.textContent = `The scan stopped: ${(e as Error).message}.`;
      button.disabled = false;
      return;
    }
    if (signal.aborted) return;
    status.textContent = `${fmt(found.length)} of ${fmt(variants.length)} variants are UniParc sequences
      (${((performance.now() - t0) / 1000).toFixed(0)} s).`;
    button.hidden = true;
    const stepButton = document.getElementById("step") as HTMLButtonElement;
    // Prefer going forward: the previous sequence is always there
    const forward = found.filter((v) => label(v) !== back);
    stepButton.hidden = !forward.length;
    stepButton.onclick = () => open(box.querySelector(`[data-v="${label(forward[Math.floor(Math.random() * forward.length)])}"]`));
    if (!found.length) document.getElementById("chips")!.innerHTML = `<p class="muted">No neighbours: this sequence is alone in its neighbourhood.</p>`;
  };
  document.getElementById("scan")!.addEventListener("click", start);
  if (autoStart && !tooLong) start();
}

async function search(raw: string) {
  current?.abort();
  const controller = new AbortController();
  current = controller;
  const { signal } = controller;

  const query = classify(raw);
  if (!query) return;
  if (query.type === "invalid") {
    message("Enter a UniParc identifier (UPI), a UniProtKB accession, an MD5 checksum, or a protein sequence (one-letter amino acid codes).", "error");
    return;
  }

  let entry: Sequence | null;
  const checksum = query.type === "md5" ? query.value : query.type === "sequence" ? md5(query.value) : null;
  sequenceSkeleton(checksum ? `MD5 ${checksum}` : query.value);
  try {
    entry = await lookup(checksum ? `checksum:${checksum}`
      : query.type === "accession" ? accessionQuery(query.value) : `upi:${query.value}`, signal);
  } catch (e) {
    if (!signal.aborted) message(`The UniProt API could not be reached (${esc((e as Error).message)}).`, "error");
    return;
  }
  if (signal.aborted) return;
  if (!entry) {
    message(query.type === "upi" ? `${query.value} is not a UniParc identifier.`
      : query.type === "accession" ? `${query.value} is not a current UniProtKB accession.`
      : `No UniParc sequence has the MD5 checksum <code>${checksum}</code>.`);
    return;
  }

  if (location.hash.slice(1) !== entry.upi) history.replaceState(null, "", `#${entry.upi}`);
  const day = calendar.dayOf(entry.upi);
  markDay(day === "before" ? null : day);
  renderSequence(entry, day);
  const arrived = nextTrail?.at(-1)?.upi === entry.upi ? nextTrail! : null;
  nextTrail = null;
  renderNeighbourhood(entry, arrived ?? [{ upi: entry.upi, via: null }], !!arrived && arrived.length > 1, signal);
  if (pendingScroll) {
    document.getElementById(pendingScroll)!.scrollIntoView({ block: "start" });
    pendingScroll = null;
  }
  if (day === null) {
    document.getElementById("matches")!.innerHTML = `<p class="muted">This sequence was added to UniParc after UniProt release ${config.uniprotRelease} and is not in the dataset.</p>`;
    return;
  }
  await renderMatches(entry, signal);
}

// ------------------------------------------------------------------ wiring
const input = document.getElementById("q") as HTMLTextAreaElement;

let pendingScroll: string | null = null;    // panel to show once the result is rendered

function go(q: string, scrollTo: "result" | "neighbourhood" = "result") {
  input.value = q;
  pendingScroll = scrollTo === "result" ? null : scrollTo;
  if (scrollTo === "result") result.scrollIntoView({ behavior: "smooth", block: "start" });
  if (location.hash.slice(1) === q) search(q);
  else location.hash = q;                  // hashchange -> search
}

document.getElementById("search-form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  const query = classify(input.value);
  if (query && (query.type === "upi" || query.type === "md5" || query.type === "accession")) go(query.value);
  else {
    history.replaceState(null, "", location.pathname + location.search);   // set to the UPI once found
    search(input.value);
  }
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    (document.getElementById("search-form") as HTMLFormElement).requestSubmit();
  }
});

for (const a of document.querySelectorAll<HTMLAnchorElement>("a[data-example]")) {
  a.addEventListener("click", (e) => { e.preventDefault(); go(a.dataset.example!); });
}

// Random sequence: pick a file (weighted by its number of sequences), then a UPI in its range.
// A few UPIs were never assigned, so retry if the API does not know one.
document.getElementById("random")!.addEventListener("click", async (e) => {
  const button = e.target as HTMLButtonElement;
  button.disabled = true;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      let r = Math.random() * summary.numSequences, i = 0;
      while (r > summary.upiRanges[i][2]) r -= summary.upiRanges[i++][2];
      const lo = parseInt(summary.upiRanges[i][0].slice(3), 16), hi = parseInt(summary.upiRanges[i][1].slice(3), 16);
      const upi = `UPI${Math.floor(lo + Math.random() * (hi - lo + 1)).toString(16).toUpperCase().padStart(10, "0")}`;
      if (await lookup(`upi:${upi}`).catch(() => null)) { go(upi); return; }
    }
    message("No sequence found after five attempts; please try again.", "error");
  } finally {
    button.disabled = false;
  }
});

function fromHash() {
  const q = decodeURIComponent(location.hash.slice(1));
  if (q) { input.value = q; search(q); }
}
window.addEventListener("hashchange", fromHash);
fromHash();

// Fetch the Parquet reader while the user is typing
("requestIdleCallback" in window ? requestIdleCallback : setTimeout)(() => { loadAnnotations(); });
