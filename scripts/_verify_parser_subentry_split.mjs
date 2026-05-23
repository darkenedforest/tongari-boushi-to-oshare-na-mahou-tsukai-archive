// Verification harness for the browser ROM parser's entry → sub-entry
// split (step-264). Loads Tyler's local ROM, runs the parser against
// three multi-sub-entry surfaces, and compares the parser output's
// jp_wire against the local DB's entries.jp_text_for_ai byte-for-byte.
//
// Run from the archive repo root:
//   node --experimental-strip-types scripts/_verify_parser_subentry_split.mjs
//
// Requires:
//   - ROM:  C:/Users/Tyler/Documents/Repos/Tongari boushi translation app claude/ROM/tongari_en.nds
//           (or any of the candidate paths checked below)
//   - DB:   extracted/scratch/db/translation.sqlite in the translation repo
//
// Exits non-zero on any mismatch.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TRANSLATION_REPO = 'C:/Users/Tyler/Documents/Repos/Tongari boushi translation app claude';
// The DB was built from the JAPANESE Rev 1 ROM (see extract_entries.py).
// We deliberately test against THAT ROM so the parser output can be
// compared byte-for-byte against the DB's jp_text_for_ai. Testing against
// tongari_en.nds would compare against the patched-EN text and produce
// false-positive failures.
const ROM_CANDIDATES = [
  `${TRANSLATION_REPO}/ROM/5924 - Tongari Boushi to Oshare na Mahou Tsukai (J) Rev 1.nds`,
  `${TRANSLATION_REPO}/ROM/5924 - Tongari Boushi to Oshare na Mahou Tsukai (J).nds`,
];
const DB_PATH = `${TRANSLATION_REPO}/extracted/scratch/db/translation.sqlite`;

const TARGETS = [
  { path: 'message/msg12/00/msg12001.ofs', entry: 40 },
  { path: 'message/msg20/00/msg20000.ofs', entry: null }, // pick first multi-sub-entry
  { path: 'message/msg52/00/msg52000.ofs', entry: null },
];

function readDbRows() {
  // Use the same python the translation repo uses so we don't introduce a
  // node-sqlite dep here. Output is JSON over stdout.
  const py = `
import sys, sqlite3, json
sys.stdout.reconfigure(encoding='utf-8')
db = sqlite3.connect(r"${DB_PATH}")
c = db.cursor()
targets = json.loads('${JSON.stringify(TARGETS).replace(/'/g, "\\'")}')
out = {}
for t in targets:
    path = t['path']
    if t['entry'] is None:
        # pick first entry on this path with >= 2 sub_entries
        rows = c.execute(
            "SELECT entry_id, COUNT(*) FROM entries WHERE file_path=? "
            "GROUP BY entry_id HAVING COUNT(*) >= 2 ORDER BY entry_id LIMIT 1",
            (path,),
        ).fetchall()
        if not rows:
            out[path + '|MISSING'] = None
            continue
        entry_id = rows[0][0]
    else:
        entry_id = t['entry']
    sub_rows = c.execute(
        "SELECT sub_entry_id, jp_text_for_ai FROM entries "
        "WHERE file_path=? AND entry_id=? ORDER BY sub_entry_id",
        (path, entry_id),
    ).fetchall()
    out[path + '|' + str(entry_id)] = [
        {'sub_entry_id': r[0], 'jp_text_for_ai': r[1]} for r in sub_rows
    ]
print(json.dumps(out, ensure_ascii=False))
`;
  const res = spawnSync('python', ['-c', py], { encoding: 'utf-8' });
  if (res.status !== 0) {
    console.error('DB read failed:', res.stderr);
    process.exit(2);
  }
  return JSON.parse(res.stdout.trim());
}

