#!/usr/bin/env python3
"""Upload patch files to the public bucket and print their patches.json entries.

Patch files are not part of the site build (GitHub Pages has a 1 GB limit);
they live in gs://media-library-119506-public/patches/<game>/ and
patches.json / patches_3ds.json point at them by absolute URL.

    python scripts/upload_patches.py --game ds  releases/2.6.5-final/*.xdelta
    python scripts/upload_patches.py --game 3ds path/to/patch.xdelta [--dry-run]

Each file is uploaded with Content-Disposition: attachment so a click
downloads it. An object that already exists with the same SHA-256 is left
alone; one that exists with different content is refused (patch file names
are versioned and never reused).

For every file it prints the fields a downloads[] entry needs: url,
patchSizeBytes, patchSha256. Fill in label / romMd5 yourself.

Auth: a Google access token in GCS_ACCESS_TOKEN, or taken from
`gcloud auth print-access-token`.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BUCKET = "media-library-119506-public"
PUBLIC_BASE = f"https://storage.googleapis.com/{BUCKET}/"


def token() -> str:
    tok = os.environ.get("GCS_ACCESS_TOKEN", "").strip()
    if tok:
        return tok
    exe = shutil.which("gcloud") or shutil.which("gcloud.cmd") or "gcloud"
    return subprocess.run([exe, "auth", "print-access-token"], capture_output=True, text=True,
                          check=True).stdout.strip()


def existing_md5(h: dict, name: str) -> str | None:
    url = f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/{urllib.parse.quote(name, safe='')}?fields=md5Hash"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
            return json.loads(r.read())["md5Hash"]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def upload(h: dict, name: str, data: bytes, filename: str) -> None:
    meta = {
        "name": name,
        "contentType": "application/octet-stream",
        "contentDisposition": f'attachment; filename="{filename}"',
        "cacheControl": "public, max-age=86400",
    }
    boundary = "patchupload7f3a"
    body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(meta)}\r\n"
            f"--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + data + \
        f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o?uploadType=multipart",
        data=body, method="POST",
        headers={**h, "Content-Type": f"multipart/related; boundary={boundary}"})
    urllib.request.urlopen(req, timeout=600).close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", required=True, choices=["ds", "3ds"])
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--dry-run", action="store_true", help="hash and print only; upload nothing")
    args = ap.parse_args()

    h = {} if args.dry_run else {"Authorization": f"Bearer {token()}"}
    out = []
    for f in args.files:
        data = f.read_bytes()
        name = f"patches/{args.game}/{f.name}"
        md5 = base64.b64encode(hashlib.md5(data).digest()).decode()
        status = "dry-run"
        if not args.dry_run:
            have = existing_md5(h, name)
            if have == md5:
                status = "already uploaded"
            elif have is not None:
                print(f"REFUSED {name}: a different file already has this name", file=sys.stderr)
                return 1
            else:
                upload(h, name, data, f.name)
                status = "uploaded"
        print(f"{status}: {name}", file=sys.stderr)
        out.append({
            "url": PUBLIC_BASE + name,
            "patchSizeBytes": len(data),
            "patchSha256": hashlib.sha256(data).hexdigest(),
        })
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
