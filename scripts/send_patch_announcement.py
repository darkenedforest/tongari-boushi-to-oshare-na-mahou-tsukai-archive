#!/usr/bin/env python3
"""Send a patch-release announcement email to everyone on the subscriber list.

The list lives in the site backend's `patch_subscribers` table (media-api on
Cloud Run, see BACKEND.md). The table is an append-only log of
{email, action} rows written by the subscribe card on the site; the API
replays the log (latest action per email wins) to give the active subscriber
set, and this script sends one announcement per BCC batch through Gmail SMTP.

Subcommands:
  list [--game ds|3ds]       Show the active subscriber set (and totals), or one patch's.
  send [options]             Send the announcement for a release.
  unsubscribe EMAIL          Append an unsubscribe row for EMAIL (e.g. when
                             someone replies "unsubscribe" to an email).

`send` options:
  --game ds|3ds              Which game's release to announce: ds reads
                             public/data/patches.json, 3ds reads
                             public/data/patches_3ds.json. Default: ds.
                             It goes only to the people subscribed to that
                             game's patch (sign-ups from before the choice
                             existed are on both lists).
  --version 2.6              Which release of that game to announce.
                             Default: the newest one.
  --dry-run                  Print recipients + the rendered email, send
                             nothing.
  --test-to you@example.com  Send only to this one address (ignores the
                             subscriber list). Good for previewing.
  --yes                      Skip the interactive "send to these N?"
                             confirmation (for scripted runs).

Credentials:
  The subscriber list is read with the backend's admin token, which
  _media_api.py (translation repo) fetches from Secret Manager with gcloud
  — so `gcloud` must be signed in to an account with access to
  media-library-119506. Override with MEDIA_API_ADMIN_TOKEN.

  GMAIL_ADDRESS / GMAIL_APP_PASSWORD come from Windows Credential Manager
  (service "tongari-boushi-notifier"), or from env vars / a gitignored
  `.env.announce` in the repo root. A Gmail "app password", not the account
  password. `list` and `unsubscribe` don't need them.
"""

from __future__ import annotations

import argparse
import json
import os
import getpass
import smtplib
import sys
import time
import urllib.request
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# The site-backend client (_media_api.py) lives in the translation repo.
TRANSLATION_REPO = REPO_ROOT.parent / "Tongari boushi translation app claude"
PATCHES_JSON = {
    "ds": REPO_ROOT / "public" / "data" / "patches.json",
    "3ds": REPO_ROOT / "public" / "data" / "patches_3ds.json",
}
GAME_TITLE = {
    "ds": "Tongari Boushi to Oshare na Mahou Tsukai (DS)",
    "3ds": "Tongari Boushi to Mahou no Machi (3DS)",
}

SITE_URL = (
    "https://darkenedforest.github.io/tongari-boushi-to-oshare-na-mahou-tsukai-archive"
)

BCC_BATCH_SIZE = 80          # stay well under Gmail's per-message cap
BATCH_PAUSE_SECONDS = 5      # small pause between batches


