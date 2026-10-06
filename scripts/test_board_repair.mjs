// Bulletin-board repair test (step-408).
//
// Loads a save whose board was damaged by a pre-v2.6.3 patch, classifies
// every post with src/lib/savefile/board.ts, stages every recommended fix,
// applies it through the editor, re-parses, and checks that all three
// checksum levels pass and that the board now reads back clean. When the
// translation repo's reference tool (_board_save_repair.py) output is
// given as a third argument, the resulting board blocks of both slots are
// compared byte for byte.
//
//   ./node_modules/.bin/esbuild --bundle --platform=node --format=esm \
//     --outfile=tmp/board-bundle.mjs scripts/test_board_repair.mjs \
//     && node tmp/board-bundle.mjs <save> [<board_posts.json>] [<reference-output.sav>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as parser from '../src/lib/savefile/parser.ts';
import * as editor from '../src/lib/savefile/editor.ts';
import * as board from '../src/lib/savefile/board.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const savePath = process.argv[2];
const indexPath = process.argv[3] ?? path.join(REPO_ROOT, 'public', 'data', 'board_posts.json');
const referencePath = process.argv[4];
if (!savePath) {
  console.error('usage: node tmp/board-bundle.mjs <save> [<board_posts.json>] [<reference-output.sav>]');
  process.exit(2);
}

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

const file = new Uint8Array(fs.readFileSync(savePath));
const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
console.log(`save: ${savePath} (${file.length} bytes); index: ${Object.keys(index.posts).length} posts`);

const before = await parser.parseSaveFile(file);
const active = before.activeSlot;
console.log(`active slot: ${active} (${before.activeSlotReason})`);

for (const label of ['A', 'B']) {
  const slot = label === 'A' ? before.slotA : before.slotB;
  if (slot.uninitialised) {
    console.log(`slot ${label}: uninitialised`);
    continue;
  }
  const assessments = board.assessBoard(slot.boardRecords, index, slot.playerName);
  console.log(`\n--- slot ${label} board (player ${JSON.stringify(slot.playerName)}) ---`);
  slot.boardRecords.forEach((r, i) => {
    if (r.empty) return;
    const a = assessments[i];
    console.log(
      `#${String(i + 1).padStart(2)} ${a.status.padEnd(13)} ${a.recommendation.padEnd(6)} ` +
        `msg=${String(r.msg).padEnd(5)} a0=${r.authorId.toString(16).padStart(4, '0')} units=${String(r.textUnits).padEnd(2)} ` +
        `${board.formatBoardDate(r).padEnd(5)} ${JSON.stringify(r.text.slice(0, 40))}`,
    );
    console.log(`     ${a.detail}`);
    if (a.fix) console.log(`     fix: ${JSON.stringify({ ...a.fix, text: a.fix.text ? a.fix.text.slice(0, 30) + '…' : undefined })}`);
  });
}

// Stage every recommended fix on the active slot and apply.
const activeSlot = active === 'A' ? before.slotA : before.slotB;
const assessments = board.assessBoard(activeSlot.boardRecords, index, activeSlot.playerName);
const actions = {};
assessments.forEach((a, i) => {
  if (a.recommendation === 'remove') actions[i] = { kind: 'remove' };
  else if (a.recommendation === 'update') actions[i] = { kind: 'update' };
});
console.log(`\nstaging ${Object.keys(actions).length} actions: ${JSON.stringify(actions)}`);

const records = board.buildBoardRecords(activeSlot.boardRecords, assessments, actions);
check('builder returns 14 records of 168 bytes', records.length === 14 && records.every(r => r.length === 168));

const result = editor.applyEdits(before.wrapper.payload, [{ kind: 'board', records }]);
const wrapperKind = before.wrapper.kind === 'dsv' ? 'dsv' : 'raw';
const out = editor.rewrapForDownload(result.payload, wrapperKind, file);
const after = await parser.parseSaveFile(out);

for (const label of ['A', 'B']) {
  const s = label === 'A' ? after.slotA : after.slotB;
  if (s.uninitialised) continue;
  check(`slot ${label} header csum ok after repair`, s.checksum.ok, `${s.checksum.storedHex}`);
  check(`slot ${label} body csum ok after repair`, s.bodyChecksum.ok, `${s.bodyChecksum.storedHex}`);
  check(`slot ${label} extra0 csum ok after repair`, s.extra0Checksum.ok, `${s.extra0Checksum.storedHex}`);
  const re = board.assessBoard(s.boardRecords, index, s.playerName);
  const bad = re.filter(a => a.status === 'unrecoverable' || a.status === 'unknown' || a.status === 'damaged' || a.status === 'outdated');
  check(`slot ${label} board has no damaged / corrupt / outdated posts after repair`, bad.length === 0, `${bad.length} left`);
  console.log(`  slot ${label} after: ` + re.filter(a => a.status !== 'empty').map(a => a.status).join(', '));
}

// Untouched regions: everything outside the board block and the checksum
// words must be byte-identical.
const SLOT_BASES = { A: 0x100, B: 0x40000 };
let diffOutside = 0;
for (let i = 0; i < before.wrapper.payload.length; i++) {
  if (before.wrapper.payload[i] === result.payload[i]) continue;
  let inside = false;
  for (const [label, base] of Object.entries(SLOT_BASES)) {
    const blk = base + board.BOARD_BASE;
    if (i >= blk && i < blk + 14 * 0xa8) inside = true;
    if (i >= base && i < base + 2) inside = true; // header csum
    if (i >= base + 0x14 && i < base + 0x16) inside = true; // body csum
    void label;
  }
  if (!inside) diffOutside++;
}
check('no bytes changed outside the board block and checksum words', diffOutside === 0, `${diffOutside} stray byte(s)`);

if (referencePath) {
  // The reference tool repairs each slot's own records; the editor mirrors
  // the active slot's rebuilt board to both slots (as every other edit kind
  // does), so only the active slot is comparable byte for byte.
  const ref = new Uint8Array(fs.readFileSync(referencePath));
  for (const [label, base] of Object.entries(SLOT_BASES)) {
    if (label !== active) continue;
    const blk = base + board.BOARD_BASE;
    const mine = result.payload.subarray(blk, blk + 14 * 0xa8);
    const theirs = ref.subarray(blk, blk + 14 * 0xa8);
    let diffs = 0;
    const where = [];
    for (let i = 0; i < mine.length; i++) {
      if (mine[i] !== theirs[i]) {
        diffs++;
        if (where.length < 8) where.push(`rec ${Math.floor(i / 0xa8)}+0x${(i % 0xa8).toString(16)}: ${mine[i].toString(16)} vs ${theirs[i].toString(16)}`);
      }
    }
    check(`slot ${label} board block matches the reference tool byte for byte`, diffs === 0, diffs ? `${diffs} diffs: ${where.join('; ')}` : '');
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
