#!/usr/bin/env python

import argparse
import datetime as dt
import io
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Buffer
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPResponse
from typing import Any, cast

import pyarrow.parquet as pq


REPO = "matthiasblum/uniparc-interpro"
REVISION = "main"
TOKEN = os.environ.get("HF_TOKEN")

# {day: (sequences, first UPI)}
Days = dict[str, tuple[int, str]]
# (first UPI, last UPI, sequences)
UpiRange = tuple[str, str, int]
# (path, size in bytes)
RepoFile = tuple[str, int]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


no_redirect = urllib.request.build_opener(NoRedirect)


def request(
    url: str,
    headers: dict[str, str] | None = None,
    opener: urllib.request.OpenerDirector | None = None,
    auth: bool = True,
) -> HTTPResponse | urllib.error.HTTPError:
    """GET with retries on 429, 5xx and network errors."""
    headers = dict(headers or {})
    if auth and TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    for attempt in range(8):
        try:
            res: HTTPResponse = (opener or urllib.request.build_opener()).open(
                urllib.request.Request(url, headers=headers), timeout=60
            )
            return res
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                return e
            if (e.code != 429 and e.code < 500) or attempt == 7:
                raise
            wait = float(e.headers.get("Retry-After") or 2**attempt)
        except (urllib.error.URLError, TimeoutError):
            if attempt == 7:
                raise
            wait = 2**attempt
        time.sleep(min(wait, 60))
    raise AssertionError("unreachable")


def get_json(url: str) -> Any:
    with request(url) as res:
        return json.load(res)


def list_files(repo: str, sha: str, directory: str) -> list[RepoFile]:
    """[(path, size)] of the Parquet files under a directory (the tree API is paginated)."""
    files = []
    url = f"https://huggingface.co/api/datasets/{repo}/tree/{sha}/{directory}"
    while url:
        with request(url) as res:
            files += [
                (f["path"], f["size"])
                for f in json.load(res)
                if f["type"] == "file" and f["path"].endswith(".parquet")
            ]
            url = None
            for part in (res.headers.get("Link") or "").split(","):
                if 'rel="next"' in part:
                    url = part[part.index("<") + 1 : part.index(">")]

    return sorted(files)


class RemoteFile(io.RawIOBase):
    """Read-only file over HTTP range requests, for pyarrow. The Hub redirects each file to a
    signed CDN URL: it is resolved once, and again when it expires."""

    def __init__(self, url: str, size: int) -> None:
        self.url, self.size, self.pos = url, size, 0
        self.cdn: str | None = None

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        self.pos = {io.SEEK_SET: 0, io.SEEK_CUR: self.pos, io.SEEK_END: self.size}[
            whence
        ] + offset
        return self.pos

    def _resolve(self) -> str:
        res = request(self.url, opener=no_redirect)
        location = res.headers.get("Location")
        res.close()
        # Without a redirect (e.g. a small file stored in git), read from the Hub itself
        self.cdn = urllib.parse.urljoin(self.url, location) if location else self.url
        return self.cdn

    def readinto(self, buffer: Buffer) -> int:
        n = min(memoryview(buffer).nbytes, self.size - self.pos)
        if n <= 0:
            return 0
        for attempt in range(3):
            cdn = self.cdn or self._resolve()
            try:
                with request(
                    cdn,
                    {"Range": f"bytes={self.pos}-{self.pos + n - 1}"},
                    auth=cdn == self.url,
                ) as res:
                    data = res.read()
                break
            except urllib.error.HTTPError as e:
                if e.code != 403 or attempt == 2:  # 403: the signed URL expired
                    raise
                self.cdn = None
        memoryview(buffer).cast("B")[: len(data)] = data
        self.pos += len(data)
        return len(data)


def add(days: Days, day: str, n: int, upi: str) -> None:
    """Add `n` sequences to a day, starting at `upi`."""
    count, first = days.get(day, (0, upi))
    days[day] = (count + n, min(first, upi))