async function main() {
  const romPath = ROM_CANDIDATES.find(existsSync);
  if (!romPath) {
    console.error('ROM not found in any candidate path:', ROM_CANDIDATES);
    process.exit(2);
  }
  console.log('Using ROM:', romPath);
  const rom = new Uint8Array(readFileSync(romPath));
  console.log('ROM bytes:', rom.length.toLocaleString());

  // esbuild-bundle the parser to a temp .mjs so node can import it as a
  // single file (avoids the ".ts extension required" ESM resolution rule
  // when one TS file imports another by extensionless specifier).
  const tmpOut = resolve('node_modules/.cache/_parser_bundle.mjs');
  const bundleRes = spawnSync(
    process.platform === 'win32' ? 'node_modules\\.bin\\esbuild.cmd' : './node_modules/.bin/esbuild',
    [
      'src/lib/rom/parser.ts',
      '--bundle',
      '--format=esm',
      '--platform=neutral',
      '--target=es2022',
      `--outfile=${tmpOut}`,
    ],
    { encoding: 'utf-8', shell: true },
  );
  if (bundleRes.status !== 0) {
    console.error('esbuild bundle failed:', bundleRes.stderr);
    process.exit(2);
  }
  const parser = await import(pathToFileURL(tmpOut).href);
  const { extractRomFiles } = parser;

  const dbRows = readDbRows();

  // Determine which paths + entry-ids we actually need (the DB-selected
  // ones for the auto-pick targets).
  const expected = [];
  const checks = []; // { path, entry, db_rows }
  for (const [key, rows] of Object.entries(dbRows)) {
    const [path, entryStr] = key.split('|');
    if (entryStr === 'MISSING') {
      console.warn(`  [warn] no multi-sub-entry data found for ${path} — skipping`);
      continue;
    }
    expected.push(path);
    checks.push({ path, entry: Number(entryStr), db_rows: rows });
  }

  const { files } = extractRomFiles(rom, { expected_paths: expected });
  const byPath = new Map(files.map((f) => [f.file_path, f]));

  let failures = 0;
  for (const { path, entry, db_rows } of checks) {
    console.log(`\n=== ${path}, entry ${entry} (${db_rows.length} sub-entries in DB) ===`);
    const f = byPath.get(path);
    if (!f) { console.error(`  [FAIL] parser did not extract ${path}`); failures += 1; continue; }

    // Collect every parser-emitted Textblock for this entry.
    const parserBlocks = [];
    for (const [key, tb] of f.textblocks) {
      if (tb.entry_id === entry) parserBlocks.push(tb);
    }
    parserBlocks.sort((a, b) => a.sub_entry_id - b.sub_entry_id);

    if (parserBlocks.length !== db_rows.length) {
      console.error(
        `  [FAIL] sub-entry count mismatch — parser ${parserBlocks.length} vs DB ${db_rows.length}`,
      );
      console.error('    parser keys:', parserBlocks.map((b) => `${b.entry_id}.${b.sub_entry_id}`));
      failures += 1;
    }

    const n = Math.max(parserBlocks.length, db_rows.length);
    for (let i = 0; i < n; i++) {
      const pb = parserBlocks[i];
      const dbr = db_rows[i];
      if (!pb) { console.error(`  [FAIL] missing parser block #${i}`); failures += 1; continue; }
      if (!dbr) { console.error(`  [FAIL] extra parser block #${i}: ${pb.jp_wire}`); failures += 1; continue; }
      const match = pb.jp_wire === dbr.jp_text_for_ai;
      console.log(`  ${match ? '[OK]' : '[FAIL]'} sub_entry ${pb.sub_entry_id}: ${pb.jp_wire.slice(0, 60)}${pb.jp_wire.length > 60 ? '…' : ''}`);
      if (!match) {
        failures += 1;
        console.error(`    parser : ${JSON.stringify(pb.jp_wire)}`);
        console.error(`    db     : ${JSON.stringify(dbr.jp_text_for_ai)}`);
      }
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} mismatch(es) — parser is not yet byte-identical to the DB.`);
    process.exit(1);
  }
  console.log('\nAll sub-entry rows match the DB byte-for-byte. ✔');
}

main().catch((err) => { console.error(err); process.exit(2); });
