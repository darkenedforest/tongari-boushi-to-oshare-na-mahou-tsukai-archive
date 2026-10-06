#!/usr/bin/env python3
"""Export the bulletin-board post index for the save-file editor.

Writes public/data/board_posts.json from the translation repo's SQLite DB.
The save-file editor uses it to

  * show what each system post on a player's board says in the CURRENT
    translation (so the player can bring an old board up to date),
  * recognise a post whose message number was destroyed by the pre-v2.6.3
    text overflow, by comparing the text left in the save with every text
    that post has ever shipped with (entry_history), and
  * name the author / addressee of a post from the NPC ids in the record.

Only English text ships. No Japanese, no file paths beyond the msg98 file
number that is already part of the post key.

Run from anywhere:
    python scripts/export_board_posts.py
"""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TRANSLATION_REPO = REPO_ROOT.parent / "Tongari boushi translation app claude"
DB_PATH = TRANSLATION_REPO / "extracted" / "scratch" / "db" / "translation.sqlite"
OUT = REPO_ROOT / "public" / "data" / "board_posts.json"

BOARD_PREFIX = "message/msg98/07/"
FAIR_NAMES_FILE = "message/msg99/10/msg99101.ofs"


def main() -> int:
    if not DB_PATH.exists():
        print(f"ERROR: translation DB not found at {DB_PATH}", file=sys.stderr)
        return 1
    con = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True)

    # Fair names: [FAIR_MONTH:n] expands to the first phrase of msg99101
    # entry n-1 (same rule as _board_post_fit.fair_names in the translation
    # repo).
    fairs: dict[str, str] = {}
    for eid, text in con.execute(
        "SELECT entry_id, en_text FROM entries WHERE file_path=? AND sub_entry_id=0",
        (FAIR_NAMES_FILE,),
    ):
        if 0 <= eid < 12 and text:
            fairs[str(eid + 1)] = text.replace("▼", " ").split("§")[0]

    # NPC names by npc_data_ofs_id (0..251). A board record's author id is
    # 1000+n (students, n<140), 2000+n (staff, record 140+n) or 3000+n
    # (guests + creatures, record 173+n); the editor does that arithmetic.
    names: dict[str, str] = {}
    for npc_id, ofs, en in con.execute(
        "SELECT npc_id, npc_data_ofs_id, en_name FROM npc_names "
        "WHERE npc_data_ofs_id IS NOT NULL AND en_name IS NOT NULL"
    ):
        if npc_id == 1000 + ofs:
            names[str(ofs)] = en

    posts: dict[str, dict] = {}
    history_rows = 0
    for fp, eid, en, rowid in con.execute(
        "SELECT file_path, entry_id, en_text, rowid FROM entries "
        "WHERE file_path LIKE ? AND sub_entry_id=0 ORDER BY file_path, entry_id",
        (BOARD_PREFIX + "%",),
    ):
        num = int(fp[-7:-4]) * 100 + eid
        history: list[str] = []
        seen = {en}
        for (old,) in con.execute(
            "SELECT old_value FROM entry_history WHERE entry_rowid=? AND field='en_text' ORDER BY id",
            (rowid,),
        ):
            try:
                old = json.loads(old)
            except Exception:
                pass
            if isinstance(old, str) and old and old not in seen:
                seen.add(old)
                history.append(old)
                history_rows += 1
        posts[str(num)] = {"text": en, "history": history}

    out = {
        "about": (
            "Bulletin-board (msg98070..072) post texts for the save-file editor. "
            "Key = message number (file number * 100 + entry id). `text` is the "
            "current English post: title, then body rows, separated by the "
            "line-break mark; `history` is every earlier English text the post "
            "shipped with. `fairs` expands [FAIR_MONTH:n]; `names` maps "
            "npc_data_ofs_id to the English NPC name."
        ),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_db_mtime": datetime.fromtimestamp(DB_PATH.stat().st_mtime, tz=timezone.utc).isoformat(),
        "marks": {"quote": "§", "line_break": "▼"},
        "fairs": fairs,
        "names": names,
        "posts": posts,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(
        f"wrote {OUT} — {len(posts)} posts, {history_rows} historical texts, "
        f"{len(names)} NPC names, {len(fairs)} fair names, {OUT.stat().st_size:,} bytes"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
