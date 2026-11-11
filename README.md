# UniParc Explorer

A static site to look up UniParc sequences and their InterPro matches.

- **Calendar** of the sequences added to UniParc per day, since 2015. Selecting a day opens the
  first sequence added on that day.
- **Search** by UPI, UniProtKB accession (isoforms included), MD5 or sequence.
- **Sequence neighbourhood**: every single-residue substitution of a sequence (19 × its length)
  is looked up in UniParc. The variants found are shown on a residue × position map. 
  Sequences longer than 2,000 residues are not scanned.

## Configuration

- `src/config.ts`: the releases shown on the page and the Hugging Face dataset it reads from.
- `src/data/summary.json`: a summary of the dataset (revision, files, sequences per day).

### Dataset summary

Generate the summary, then commit it to the repo:

```bash
export HF_TOKEN="******"       # optional
python scripts/summary.py > src/data/summary.json   # requires Python 3.12+ and pyarrow
git add src/data/summary.json
git commit -m "Update the dataset summary"
```

## Build

Requires Node.js 24 or later.

```bash
npm ci
npm run dev          # development server
npm run build        # type-checks, then writes dist/
npm run preview      # serves dist/ on http://localhost:4173/
```
