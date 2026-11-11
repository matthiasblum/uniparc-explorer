/** Track order: case-insensitive alphabetical. */
export const compareDatabases = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

// Colours of the member databases on one sequence: ColorBrewer's qualitative Set1 (without
// its yellow and grey) then Dark2 (without its grey), given to the databases in track order.
// In this order, neighbouring tracks stay distinct, including for protan and deutan colour
// vision; every track is also labelled. 14 colours cover 99.8% of sequences; the rare
// sequences with more databases continue with ColorBrewer Paired.
const MATCH_COLOURS = [
  "#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00", "#a65628", "#f781bf",   // Set1
  "#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e", "#e6ab02", "#a6761d",   // Dark2
  "#1f78b4", "#33a02c", "#6a3d9a", "#b15928", "#fb9a99", "#cab2d6", "#fdbf6f",   // Paired
];

/** Colour of each database of a sequence, in track order. */
export function databaseColours(databases: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(databases)].sort(compareDatabases);
  return new Map(sorted.map((db, i) => [db, MATCH_COLOURS[i % MATCH_COLOURS.length]]));
}

// Calendar: ColorBrewer YlGnBu (sequential), one class per decade of sequences per day.
export const DAY_CLASSES = [1e3, 1e4, 1e5, 1e6];           // upper bounds; the last class is >= 1e6
export function dayClass(n: number): number {
  if (n <= 0) return 0;
  const i = DAY_CLASSES.findIndex((b) => n < b);
  return i < 0 ? DAY_CLASSES.length + 1 : i + 1;
}
