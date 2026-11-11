export const config = {
  /** Hugging Face dataset the page reads from (also in scripts/summary.py) */
  hfRepo: "matthiasblum/uniparc-interpro",
  uniprotRelease: "2026_04",
  interproRelease: "111.0",
};

export type Config = typeof config;
