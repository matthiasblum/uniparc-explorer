// Shape of src/data/summary.json, written by scripts/summary.py.

export interface Summary {
  /** Dataset commit the page reads from */
  revision: string;
  numSequences: number;
  numMatches: number;
  calendarStart: string;
  /** [date, sequences added, first UPI of the day], for days since calendarStart with sequences */
  days: [string, number, string][];
  /** [first UPI, last UPI, sequences] of each sequences file */
  upiRanges: [string, string, number][];
  /** [path, size in bytes] of each annotations file, sorted by path (hence by MD5) */
  annotationFiles: [string, number][];
}