def load_env_file() -> None:
    """Populate os.environ from the .env files that already exist, so the
    ONLY thing a sender must supply is their Gmail login.

    Sources, in order (first value for a name wins; real environment
    variables always win over files): .env.announce, then .env, both in
    the archive repo root.
    """
    candidates = [
        REPO_ROOT / ".env.announce",
        REPO_ROOT / ".env",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            name, value = name.strip(), value.strip().strip('"').strip("'")
            if name and name not in os.environ:
                os.environ[name] = value
    # Gmail credentials live in the OS keychain (Windows Credential
    # Manager via keyring), stored under this service. Pull them in if
    # they were not supplied by env/.env, so a sender never types them.
    try:
        import keyring
        for name in ("GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"):
            if not os.environ.get(name):
                v = keyring.get_password("tongari-boushi-notifier", name)
                if v:
                    os.environ[name] = v
    except Exception:
        pass  # keyring absent/locked -> fall through to prompting
    # Gmail app passwords are shown in 4 space-separated groups; SMTP
    # only accepts them with the spaces removed.
    if os.environ.get("GMAIL_APP_PASSWORD"):
        os.environ["GMAIL_APP_PASSWORD"] = os.environ["GMAIL_APP_PASSWORD"].replace(" ", "")


def env_or_die(*names: str) -> dict[str, str]:
    """Return the requested credentials. Prefer environment variables
    (and .env.announce loaded at startup); PROMPT interactively for
    anything still missing rather than requiring a secret on disk. The
    Gmail app password is read with getpass so it never echoes or lands
    in shell history. Prompting needs a real TTY; if stdin is not
    interactive we fail with a clear message instead of hanging."""
    values = {}
    missing = []
    for name in names:
        v = os.environ.get(name, "").strip()
        if v:
            values[name] = v
        else:
            missing.append(name)
    if not missing:
        return values
    if not sys.stdin.isatty():
        sys.exit(
            "Missing credential(s): " + ", ".join(missing)
            + "\nSet them as environment variables or run this in an "
            "interactive terminal to be prompted."
        )
    for name in missing:
        if any(s in name for s in ("PASSWORD", "TOKEN", "KEY")):
            values[name] = getpass.getpass(f"{name}: ").strip()
        else:
            values[name] = input(f"{name}: ").strip()
        if not values[name]:
            sys.exit(f"No value entered for {name}; aborting.")
    return values


def _admin():
    sys.path.insert(0, str(TRANSLATION_REPO / "src"))
    from translator._media_api import Admin  # shared client: base URL + admin token via gcloud
    return Admin()


def fetch_active_subscribers(game: str | None = None) -> tuple[list[str], int]:
    """Active subscribers from the site backend (the append-only log is
    replayed server-side; latest action per email wins). People choose the
    DS patch, the 3DS patch or both: with `game`, only that patch's list
    (older sign-ups count for both). Returns (active_emails, total_log_rows)."""
    data = _admin().get("/api/admin/subscribers" + (f"?game={game}" if game else ""))
    active = []
    for email in data["active"]:
        try:
            # smtplib sends SMTP commands as ASCII; one internationalized
            # address would crash the whole send, so drop it with a warning.
            email.encode("ascii")
        except UnicodeEncodeError:
            print(f"WARNING: skipping non-ASCII address {email!r} "
                  "(SMTP without SMTPUTF8 can't deliver to it)")
            continue
        active.append(email)
    return active, data["total_rows"]


def load_release(version: str | None, game: str = "ds") -> dict:
    path = PATCHES_JSON[game]
    data = json.loads(path.read_text(encoding="utf-8"))
    releases = data["releases"]
    if not releases:
        sys.exit(f"{path.name} has no releases yet.")
    if version is None:
        return {**releases[0], "game": game}
    want = version.lstrip("vV")
    for r in releases:
        if r["version"] == want:
            return {**r, "game": game}
    sys.exit(
        f"Version {version!r} not found in {path.name}. "
        f"Known: {', '.join('v' + r['version'] for r in releases)}"
    )


def build_email(release: dict) -> tuple[str, str, str]:
    """Returns (subject, text_body, html_body)."""
    v = release["version"]
    game = release.get("game", "ds")
    platform = "3DS" if game == "3ds" else "DS"
    patch_name = "English patch" if game == "ds" else "multi-language patch"
    subject = f"Tongari Boushi {platform} {patch_name} v{v} is out ✦"
    patches_url = f"{SITE_URL}/patches/" + ("#3ds" if game == "3ds" else "")
    changelog_url = (
        f"{SITE_URL}{release['changelogUrl']}" if release.get("changelogUrl") else None
    )
    unsub_url = f"{SITE_URL}/patches/#subscribe"

    # A release may carry one `callout`: the thing every player needs to
    # act on (v2.6.3: repair / update the bulletin board in your save).
    # It goes right after the summary, before the change list, in both
    # the text and HTML bodies.
    callout = release.get("callout") or None
    callout_url = (
        f"{SITE_URL}{callout['href']}" if callout and callout.get("href") else None
    )

    lines = [
        f"Version {v} of the {'English' if game == 'ds' else 'multi-language'} fan-translation patch for",
        f"{GAME_TITLE[game]} just shipped.",
        "",
        release.get("headline", ""),
        "",
        release.get("summary", ""),
    ]
    if callout:
        lines += [
            "",
            f"*** {callout.get('title', '').upper()} ***",
            callout.get("body", ""),
        ]
        if callout_url:
            lines += [f"  {callout.get('label', 'More')}: {callout_url}"]
    lines += [
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
        "Tongari Boushi archive site. To unsubscribe, open",
        f"{unsub_url} — the signup pop-up opens with an \"Unsubscribe here\"",
        "link — or just reply to this email with \"unsubscribe\".",
    ]
    text = "\n".join(lines)

    def esc(s: str) -> str:
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    changes_html = "".join(f"<li>{esc(c)}</li>" for c in release.get("changes", []))
    changelog_html = (
        f'<p><a href="{changelog_url}">Full row-by-row changelog &rarr;</a></p>'
        if changelog_url else ""
    )
    callout_html = ""
    if callout:
        link = (
            f'<p style="margin: 10px 0 0;"><a href="{callout_url}" style="color: #9b7bd9; font-weight: bold;">'
            f'{esc(callout.get("label", "More"))} &rarr;</a></p>'
            if callout_url else ""
        )
        callout_html = (
            '<div style="margin: 18px 0; padding: 14px 18px; background: #fff7d6; '
            'border: 2px solid #f3d774; border-left: 6px solid #d99e1f; border-radius: 8px;">'
            f'<p style="margin: 0 0 6px; font-weight: bold; color: #8a5a00;">&#10022; {esc(callout.get("title", ""))}</p>'
            f'<p style="margin: 0;">{esc(callout.get("body", ""))}</p>{link}</div>'
        )
    html = f"""\
<html><body style="font-family: sans-serif; color: #3a2c4e; line-height: 1.55;">
<h2 style="color: #9b7bd9;">{platform} {patch_name} v{esc(v)} is out &#10022;</h2>
<p style="margin-top: -8px; color: #8a7a9e;">{esc(GAME_TITLE[game])}</p>
<p><strong>{esc(release.get('headline', ''))}</strong></p>
<p>{esc(release.get('summary', ''))}</p>
{callout_html}
<p><strong>What changed:</strong></p>
<ul>{changes_html}</ul>
<p><a href="{patches_url}">Patch your ROM in the browser, or grab the .xdelta files &rarr;</a></p>
{changelog_html}
<hr style="border: none; border-top: 1px solid #e8d9f5; margin: 24px 0;">
<p style="font-size: 0.85em; color: #8a7a9e;">
You're getting this because you subscribed to patch updates on the
Tongari Boushi archive site. <a href="{unsub_url}">Unsubscribe here</a>
(the signup pop-up opens with an "Unsubscribe here" link), or reply to
this email with "unsubscribe".
</p>
</body></html>
"""
    return subject, text, html


def cmd_list(args: argparse.Namespace) -> None:
    active, total_rows = fetch_active_subscribers(args.game)
    for e in active:
        print(e)
    print(f"\n{len(active)} active subscriber(s) ({total_rows} log rows).")


def cmd_unsubscribe(args: argparse.Namespace) -> None:
    email = args.email.strip().lower()
    _admin().post("/api/admin/subscribers", {"email": email, "action": "unsubscribe"})
    print(f"Unsubscribed {email}.")


def cmd_send(args: argparse.Namespace) -> None:
    release = load_release(args.version, args.game)
    subject, text, html = build_email(release)

    if args.test_to:
        recipients = [args.test_to.strip().lower()]
        print(f"TEST MODE: sending only to {recipients[0]}")
    else:
        recipients, total_rows = fetch_active_subscribers(args.game)
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

    p_list = sub.add_parser("list", help="show active subscribers")
    p_list.add_argument("--game", choices=["ds", "3ds"], help="only this patch's list (default: everyone)")

    p_unsub = sub.add_parser("unsubscribe", help="append an unsubscribe row")
    p_unsub.add_argument("email")

    p_send = sub.add_parser("send", help="send the announcement")
    p_send.add_argument("--game", choices=["ds", "3ds"], default="ds",
                        help="which game's release to announce (default: ds)")
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
