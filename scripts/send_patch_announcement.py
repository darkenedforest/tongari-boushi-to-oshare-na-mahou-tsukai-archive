#!/usr/bin/env python3
"""Send a patch-release announcement email to everyone on the subscriber list.

The list lives in the Supabase `patch_subscribers` table (see
SUPABASE_SETUP.md, "Patch release email subscriptions"). The table is an
append-only log of {email, action} rows written by the subscribe card on the
site; this script replays the log (latest action per email wins) to get the
active subscriber set, then sends one announcement per BCC batch through
Gmail SMTP.

Subcommands:
  list                       Show the active subscriber set (and totals).
  send [options]             Send the announcement for a release.
  unsubscribe EMAIL          Append an unsubscribe row for EMAIL (e.g. when
                             someone replies "unsubscribe" to an email).

`send` options:
  --version 2.6              Which release from public/data/patches.json to
                             announce. Default: the newest one.
  --dry-run                  Print recipients + the rendered email, send
                             nothing.
  --test-to you@example.com  Send only to this one address (ignores the
                             subscriber list). Good for previewing.
  --yes                      Skip the interactive "send to these N?"
                             confirmation (for scripted runs).

Credentials — put them in a `.env.announce` file in the repo root
(gitignored; KEY=value lines, # comments allowed), or set them as
environment variables (env vars win). Do NOT type the secrets at the
shell prompt — PowerShell persists every typed line to its history file.

  PUBLIC_SUPABASE_URL     https://<project-ref>.supabase.co
  SUPABASE_SERVICE_KEY    service-role key (Supabase dashboard -> Project
                          Settings -> API Keys -> service_role). Needed
                          because the table is not readable via the anon key.
  GMAIL_ADDRESS           the Gmail address to send from
  GMAIL_APP_PASSWORD      a Google "app password" for that account
                          (myaccount.google.com -> Security -> 2-Step
                          Verification -> App passwords). NOT the normal
                          account password.

`list` and `unsubscribe` need only the first two.
"""

from __future__ import annotations

import argparse
import json
import os
import smtplib
import sys
import time
import urllib.request
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PATCHES_JSON = REPO_ROOT / "public" / "data" / "patches.json"

SITE_URL = (
    "https://darkenedforest.github.io/tongari-boushi-to-oshare-na-mahou-tsukai-archive"
)

BCC_BATCH_SIZE = 80          # stay well under Gmail's per-message cap
BATCH_PAUSE_SECONDS = 5      # small pause between batches
PAGE_SIZE = 1000             # Supabase REST default max rows per request


def load_env_file() -> None:
    """Merge .env.announce (repo root, gitignored) into os.environ.

    Real environment variables win over the file, so a one-off override
    still works without editing it.
    """
    path = REPO_ROOT / ".env.announce"
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name, value = name.strip(), value.strip().strip('"').strip("'")
        if name and name not in os.environ:
            os.environ[name] = value


def env_or_die(*names: str) -> dict[str, str]:
    values = {}
    missing = []
    for name in names:
        v = os.environ.get(name, "").strip()
        if v:
            values[name] = v
        else:
            missing.append(name)
    if missing:
        sys.exit(
            "Missing environment variable(s): "
            + ", ".join(missing)
            + "\nSee the docstring at the top of this script."
        )
    return values


