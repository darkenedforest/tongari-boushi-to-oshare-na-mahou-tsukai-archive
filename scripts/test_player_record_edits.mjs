// Player-record / NPC-record edit test (step-409).
//
// Parses a real save, checks the §58 decoders against known facts about it
// (Zeno's save: level 50, rank 5 "Great Wizard", title Grand Magus 0x167B,
// one player record), applies wallet / bank / wizard level / rank / NPC
// affinity edits, re-parses and verifies every checksum level including the
// player record's own, and that nothing else moved.
//
//   ./node_modules/.bin/esbuild --bundle --platform=node --format=esm \
//     --outfile=tmp/player-bundle.mjs scripts/test_player_record_edits.mjs \
//     && node tmp/player-bundle.mjs <save>

import fs from 'node:fs';

import * as parser from '../src/lib/savefile/parser.ts';
import * as editor from '../src/lib/savefile/editor.ts';
import * as regions from '../src/lib/savefile/regions.ts';

const savePath = process.argv[2];
if (!savePath) {
  console.error('usage: node tmp/player-bundle.mjs <save>');
  process.exit(2);
}
let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

const file = new Uint8Array(fs.readFileSync(savePath));
const before = await parser.parseSaveFile(file);
const slot = before.activeSlot === 'B' ? before.slotB : before.slotA;
console.log(`active slot ${before.activeSlot}; player record ${slot.activePlayer}; wallet ${slot.ritch}; bank ${slot.bank}`);
const rec = slot.playerRecords[slot.activePlayer];
console.log(`level ${rec.wizardLevel} rank ${rec.rankIndex} title 0x${rec.titleItem.toString(16)} wand 0x${rec.wandToken.toString(16)} lastSave ${rec.lastSaveDate.text} created ${rec.creationDate.text}`);
check('player record checksums all pass', slot.playerRecords.every(r => r.checksumOk), slot.playerRecords.map(r => `${r.index}:${r.checksumOk}`).join(' '));
check('exactly the header-flagged records are populated', slot.playerRecords.every(r => r.exists === !r.blank));
check('wizard level in 1..50', rec.wizardLevel >= 1 && rec.wizardLevel <= 50, String(rec.wizardLevel));
check('rank index in 0..5', rec.rankIndex <= 5, String(rec.rankIndex));
check('title item is one of the six Magus titles or none', rec.titleItem === 0xffff || (rec.titleItem >= 0x1676 && rec.titleItem <= 0x167b), `0x${rec.titleItem.toString(16)}`);
check('140 NPC records parsed', slot.npcRecords.length === 140);
const used = slot.npcRecords.filter(r => !r.untouched);
console.log(`NPC records in use: ${used.length}; affinities: ${used.slice(0, 10).map(r => `${1000 + r.index}=${r.affinity}`).join(' ')}`);
check('affinity values are 0..100', slot.npcRecords.every(r => r.affinity <= 100));
console.log(`shop: ${slot.playerShop.shelves.filter(s => s.itemStored !== 0xffff).length} shelves, rank byte ${slot.playerShop.rankRaw}, lifetime sales ${slot.shopLedger.lifetimeTotal}`);
console.log(`world: ${slot.worldObjects.outdoorCellsUsed} outdoor cells; lists in use ${slot.worldObjects.lists.filter(l => l.used).map(l => `${l.index}:${l.used}`).join(' ')}`);
console.log(`custom items: ${slot.customItems.filter(c => c.name).map(c => c.name).join(' | ') || '(none)'}`);

// --- edits ---
const npc = used[0] ?? slot.npcRecords[0];
const newAffinity = npc.affinity === 77 ? 66 : 77;
const edits = [
  { kind: 'ritch', value: 123456, playerIndex: slot.activePlayer },
  { kind: 'bank', value: 7654321, playerIndex: slot.activePlayer },
  { kind: 'wizard_level', value: rec.wizardLevel === 42 ? 41 : 42, playerIndex: slot.activePlayer },
  { kind: 'wizard_rank', value: rec.rankIndex === 3 ? 2 : 3, playerIndex: slot.activePlayer },
  { kind: 'npc_affinity', npcIndex: npc.index, value: newAffinity },
];
const result = editor.applyEdits(before.wrapper.payload, edits);
const out = editor.rewrapForDownload(result.payload, before.wrapper.kind === 'dsv' ? 'dsv' : 'raw', file);
const after = await parser.parseSaveFile(out);
for (const label of ['A', 'B']) {
  const s = label === 'A' ? after.slotA : after.slotB;
  if (s.uninitialised) continue;
  check(`slot ${label} header csum`, s.checksum.ok);
  check(`slot ${label} body csum`, s.bodyChecksum.ok);
  check(`slot ${label} extra0 csum`, s.extra0Checksum.ok);
  check(`slot ${label} player record csums`, s.playerRecords.every(r => r.checksumOk));
  const r2 = s.playerRecords[slot.activePlayer];
  check(`slot ${label} wallet edited`, s.ritch === 123456 || s.activePlayer !== slot.activePlayer, String(s.ritch));
  check(`slot ${label} bank edited`, r2.bank === 7654321, String(r2.bank));
  check(`slot ${label} wizard level edited`, r2.wizardLevel === edits[2].value, String(r2.wizardLevel));
  check(`slot ${label} rank edited`, r2.rankIndex === edits[3].value, String(r2.rankIndex));
  check(`slot ${label} NPC affinity edited`, s.npcRecords[npc.index].affinity === newAffinity);
  check(`slot ${label} title / wand untouched`, r2.titleItem === rec.titleItem && r2.wandToken === rec.wandToken);
  const sBefore = label === 'A' ? before.slotA : before.slotB;
  check(`slot ${label} board untouched`, JSON.stringify(s.boardRecords.map(b => b.rawHex)) === JSON.stringify(sBefore.boardRecords.map(b => b.rawHex)));
}
// Byte diff outside the edited fields and checksum words
const SLOT_BASES = { A: 0x100, B: 0x40000 };
let stray = 0;
const allowed = new Set();
for (const base of Object.values(SLOT_BASES)) {
  const pr = base + regions.PLAYER_RECORD_BASE + slot.activePlayer * regions.PLAYER_RECORD_SIZE;
  for (let i = 0; i < 2; i++) { allowed.add(base + i); allowed.add(base + 0x14 + i); allowed.add(pr + i); allowed.add(base + regions.PLAYER_RECORD_BASE + i); }
  for (let i = 0; i < 4; i++) { allowed.add(pr + regions.PR_WALLET + i); allowed.add(pr + regions.PR_BANK + i); }
  allowed.add(pr + regions.PR_WIZARD_LEVEL); allowed.add(pr + regions.PR_WIZARD_RANK);
  allowed.add(base + regions.NPC_RECORD_BASE + npc.index * regions.NPC_RECORD_SIZE + regions.NPC_AFFINITY_OFF);
}
for (let i = 0; i < before.wrapper.payload.length; i++) {
  if (before.wrapper.payload[i] !== result.payload[i] && !allowed.has(i)) stray++;
}
check('no bytes changed outside the edited fields and checksum words', stray === 0, `${stray} stray`);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
