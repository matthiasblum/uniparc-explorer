// Reads the InterPro matches of one sequence from the annotations Parquet files.
//
// Files are named annotations/part-XX-NNNN.parquet (XX = first MD5 byte) and sorted by MD5,
// with min/max statistics per row group. A lookup reads one footer (about 1 MB) to find the
// row group, then that row group only.
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import type { AsyncBuffer, FileMetaData } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { config } from "./config.ts";
import { fileUrl, hfFetch } from "./hf.ts";
import type { Summary } from "./summary.ts";

export interface Fragment { start: number; end: number; dc_status: string | null }
export interface Location {
  start: number;
  end: number;
  score: number | null;
  evalue: number | null;
  pvalue: number | null;
  sequence_feature: string | null;
  fragments: Fragment[] | null;
}
export interface Match {
  upi: string;
  md5: string;
  source: "InterPro" | "InterPro-N";
  database: string;
  database_version: string;
  signature_accession: string;
  signature_name: string | null;
  signature_description: string | null;
  signature_type: string | null;
  entry_accession: string | null;
  entry_name: string | null;
  entry_description: string | null;
  entry_type: string | null;
  score: number | null;
  evalue: number | null;
  locations: Location[];
}

export type Progress = (message: string) => void;

interface OpenFile { file: AsyncBuffer; metadata: FileMetaData; md5Column: number }

const FOOTER_FETCH = 1_200_000;   // footers are about 1 MB: read them in one request
const opened = new Map<string, Promise<OpenFile>>();

function open(summary: Summary, path: string, size: number): Promise<OpenFile> {
  let file = opened.get(path);
  if (!file) {
    file = (async () => {
      const url = fileUrl(config.hfRepo, summary.revision, path);
      const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url, byteLength: size, fetch: hfFetch }));
      const metadata = await parquetMetadataAsync(file, { initialFetchSize: Math.min(FOOTER_FETCH, size) });
      const md5Column = metadata.row_groups[0].columns.findIndex((c) => c.meta_data?.path_in_schema[0] === "md5");
      return { file, metadata, md5Column };
    })();
    file.catch(() => opened.delete(path));
    opened.set(path, file);
  }
  return file;
}

function md5Range({ metadata, md5Column }: OpenFile, rowGroup: number): [string, string] {
  const s = metadata.row_groups[rowGroup].columns[md5Column].meta_data?.statistics;
  return [String(s?.min_value ?? s?.min), String(s?.max_value ?? s?.max)];
}

export async function findMatches(summary: Summary, md5: string, progress: Progress): Promise<Match[]> {
  const shard = summary.annotationFiles.filter(([path]) => path.startsWith(`annotations/part-${md5.slice(0, 2)}-`));
  if (!shard.length) return [];

  // Files of a shard have the same number of rows and MD5s are uniform: start from the
  // file where this MD5 should be, then move to a neighbour if needed.
  let i = Math.min(shard.length - 1, Math.floor((parseInt(md5.slice(2, 6), 16) / 0x10000) * shard.length));
  let target: OpenFile | null = null;
  const seen = new Set<number>();
  while (!seen.has(i)) {
    seen.add(i);
    const [path, size] = shard[i];
    progress(`Reading the index of ${path.split("/").pop()}`);
    const f = await open(summary, path, size);
    const first = md5Range(f, 0)[0], last = md5Range(f, f.metadata.row_groups.length - 1)[1];
    if (md5 < first && i > 0) i--;
    else if (md5 > last && i < shard.length - 1) i++;
    else { target = f; break; }
  }
  if (!target) return [];

  const { file, metadata } = target;
  const matches: Match[] = [];
  let rowStart = 0;
  for (const [g, rg] of metadata.row_groups.entries()) {
    const n = Number(rg.num_rows);
    const [lo, hi] = md5Range(target, g);
    if (lo > md5) break;
    if (hi >= md5) {
      progress(`Reading row group ${g + 1} of ${metadata.row_groups.length}`);
      const rows = await parquetReadObjects({ file, metadata, rowStart, rowEnd: rowStart + n, compressors });
      for (const row of rows) {
        if (row.md5 !== md5) continue;
        const match = row as Match;
        // MobiDB-lite sequence features (e.g. "Proline-rich") describe part of a disordered region: ignored
        if (match.database === "MobiDB-lite") match.locations = match.locations.filter((l) => !l.sequence_feature);
        matches.push(match);
      }
    }
    rowStart += n;
  }
  return matches;
}
