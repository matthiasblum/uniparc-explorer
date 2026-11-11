// Access to the files of a Hugging Face dataset.

export function fileUrl(repo: string, revision: string, path: string): string {
  return `https://huggingface.co/datasets/${repo}/resolve/${encodeURIComponent(revision)}/${path}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The Hub answers each file request with a redirect to its CDN. Remember where each file
// went, so that later range requests go straight to the CDN: faster, and they do not count
// against the Hub's rate limit.
const cdnUrls = new Map<string, string>();

/** fetch() for dataset files: follows CDN redirects once per file, retries 429 and 5xx. */
export async function hfFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  for (let attempt = 0; ; attempt++) {
    const target = cdnUrls.get(url) ?? url;
    const headers = new Headers(init?.headers);
    if (target !== url) headers.delete("authorization");   // the CDN URL is signed
    let res: Response;
    try {
      res = await fetch(target, { ...init, headers });
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      if (res.redirected) cdnUrls.set(url, res.url);
      return res;
    }
    if (target !== url) {
      // Signed CDN URLs expire: go through the Hub again
      cdnUrls.delete(url);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
      await sleep(Math.min(wait, 60_000));
      continue;
    }
    return res;
  }
}
