// Sequence lookups in UniParc, through the UniProt REST API.
import SparkMD5 from "spark-md5";

const API = "https://rest.uniprot.org/uniparc/search";

export interface Sequence {
  upi: string;
  sequence: string;
  length: number;
  md5: string;
  crc64: string;
}

export const md5 = (sequence: string) => SparkMD5.hash(sequence).toUpperCase();

export type Query =
  | { type: "upi" | "md5" | "accession" | "sequence"; value: string }
  | { type: "invalid"; value: string };

// UniProtKB accession (https://www.uniprot.org/help/accession_numbers), with an optional isoform number
const ACCESSION = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2})(-[0-9]+)?$/i;

/** What the user typed: a UPI, an MD5, a UniProtKB accession, or a sequence
 *  (FASTA headers, spaces and digits are ignored). */
export function classify(input: string): Query | null {
  const s = input.trim();
  if (!s) return null;
  if (/^UPI[0-9A-F]{10}$/i.test(s)) return { type: "upi", value: s.toUpperCase() };
  if (/^[0-9A-F]{32}$/i.test(s)) return { type: "md5", value: s.toUpperCase() };
  if (ACCESSION.test(s)) return { type: "accession", value: s.toUpperCase() };
  const seq = s.split(/\r?\n/).filter((l) => !l.startsWith(">")).join("").replace(/[\s\d*.-]/g, "").toUpperCase();
  if (!seq) return null;
  return /^[A-Z]+$/.test(seq) ? { type: "sequence", value: seq } : { type: "invalid", value: s };
}

/** UniParc query for the current sequence of a UniProtKB accession or isoform (e.g. P04637-2). */
export const accessionQuery = (accession: string) =>
  accession.includes("-") ? `isoform:${accession}` : `uniprotkb:${accession}`;

/** Look up one sequence by `upi:...`, `checksum:...`, `uniprotkb:...` or `isoform:...`; null if UniParc has none. */
export async function lookup(query: string, signal?: AbortSignal): Promise<Sequence | null> {
  const url = `${API}?query=${encodeURIComponent(query)}&fields=upi,sequence,checksum,length&size=1`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`UniProt API: HTTP ${res.status}`);
  const hit = (await res.json()).results?.[0];
  if (!hit) return null;
  const sequence: string = hit.sequence.value;
  return {
    upi: hit.uniParcId,
    sequence,
    length: hit.sequence.length ?? sequence.length,
    md5: md5(sequence),
    crc64: hit.sequence.crc64,
  };
}

/** Which of these checksums (at most 100, the API's limit) are UniParc sequences. */
export async function findChecksums(checksums: string[], signal?: AbortSignal): Promise<{ upi: string; md5: string }[]> {
  const query = checksums.map((c) => `checksum:${c}`).join(" OR ");
  const url = `${API}?query=${encodeURIComponent(query)}&fields=upi,sequence&size=${checksums.length}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal });
    if (res.ok) {
      const hits: any[] = (await res.json()).results ?? [];
      return hits.map((h) => ({ upi: h.uniParcId, md5: md5(h.sequence.value) }));
    }
    if ((res.status !== 429 && res.status < 500) || attempt === 4) throw new Error(`UniProt API: HTTP ${res.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}