def min_max(rg: pq.RowGroupMetaData, column: int) -> tuple[Any, Any]:
    """(min, max) statistics of a column in a row group."""
    stats = rg.column(column).statistics
    if stats is None or not stats.has_min_max:
        raise ValueError(f"no statistics for column {column}")
    return stats.min, stats.max


def summarise_sequences(
    repo: str, sha: str, path: str, size: int, start: dt.date
) -> tuple[Days, UpiRange]:
    """Sequences per day from `start` on, and (first UPI, last UPI, sequences)."""
    url = f"https://huggingface.co/datasets/{repo}/resolve/{sha}/{path}"
    pf = pq.ParquetFile(io.BufferedReader(RemoteFile(url, size), buffer_size=64 * 1024))
    names: list[str] = pf.schema_arrow.names
    created_col, upi_col = names.index("created"), names.index("upi")
    days = {}
    first = None
    last = None

    for i in range(pf.metadata.num_row_groups):
        rg = pf.metadata.row_group(i)
        created_min, created_max = min_max(rg, created_col)
        upi_min, upi_max = min_max(rg, upi_col)
        first = upi_min if first is None else min(first, upi_min)
        last = upi_max if last is None else max(last, upi_max)
        if created_max < start:
            continue
        if created_min == created_max:
            add(days, created_min.isoformat(), rg.num_rows, upi_min)
            continue
        # Several days in this row group: read its dates. UPIs are consecutive within almost
        # all row groups, so the first UPI of a day is derived from its row; otherwise read them.
        dense = int(upi_max[3:], 16) - int(upi_min[3:], 16) + 1 == rg.num_rows
        table = pf.read_row_group(
            i, columns=["created"] if dense else ["created", "upi"]
        )
        dates = cast(list[dt.date], table["created"].to_pylist())
        upi_list = [] if dense else cast(list[str], table["upi"].to_pylist())
        for row, day in enumerate(dates):
            if day >= start:
                upi = (
                    f"UPI{int(upi_min[3:], 16) + row:010X}" if dense else upi_list[row]
                )
                add(days, day.isoformat(), 1, upi)
    assert first is not None and last is not None, f"{path}: no row groups"
    return days, (first, last, pf.metadata.num_rows)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Write a JSON summary of the Hugging Face dataset to stdout."
    )

    parser.add_argument(
        "--start",
        default="2015-01-01",
        type=dt.date.fromisoformat,
        help="first day of the calendar (default: %(default)s)",
    )
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args()

    sha = get_json(f"https://huggingface.co/api/datasets/{REPO}/revision/{REVISION}")[
        "sha"
    ]
    print(f"{REPO}@{REVISION}: {sha}", file=sys.stderr)

    sequences = list_files(REPO, sha, "sequences")
    annotations = list_files(REPO, sha, "annotations")
    print(
        f"{len(sequences)} sequences files, {len(annotations)} annotations files",
        file=sys.stderr,
    )

    size = get_json(
        f"https://datasets-server.huggingface.co/size?dataset={urllib.parse.quote(REPO, safe='')}"
    )
    num_matches = next(
        c["num_rows"] for c in size["size"]["configs"] if c["config"] == "annotations"
    )

    days = {}
    upi_ranges = []
    done = 0
    lock = threading.Lock()

    def task(file: RepoFile) -> tuple[Days, UpiRange]:
        nonlocal done
        result = summarise_sequences(REPO, sha, *file, args.start)
        with lock:
            done += 1
            if done % 50 == 0 or done == len(sequences):
                print(f"sequences: {done}/{len(sequences)}", file=sys.stderr)
        return result

    with ThreadPoolExecutor(args.threads) as pool:
        for file_days, upi_range in pool.map(task, sequences):
            for day, (n, upi) in file_days.items():
                add(days, day, n, upi)
            upi_ranges.append(upi_range)

    print(
        json.dumps(
            {
                "revision": sha,
                "numSequences": sum(r[2] for r in upi_ranges),
                "numMatches": num_matches,
                "calendarStart": args.start.isoformat(),
                "days": [[day, n, upi] for day, (n, upi) in sorted(days.items())],
                "upiRanges": upi_ranges,
                "annotationFiles": annotations,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