def supabase_request(url: str, key: str, path: str, *, method: str = "GET",
                     body: dict | None = None, headers: dict | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(
        f"{url.rstrip('/')}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
    )
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def fetch_active_subscribers(url: str, key: str) -> tuple[list[str], int]:
    """Replay the append-only log. Returns (active_emails, total_rows).

    Ordered by id only: id is `generated always as identity`, so clients
    cannot forge it — unlike created_at, which the open INSERT policy
    would let an attacker backdate/future-date to override real actions.
    """
    rows: list[dict] = []
    offset = 0
    while True:
        status, data = supabase_request(
            url, key,
            "/rest/v1/patch_subscribers?select=id,email,action&order=id.asc",
            headers={"Range-Unit": "items", "Range": f"{offset}-{offset + PAGE_SIZE - 1}"},
        )
        if status not in (200, 206):
            sys.exit(f"Supabase fetch failed ({status}): {data.decode(errors='replace')[:500]}")
        page = json.loads(data)
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    latest: dict[str, str] = {}
    for row in rows:
        email = (row.get("email") or "").strip().lower()
        if email:
            latest[email] = row.get("action") or "subscribe"

    active = []
    for email in sorted(e for e, a in latest.items() if a == "subscribe"):
        try:
            # smtplib sends SMTP commands as ASCII; one internationalized
            # address would crash the whole send, so drop it with a warning.
            email.encode("ascii")
        except UnicodeEncodeError:
            print(f"WARNING: skipping non-ASCII address {email!r} "
                  "(SMTP without SMTPUTF8 can't deliver to it)")
            continue
        active.append(email)
    return active, len(rows)


def load_release(version: str | None) -> dict:
    data = json.loads(PATCHES_JSON.read_text(encoding="utf-8"))
    releases = data["releases"]
    if version is None:
        return releases[0]
    want = version.lstrip("vV")
    for r in releases:
        if r["version"] == want:
            return r
    sys.exit(
        f"Version {version!r} not found in patches.json. "
        f"Known: {', '.join('v' + r['version'] for r in releases)}"
    )


def build_email(release: dict) -> tuple[str, str, str]:
    """Returns (subject, text_body, html_body)."""
    v = release["version"]
    subject = f"Tongari Boushi English patch v{v} is out ✦"
    patches_url = f"{SITE_URL}/patches/"
    changelog_url = (
        f"{SITE_URL}{release['changelogUrl']}" if release.get("changelogUrl") else None
    )
    unsub_url = f"{SITE_URL}/patches/#subscribe"

    lines = [
        f"Version {v} of the English fan-translation patch for Tongari Boushi",
        "to Oshare na Mahou Tsukai just shipped.",
        "",
        release.get("headline", ""),
        "",
        release.get("summary", ""),
        "",
        "What changed:",
    ]
    for c in release.get("changes", []):
        lines.append(f"  * {c}")
    lines += [
        "",
        f"Patch your ROM in the browser, or download the .xdelta files:",
        f"  {patches_url}",
    ]
    if changelog_url:
        lines += ["", "Full row-by-row changelog:", f"  {changelog_url}"]
    lines += [
        "",
        "-- ",
        "You're getting this because you subscribed to patch updates on the",
        "Tongari Boushi archive site. To unsubscribe, use the form at",
        f"{unsub_url} (there's an \"Unsubscribe here\" link under the email",
        "box), or just reply to this email with \"unsubscribe\".",
    ]
    text = "\n".join(lines)

    def esc(s: str) -> str:
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    changes_html = "".join(f"<li>{esc(c)}</li>" for c in release.get("changes", []))
    changelog_html = (
        f'<p><a href="{changelog_url}">Full row-by-row changelog &rarr;</a></p>'
        if changelog_url else ""
    )
    html = f"""\
<html><body style="font-family: sans-serif; color: #3a2c4e; line-height: 1.55;">
<h2 style="color: #9b7bd9;">English patch v{esc(v)} is out &#10022;</h2>
<p><strong>{esc(release.get('headline', ''))}</strong></p>
<p>{esc(release.get('summary', ''))}</p>
<p><strong>What changed:</strong></p>
<ul>{changes_html}</ul>
<p><a href="{patches_url}">Patch your ROM in the browser, or grab the .xdelta files &rarr;</a></p>
{changelog_html}
<hr style="border: none; border-top: 1px solid #e8d9f5; margin: 24px 0;">
<p style="font-size: 0.85em; color: #8a7a9e;">
You're getting this because you subscribed to patch updates on the
Tongari Boushi archive site. <a href="{unsub_url}">Unsubscribe here</a>
(use the "Unsubscribe" link under the email box), or reply to this
email with "unsubscribe".
</p>
</body></html>
"""
    return subject, text, html


def cmd_list(args: argparse.Namespace) -> None:
    env = env_or_die("PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_KEY")
    active, total_rows = fetch_active_subscribers(
        env["PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"]
    )
    for e in active:
        print(e)
    print(f"\n{len(active)} active subscriber(s) ({total_rows} log rows).")


def cmd_unsubscribe(args: argparse.Namespace) -> None:
    env = env_or_die("PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_KEY")
    email = args.email.strip().lower()
    status, data = supabase_request(
        env["PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"],
        "/rest/v1/patch_subscribers",
        method="POST",
        body={"email": email, "action": "unsubscribe"},
        headers={"Prefer": "return=minimal"},
    )
    if status not in (200, 201, 204):
        sys.exit(f"Insert failed ({status}): {data.decode(errors='replace')[:500]}")
    print(f"Unsubscribed {email}.")


def cmd_send(args: argparse.Namespace) -> None:
    release = load_release(args.version)
    subject, text, html = build_email(release)

    if args.test_to:
        recipients = [args.test_to.strip().lower()]
        print(f"TEST MODE: sending only to {recipients[0]}")
    else:
        env = env_or_die("PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_KEY")
        recipients, total_rows = fetch_active_subscribers(
            env["PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"]
        )
        print(f"{len(recipients)} active subscriber(s) ({total_rows} log rows).")

    if not recipients:
        print("Nobody to send to. Done.")
        return

    print(f"\nSubject: {subject}\n")
    print(text)
    print()

    if args.dry_run:
        print("DRY RUN — would send to:")
        for r in recipients:
            print(f"  {r}")
        print(f"\n{len(recipients)} recipient(s), "
              f"{(len(recipients) + BCC_BATCH_SIZE - 1) // BCC_BATCH_SIZE} batch(es). "
              "Nothing sent.")
        return

    if not args.test_to and not args.yes:
        # Force a look at the actual list before anything goes out: the
        # table takes unauthenticated inserts, so a burst of addresses you
        # never announced to before is a red flag (someone bulk-injecting
        # third-party emails), and this is the last place to catch it.
        print("Recipients:")
        for r in recipients:
            print(f"  {r}")
        answer = input(f"\nSend to these {len(recipients)} recipient(s)? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Aborted. Nothing sent.")
            return

    gmail = env_or_die("GMAIL_ADDRESS", "GMAIL_APP_PASSWORD")
    sender = gmail["GMAIL_ADDRESS"]

    batches = [
        recipients[i:i + BCC_BATCH_SIZE]
        for i in range(0, len(recipients), BCC_BATCH_SIZE)
    ]
    print(f"Sending {len(batches)} batch(es) of up to {BCC_BATCH_SIZE}...")

    failed: list[str] = []
    refused: list[str] = []
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(sender, gmail["GMAIL_APP_PASSWORD"])
        for i, batch in enumerate(batches, 1):
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = f"Tongari Boushi Archive <{sender}>"
            # Recipients ride in the SMTP envelope only (true BCC) — no
            # To/Bcc header, so subscribers never see each other's address.
            msg.attach(MIMEText(text, "plain", "utf-8"))
            msg.attach(MIMEText(html, "html", "utf-8"))
            try:
                # sendmail returns {addr: (code, reason)} for recipients the
                # server refused while accepting the rest of the batch.
                result = smtp.sendmail(sender, batch, msg.as_string())
            except (smtplib.SMTPException, OSError) as e:
                failed.extend(batch)
                print(f"  batch {i}/{len(batches)} FAILED ({len(batch)} recipient(s)): {e}")
            else:
                refused.extend(result.keys())
                ok = len(batch) - len(result)
                print(f"  batch {i}/{len(batches)} sent ({ok} recipient(s)"
                      + (f", {len(result)} refused" if result else "") + ")")
            if i < len(batches):
                time.sleep(BATCH_PAUSE_SECONDS)

    if failed or refused:
        print("\nNOT delivered — resend to just these with --test-to, one at a time:")
        for addr in failed + refused:
            print(f"  {addr}")
        sys.exit(1)
    print("Done.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="show active subscribers")

    p_unsub = sub.add_parser("unsubscribe", help="append an unsubscribe row")
    p_unsub.add_argument("email")

    p_send = sub.add_parser("send", help="send the announcement")
    p_send.add_argument("--version", help="release to announce, e.g. 2.6 (default: newest)")
    p_send.add_argument("--dry-run", action="store_true", help="print, send nothing")
    p_send.add_argument("--test-to", help="send only to this address")
    p_send.add_argument("--yes", action="store_true",
                        help="skip the send confirmation prompt")

    # Windows consoles/pipes default to the ANSI code page (cp1252), which
    # can't encode the ✦ in the subject line — force UTF-8 output.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    load_env_file()
    args = parser.parse_args()
    {"list": cmd_list, "unsubscribe": cmd_unsubscribe, "send": cmd_send}[args.command](args)


if __name__ == "__main__":
    main()
