// End-to-end round-trip test for the in-browser save editor.
//
// 1. Load the test save file from disk.
// 2. Run the same parseSaveFile() the React inspector runs, snapshot.
// 3. Apply a set of edits via applyEdits() — covers every edit kind:
//    - shop_name (renamed from school_name in step-258)
//    - town_name (new in step-258)
//    - player_name (5 chars, the §22 cap)
//    - catalog (text edit at one slot)
//    - catalog_clear (remove at another slot)
//    - ritch (to confirm we didn't break the previously-working path)
//    - inventory_slot (step-264) — add to empty, change occupied, clear
// 4. Re-wrap as .dsv and reparse.
// 5. Assert the edits round-trip cleanly: read-back values match what
//    we wrote, untouched fields are preserved, and all three checksum
//    levels pass on the re-parsed save.
//
// step-258 additions:
//   - Independent-field round-trip: edit each of {player, shop, town}
//     in isolation and assert the other two are byte-identical to
//     their pre-edit values. This is the regression test for the
//     "player_name edit clobbered town + corrupted shop" bug step-258
//     fixes.
//   - submission #16 (Harry Potter playthrough, distinct names for
//     player/shop/town) is loaded as a second fixture so we have an
//     empirical anchor: player="WEASLEY", shop="Shop Weasleys",
//     town="HOGSMEADE".
//
// Run with esbuild + Node (step-264 update — the prior "Node native
// --experimental-strip-types" path the step-252 harness claimed works
// does not on Node 22 because `import './parser'` won't auto-resolve
// to `./parser.ts`). esbuild bundles + strips types in one pass:
//
//   ./node_modules/.bin/esbuild --bundle --platform=node --format=esm \
//     --outfile=tmp/savefile-bundle.mjs \
//     scripts/test_savefile_roundtrip.mjs \
//     && node tmp/savefile-bundle.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE =
  'C:/Users/Tyler/Desktop/Hack/DeSmuME-VS2019-x64-Release (1)/Battery/Saves for hacking/tongari_en.dsv';

// Reproduce the editor's apply pipeline by tsc-stripping the source
// files via the built dist output is fragile (the dist is a bundle
// for SSR/SSG with React glue). Instead, we use Node's native TS
// stripping on the .ts sources directly via dynamic import.
//
// `--experimental-strip-types` strips types at parse time, no
// transformation needed.

const editor = await import('../src/lib/savefile/editor.ts');
const parser = await import('../src/lib/savefile/parser.ts');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Load the inventory_encoding bijection the same way the browser would,
// but synchronously from disk so the test harness doesn't need a fetch
// stub. The browser path in lookups.ts produces the identical maps.
const ENCODING_PATH = path.join(REPO_ROOT, 'public/data/inventory_encoding.json');
const ITEM_NAMES_PATH = path.join(REPO_ROOT, 'public/data/savefile_lookups.json');
const rawEncoding = JSON.parse(fs.readFileSync(ENCODING_PATH, 'utf8'));
const rawLookups = JSON.parse(fs.readFileSync(ITEM_NAMES_PATH, 'utf8'));
const iidToStored = {};
const storedToIid = {};
for (const [k, v] of Object.entries(rawEncoding.mapping_iid_to_stored ?? {})) {
  const iid = Number(k);
  const stored = Number(v);
  iidToStored[iid] = stored;
  storedToIid[stored] = iid;
}
const itemNames = rawLookups.items ?? {};
function nameByIid(iid) {
  return itemNames[String(iid)] ?? null;
}
function iidByStored(stored) {
  const v = storedToIid[stored];
  return v === undefined ? null : v;
}
function storedByIid(iid) {
  const v = iidToStored[iid];
  return v === undefined ? null : v;
}

const file = new Uint8Array(fs.readFileSync(FIXTURE));
console.log(`Loaded fixture: ${FIXTURE} (${file.length} bytes)`);

// ---------------------------------------------------------------------------
// Snapshot the original parse
// ---------------------------------------------------------------------------

const parseBefore = await parser.parseSaveFile(file);
console.log('\n--- Before edits ---');
console.log(`active slot: ${parseBefore.activeSlot}`);
console.log(`active-slot reason: ${parseBefore.activeSlotReason}`);
console.log(`wrapper kind: ${parseBefore.wrapper.kind}`);
const slotABefore = parseBefore.slotA;
const slotBBefore = parseBefore.slotB;

// step-254 active-slot identification: the previous editor (step-253)
// hardcoded reads from slot A and silently showed the WRONG inventory
// for any save whose last in-game write landed in slot B. With this
// fixture, the last save did land in slot B (slot A is leftover stale
// data from a much earlier walkthrough), so the active-slot picker
// MUST return 'B'. If this assertion fails the inventory editor will
// regress to the step-253 bug — slots 1-14 will look blank to the user
// because slot A's bag was emptied out.
console.log('\n--- Active-slot detection (step-254) ---');
console.log(`slot A body[0x00]=${slotABefore.saveCounter.toString(16)} body[0x01]=${slotABefore.saveCounterCompanion.toString(16)} ts=${slotABefore.lastSaveTimestampRawHex}`);
console.log(`slot B body[0x00]=${slotBBefore.saveCounter.toString(16)} body[0x01]=${slotBBefore.saveCounterCompanion.toString(16)} ts=${slotBBefore.lastSaveTimestampRawHex}`);

console.log(`slot A:`);
console.log(`  player name: ${JSON.stringify(slotABefore.playerName)}`);
console.log(`  shop name:   ${JSON.stringify(slotABefore.shopName)}`);
console.log(`  town name:   ${JSON.stringify(slotABefore.townName)}`);
console.log(`  ritch: ${slotABefore.ritch}`);
console.log(`  catalog entries: ${slotABefore.catalogEntries.length}`);
slotABefore.catalogEntries.slice(0, 5).forEach((e, i) => {
  console.log(`    #${i+1} @body 0x${e.bodyOffset.toString(16)}: ${JSON.stringify(e.text.slice(0,60))}`);
});
console.log(`  header csum ok: ${slotABefore.checksum.ok}`);
console.log(`  body csum ok:   ${slotABefore.bodyChecksum.ok}`);
console.log(`  extra0 csum ok: ${slotABefore.extra0Checksum.ok}`);

// Inventory bag (slot B is where the populated bag lives in this fixture)
console.log(`\n  slot B inventory bag (15 slots @ body 0x1D9B6):`);
for (const bagSlot of slotBBefore.inventoryBag) {
  if (bagSlot.empty) {
    console.log(`    slot ${bagSlot.index + 1}: (empty)  raw=${bagSlot.rawHex}`);
  } else {
    const iid = iidByStored(bagSlot.storedValue);
    const name = iid !== null ? nameByIid(iid) : null;
    console.log(
      `    slot ${bagSlot.index + 1}: stored=0x${bagSlot.storedValue.toString(16).padStart(4, '0').toUpperCase()} ` +
      `iid=${iid} name=${JSON.stringify(name)} qty=${bagSlot.quantity}  raw=${bagSlot.rawHex}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Inventory parse assertions — the 8 expected slot values per the spec
// ---------------------------------------------------------------------------

let failures = 0;
function assertEq(label, got, want) {
  if (got !== want) {
    console.error(`FAIL: ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failures++;
  } else {
    console.log(`PASS: ${label} = ${JSON.stringify(got)}`);
  }
}
function assertTrue(label, got) {
  if (!got) {
    console.error(`FAIL: ${label}: got ${JSON.stringify(got)}`);
    failures++;
  } else {
    console.log(`PASS: ${label}`);
  }
}

console.log('\n--- Parse assertions (active slot detection — step-254) ---');
// The fixture's most-recent in-game save landed in slot B (slot A has
// the stale single-mushroom inventory from an earlier walkthrough). If
// chooseActiveSlot ever returns 'A' for this fixture, the inventory
// editor regresses to its step-253 bug.
assertEq('parse.activeSlot for tongari_en.dsv', parseBefore.activeSlot, 'B');

// Drive the assertions through the same code path the React UI uses:
// pick slotForTab via parse.activeSlot just like
// SaveFileInspector.tsx's `slotForTab = activeSlotTab === 'A' ? ...`
// does, where activeSlotTab is initialized from parse.activeSlot at
// line 2225. Going through the active-slot indirection rather than
// asserting against slotBBefore directly catches future regressions
// where the picker output and the UI's tab-switch logic drift apart.
const activeSlotBefore =
  parseBefore.activeSlot === 'A' ? slotABefore : slotBBefore;
assertEq(
  `active slot label round-trips back through SlotParse`,
  activeSlotBefore.label,
  parseBefore.activeSlot,
);

console.log('\n--- Parse assertions (active slot inventory bag = slot B for fixture) ---');
const expectedSlotB = [
  { slot: 1,  storedValue: 0x019E, expectedName: 'Yellow May Lily',       quantity: 1 },
  { slot: 2,  storedValue: 0x025A, expectedName: 'Cranberry',             quantity: 1 },
  { slot: 3,  storedValue: 0x019C, expectedName: 'White May Lily',        quantity: 1 },
  { slot: 4,  storedValue: 0x05F3, expectedName: 'Cat Print Shirt',       quantity: 1 },
  { slot: 5,  storedValue: 0x08E4, expectedName: 'Skull Punk Skirt',      quantity: 1 },
  { slot: 6,  storedValue: 0x0C53, expectedName: 'Ice Lamp',              quantity: 1 },
  { slot: 7,  storedValue: 0x0A53, expectedName: 'Brn Classic Drs',       quantity: 1 },
  { slot: 15, storedValue: 0x0203, expectedName: 'King Oyster Mushroom',  quantity: 1 },
];
for (const exp of expectedSlotB) {
  // Read through activeSlotBefore (which is slotBBefore for this fixture
  // post-step-254). Asserting via activeSlotBefore catches the bug where
  // the picker returns the wrong label but the underlying SlotParse for
  // the chosen label is still correct.
  const bagSlot = activeSlotBefore.inventoryBag[exp.slot - 1];
  assertEq(
    `active-slot inv slot ${exp.slot}: storedValue`,
    bagSlot.storedValue,
    exp.storedValue,
  );
  assertEq(
    `active-slot inv slot ${exp.slot}: empty=false`,
    bagSlot.empty,
    false,
  );
  assertEq(
    `active-slot inv slot ${exp.slot}: quantity`,
    bagSlot.quantity,
    exp.quantity,
  );
  const iid = iidByStored(bagSlot.storedValue);
  const name = iid !== null ? nameByIid(iid) : null;
  assertEq(
    `active-slot inv slot ${exp.slot}: iid→name`,
    name,
    exp.expectedName,
  );
}
// Slots 8..14 should be the empty sentinel (across the active slot).
for (const idx of [8, 9, 10, 11, 12, 13, 14]) {
  const bagSlot = activeSlotBefore.inventoryBag[idx - 1];
  assertEq(
    `active-slot inv slot ${idx}: empty=true`,
    bagSlot.empty,
    true,
  );
}

// ---------------------------------------------------------------------------
// Plan + apply the edits
// ---------------------------------------------------------------------------

const targetCatalogEdit = slotABefore.catalogEntries[1];  // entry #2
const targetCatalogRemove = slotABefore.catalogEntries[3]; // entry #4

// Inventory edits — exercise empty→occupied, occupied→occupied, occupied→empty.
//   - Slot 8 (currently empty in BOTH slot A and slot B): add Cranberry x5
//   - Slot 1 (currently Yellow May Lily in slot B, empty in slot A): change to White May Lily x3
//   - Slot 2 (currently Cranberry in slot B, empty in slot A): clear to empty
const NEW_SLOT8_IID = 273;   // Cranberry, stored 0x025A
const NEW_SLOT1_IID = 202;   // White May Lily, stored 0x019C
const NEW_SLOT8_STORED = storedByIid(NEW_SLOT8_IID);
const NEW_SLOT1_STORED = storedByIid(NEW_SLOT1_IID);
if (NEW_SLOT8_STORED === null || NEW_SLOT1_STORED === null) {
  console.error('FAIL: inventory_encoding bijection missing expected iids — cannot build edit plan');
  process.exit(1);
}

const edits = [
  { kind: 'player_name', value: 'ABEL' },         // 4 chars, within 5-char cap
  { kind: 'shop_name', value: 'Magus' },          // 5 chars, within 6-char cap (renamed from school_name in step-258)
  { kind: 'town_name', value: 'Town2' },          // 5 chars, within 5-char cap (new in step-258)
  { kind: 'ritch', value: 42424 },
  { kind: 'catalog', entryOffset: targetCatalogEdit.bodyOffset, text: 'STAGE-2-EDITED\nHello world!\nThis is a round-trip test.' },
  { kind: 'catalog_clear', entryOffset: targetCatalogRemove.bodyOffset },
  // Inventory bag edits — slotIndex is 0-based (slot 1 = index 0).
  { kind: 'inventory_slot', slotIndex: 7, storedValue: NEW_SLOT8_STORED, quantity: 5 },   // slot 8 ← Cranberry x5
  { kind: 'inventory_slot', slotIndex: 0, storedValue: NEW_SLOT1_STORED, quantity: 3 },   // slot 1 ← White May Lily x3
  { kind: 'inventory_slot', slotIndex: 1, storedValue: null,            quantity: 0 },    // slot 2 ← (empty)
];

console.log('\n--- Applying edits ---');
edits.forEach(e => console.log(`  ${JSON.stringify(e).slice(0, 120)}`));

const result = editor.applyEdits(parseBefore.wrapper.payload, edits);
console.log(`\nnew header csums: slot A ${result.slotAChecksumHex}, slot B ${result.slotBChecksumHex}`);
console.log(`new body csums:   slot A ${result.slotABodyChecksumHex}, slot B ${result.slotBBodyChecksumHex}`);
console.log(`new extra0 csums: slot A ${result.slotAExtra0ChecksumHex}, slot B ${result.slotBExtra0ChecksumHex}`);

// Re-wrap as .dsv (preserve footer)
const wrapped = editor.rewrapForDownload(result.payload, 'dsv', file);
console.log(`re-wrapped size: ${wrapped.length} bytes (expected ${file.length})`);

// ---------------------------------------------------------------------------
// Reparse the edited save
// ---------------------------------------------------------------------------

const parseAfter = await parser.parseSaveFile(wrapped);
console.log('\n--- After edits, after re-parse ---');
const slotAAfter = parseAfter.slotA;
const slotBAfter = parseAfter.slotB;
console.log(`slot A:`);
console.log(`  player name: ${JSON.stringify(slotAAfter.playerName)}`);
console.log(`  shop name:   ${JSON.stringify(slotAAfter.shopName)}`);
console.log(`  town name:   ${JSON.stringify(slotAAfter.townName)}`);
console.log(`  ritch: ${slotAAfter.ritch}`);
console.log(`  catalog entries: ${slotAAfter.catalogEntries.length}`);
slotAAfter.catalogEntries.slice(0, 5).forEach((e, i) => {
  console.log(`    #${i+1} @body 0x${e.bodyOffset.toString(16)}: ${JSON.stringify(e.text.slice(0,60))}`);
});
console.log(`  header csum ok: ${slotAAfter.checksum.ok}`);
console.log(`  body csum ok:   ${slotAAfter.bodyChecksum.ok}`);
console.log(`  extra0 csum ok: ${slotAAfter.extra0Checksum.ok}`);

console.log('\nslot B:');
console.log(`  player name: ${JSON.stringify(slotBAfter.playerName)}`);
console.log(`  shop name:   ${JSON.stringify(slotBAfter.shopName)}`);
console.log(`  town name:   ${JSON.stringify(slotBAfter.townName)}`);
console.log(`  ritch: ${slotBAfter.ritch}`);
console.log(`  header csum ok: ${slotBAfter.checksum.ok}`);
console.log(`  body csum ok:   ${slotBAfter.bodyChecksum.ok}`);
console.log(`  extra0 csum ok: ${slotBAfter.extra0Checksum.ok}`);

console.log(`\n  slot B inventory bag after edits:`);
for (const bagSlot of slotBAfter.inventoryBag) {
  if (bagSlot.empty) {
    console.log(`    slot ${bagSlot.index + 1}: (empty)  raw=${bagSlot.rawHex}`);
  } else {
    const iid = iidByStored(bagSlot.storedValue);
    const name = iid !== null ? nameByIid(iid) : null;
    console.log(
      `    slot ${bagSlot.index + 1}: stored=0x${bagSlot.storedValue.toString(16).padStart(4, '0').toUpperCase()} ` +
      `iid=${iid} name=${JSON.stringify(name)} qty=${bagSlot.quantity}  raw=${bagSlot.rawHex}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

console.log('\n--- Assertions (edit round-trip) ---');
assertEq('slot A player name after = ABEL', slotAAfter.playerName, 'ABEL');
assertEq('slot A shop name after = Magus', slotAAfter.shopName, 'Magus');
assertEq('slot A town name after = Town2', slotAAfter.townName, 'Town2');
assertEq('slot A ritch after = 42424', slotAAfter.ritch, 42424);
assertEq('slot B player name after = ABEL', slotBAfter.playerName, 'ABEL');
assertEq('slot B shop name after = Magus', slotBAfter.shopName, 'Magus');
assertEq('slot B town name after = Town2', slotBAfter.townName, 'Town2');
assertEq('slot B ritch after = 42424', slotBAfter.ritch, 42424);

assertTrue('slot A header csum still passes', slotAAfter.checksum.ok);
assertTrue('slot A body csum still passes', slotAAfter.bodyChecksum.ok);
assertTrue('slot A extra0 csum still passes', slotAAfter.extra0Checksum.ok);
assertTrue('slot B header csum still passes', slotBAfter.checksum.ok);
assertTrue('slot B body csum still passes', slotBAfter.bodyChecksum.ok);
assertTrue('slot B extra0 csum still passes', slotBAfter.extra0Checksum.ok);

// Catalog edit round-trip
const editedEntryAfter = slotAAfter.catalogEntries.find(
  e => e.bodyOffset === targetCatalogEdit.bodyOffset,
);
assertTrue('edited catalog entry still present after round-trip',
  editedEntryAfter !== undefined);
if (editedEntryAfter) {
  assertEq(
    'edited catalog entry text round-trips',
    editedEntryAfter.text,
    'STAGE-2-EDITED\nHello world!\nThis is a round-trip test.',
  );
}

const clearedEntryAfter = slotAAfter.catalogEntries.find(
  e => e.bodyOffset === targetCatalogRemove.bodyOffset,
);
assertTrue('removed catalog entry no longer surfaces in the parsed list',
  clearedEntryAfter === undefined);

// Other catalog entries should be preserved intact.
const otherOriginals = slotABefore.catalogEntries
  .filter(e => e.bodyOffset !== targetCatalogEdit.bodyOffset
            && e.bodyOffset !== targetCatalogRemove.bodyOffset);
for (const orig of otherOriginals) {
  const after = slotAAfter.catalogEntries.find(e => e.bodyOffset === orig.bodyOffset);
  if (!after) {
    console.error(`FAIL: other catalog entry @0x${orig.bodyOffset.toString(16)} disappeared after edit`);
    failures++;
  } else if (after.text !== orig.text) {
    console.error(`FAIL: other catalog entry @0x${orig.bodyOffset.toString(16)} text changed:\n  before: ${JSON.stringify(orig.text)}\n  after:  ${JSON.stringify(after.text)}`);
    failures++;
  } else {
    console.log(`PASS: untouched catalog entry @0x${orig.bodyOffset.toString(16)} preserved`);
  }
}

// ---------------------------------------------------------------------------
// Inventory edit round-trip assertions
// ---------------------------------------------------------------------------

console.log('\n--- Assertions (inventory edits round-trip on slot B) ---');

// Slot 1 ← White May Lily x3 (was Yellow May Lily in slot B)
{
  const s = slotBAfter.inventoryBag[0];
  assertEq('slot B inv slot 1 after: empty', s.empty, false);
  assertEq('slot B inv slot 1 after: storedValue = 0x019C (White May Lily)', s.storedValue, 0x019C);
  assertEq('slot B inv slot 1 after: quantity = 3', s.quantity, 3);
  const iid = iidByStored(s.storedValue);
  assertEq('slot B inv slot 1 after: name = White May Lily', nameByIid(iid), 'White May Lily');
}

// Slot 2 ← (empty) (was Cranberry in slot B)
{
  const s = slotBAfter.inventoryBag[1];
  assertEq('slot B inv slot 2 after: empty', s.empty, true);
  assertEq('slot B inv slot 2 after: raw = sentinel', s.rawHex, 'ffffffffff00');
}

// Slot 8 ← Cranberry x5 (was empty in slot B)
{
  const s = slotBAfter.inventoryBag[7];
  assertEq('slot B inv slot 8 after: empty', s.empty, false);
  assertEq('slot B inv slot 8 after: storedValue = 0x025A (Cranberry)', s.storedValue, 0x025A);
  assertEq('slot B inv slot 8 after: quantity = 5', s.quantity, 5);
  const iid = iidByStored(s.storedValue);
  assertEq('slot B inv slot 8 after: name = Cranberry', nameByIid(iid), 'Cranberry');
}

// Untouched inventory slots (3..7, 9..15) must be byte-identical to before.
for (const idx of [3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]) {
  const before = slotBBefore.inventoryBag[idx - 1];
  const after = slotBAfter.inventoryBag[idx - 1];
  assertEq(
    `slot B inv slot ${idx} untouched (raw bytes)`,
    after.rawHex,
    before.rawHex,
  );
}

// Mirror check: same inventory edits should have landed in slot A too.
console.log('\n--- Mirror check: slot A inventory bag also got the edits ---');
{
  const sA = slotAAfter.inventoryBag[0];
  assertEq('slot A inv slot 1 after: storedValue = 0x019C', sA.storedValue, 0x019C);
  assertEq('slot A inv slot 1 after: quantity = 3', sA.quantity, 3);

  const sA2 = slotAAfter.inventoryBag[1];
  assertEq('slot A inv slot 2 after: empty', sA2.empty, true);

  const sA8 = slotAAfter.inventoryBag[7];
  assertEq('slot A inv slot 8 after: storedValue = 0x025A', sA8.storedValue, 0x025A);
  assertEq('slot A inv slot 8 after: quantity = 5', sA8.quantity, 5);
}

// ---------------------------------------------------------------------------
// step-254 active-slot direction-swap test: synthesize a copy of the
// fixture where slot A's last-save timestamp is BUMPED past slot B's, so
// the active-slot picker must now pick A. This catches the bug where the
// picker was hardcoded to a single direction (always-A or always-B).
//
// We use the original `file` bytes (still the unmodified .dsv) — the
// edited `wrapped` bytes have already been verified above so they're
// independent of this test.
// ---------------------------------------------------------------------------

console.log('\n--- Active-slot direction-swap test (slot A bumped newer) ---');
{
  const swapped = new Uint8Array(file);
  // The 122-byte .dsv footer is preserved at the end; the slot bodies
  // live inside the first 524288 bytes regardless.
  const SLOT_A_BODY_FILE_OFFSET = 0x100;
  const LAST_SAVE_TS_OFFSET = 0x494;
  const tsAddr = SLOT_A_BODY_FILE_OFFSET + LAST_SAVE_TS_OFFSET;
  // Original timestamps from the parsed save:
  //   slot A body[0x494] = 1a 04 15 05 0e 04 (2026-04-21 05:14:04)
  //   slot B body[0x494] = 1a 04 15 05 0e 15 (2026-04-21 05:14:21)
  // Bump slot A's seconds field (the 6th byte) by 0x20 so slot A is
  // chronologically AFTER slot B. We don't touch any checksums because
  // the active-slot picker runs BEFORE csum verification; we just need
  // the picker to flip its answer. (The downstream csum-OK reads would
  // see "FAIL" on the swapped save, but that's expected and orthogonal
  // to the picker logic this test exercises.)
  swapped[tsAddr + 5] = swapped[tsAddr + 5] + 0x20;

  const swappedParse = await parser.parseSaveFile(swapped);
  assertEq(
    'synthesized save with slot A timestamp > slot B timestamp picks A',
    swappedParse.activeSlot,
    'A',
  );
  console.log(`  reason: ${swappedParse.activeSlotReason}`);
}

// And a second direction-swap test: tie the timestamps but bump slot A's
// counter-companion (body[0x01]) past slot B's, exercising the
// timestamp-tied -> counter-companion fallback.
console.log('\n--- Active-slot fallback test (timestamps tied, A companion bumped) ---');
{
  const swapped2 = new Uint8Array(file);
  const SLOT_A_BODY_FILE_OFFSET = 0x100;
  const SLOT_B_BODY_FILE_OFFSET = 0x40000;
  const LAST_SAVE_TS_OFFSET = 0x494;
  // Force-tie the timestamps by copying B's into A.
  for (let i = 0; i < 6; i++) {
    swapped2[SLOT_A_BODY_FILE_OFFSET + LAST_SAVE_TS_OFFSET + i] =
      swapped2[SLOT_B_BODY_FILE_OFFSET + LAST_SAVE_TS_OFFSET + i];
  }
  // Bump slot A's counter-companion past slot B's. Original values:
  //   slot A body[0x01] = 0xFD, slot B body[0x01] = 0xFE.
  // Setting A's companion to 0xFF makes it strictly greater than B's.
  swapped2[SLOT_A_BODY_FILE_OFFSET + 0x01] = 0xff;

  const swapped2Parse = await parser.parseSaveFile(swapped2);
  assertEq(
    'timestamps tied + slot A companion (body[0x01]) > slot B companion picks A',
    swapped2Parse.activeSlot,
    'A',
  );
  console.log(`  reason: ${swapped2Parse.activeSlotReason}`);
}

// ---------------------------------------------------------------------------
// Town-residents parsing — step-NNN restoration of §30 (8 × 0x22F8 table at
// body 0x1E0E0). Two-pronged test:
//   1. tongari_en.dsv (the fixture): all slots are EMPTY (vacant zeros) or
//      UNINIT (0xFF). Player hasn't reached the in-game point where any
//      resident has moved in yet. Both slot A and slot B must report this
//      same shape because the slots mirror each other.
//   2. upload_12.bin from the translation repo's corpus: slot 0 = モコるん,
//      slot 1 = ラビーな, slots 2..3 vacant, slots 4..7 uninit. This is the
//      empirical anchor that the §30 layout is correct.
//
// upload_12 lives in the translation repo, which sits alongside this archive
// repo on disk. We resolve it relative to this repo's parent. If the file
// can't be located (e.g. running CI in an isolated checkout), the upload_12
// assertions are skipped — the in-repo fixture assertions still run.
// ---------------------------------------------------------------------------

console.log('\n--- Town residents parsing — fixture (tongari_en.dsv) ---');
{
  const residentsA = slotABefore.townResidents;
  const residentsB = slotBBefore.townResidents;
  assertEq('slot A residents table length', residentsA.length, 8);
  assertEq('slot B residents table length', residentsB.length, 8);
  // Slot 0 in both A and B is the EMPTY-zeros sentinel; slots 1..7 are
  // 0xFF UNINIT. This matches what the player sees in-game for a save
  // before any resident has ever moved in.
  assertEq('fixture slot A residents[0] state', residentsA[0].state, 'vacant');
  assertEq('fixture slot B residents[0] state', residentsB[0].state, 'vacant');
  for (const idx of [1, 2, 3, 4, 5, 6, 7]) {
    assertEq(
      `fixture slot A residents[${idx}] state`,
      residentsA[idx].state,
      'uninitialised',
    );
    assertEq(
      `fixture slot B residents[${idx}] state`,
      residentsB[idx].state,
      'uninitialised',
    );
  }
  // Body offsets must match the §30 documentation exactly.
  const expectedOffsets = [0x1e0e0, 0x203d8, 0x226d0, 0x249c8, 0x26cc0, 0x28fb8, 0x2b2b0, 0x2d5a8];
  expectedOffsets.forEach((off, i) => {
    assertEq(`fixture slot A residents[${i}] bodyOffset`, residentsA[i].bodyOffset, off);
  });
}

console.log('\n--- Town residents parsing — upload_12 corpus save (populated) ---');
{
  const UPLOAD12_PATH = path.resolve(
    REPO_ROOT,
    '..',
    'Tongari boushi translation app claude',
    'notes',
    'save_analysis',
    'raw',
    'upload_12.bin',
  );
  if (!fs.existsSync(UPLOAD12_PATH)) {
    console.log(`  SKIP — upload_12 not found at ${UPLOAD12_PATH}`);
    console.log('  (test is gated on the translation repo being alongside this archive repo)');
  } else {
    const upload12 = new Uint8Array(fs.readFileSync(UPLOAD12_PATH));
    const u12Parse = await parser.parseSaveFile(upload12);
    const u12A = u12Parse.slotA;
    const u12B = u12Parse.slotB;
    assertTrue('upload_12 parsed slot A', u12A !== null);
    assertTrue('upload_12 parsed slot B', u12B !== null);
    // §30 documents this exact roster — Mokorun at slot 0, Rabina at
    // slot 1. The decoded names match the UTF-16 LE codepoints
    // U+30E2 U+30B3 U+308B U+3093 (モコるん) and
    // U+30E9 U+30D3 U+30FC U+306A (ラビーな).
    assertEq('upload_12 slot A residents[0] state', u12A.townResidents[0].state, 'populated');
    assertEq('upload_12 slot A residents[0] name', u12A.townResidents[0].name, 'モコるん');
    assertEq('upload_12 slot A residents[1] state', u12A.townResidents[1].state, 'populated');
    assertEq('upload_12 slot A residents[1] name', u12A.townResidents[1].name, 'ラビーな');
    assertEq('upload_12 slot A residents[2] state', u12A.townResidents[2].state, 'vacant');
    assertEq('upload_12 slot A residents[3] state', u12A.townResidents[3].state, 'vacant');
    for (const idx of [4, 5, 6, 7]) {
      assertEq(
        `upload_12 slot A residents[${idx}] state`,
        u12A.townResidents[idx].state,
        'uninitialised',
      );
    }
    // Slot B mirrors slot A in upload_12 — the in-game save loop wrote
    // both slots with the same roster.
    assertEq('upload_12 slot B residents[0] name', u12B.townResidents[0].name, 'モコるん');
    assertEq('upload_12 slot B residents[1] name', u12B.townResidents[1].name, 'ラビーな');
  }
}

// ---------------------------------------------------------------------------
// Friends-Met parsing — read-only deduplicated scan of body 0x500..0x4300
// for u16 LE values in 500..751 (NPC stored_values per translation-repo
// step-346, commit 0941cbca). The encoding rule is:
//     stored_value = npc_data_ofs_id + 500
// so the 252 NPCs catalogued in notes/npc_encoding.json each have a
// stored_value in 500..751.
//
// Test policy: the active slot for tongari_en.dsv is slot B (verified
// above via parseBefore.activeSlot), so the friends-met list under test
// is the one parsed out of slot B. The expected roster is read directly
// from the fixture bytes (which we cross-checked via a standalone scan
// before writing this assertion block) — this is the empirical anchor
// for "the parser produces the right shape on a real save", just like
// the upload_12 town-residents assertions are the empirical anchor for
// the residents layout.
//
// Important data note: an earlier draft of the dispatch brief named
// `[505→Zoe, 506→Chloe, 509→Anson, 517→Naomi]` as the expected list,
// derived from a different save's offset annotations. The actual bytes
// in this fixture do NOT contain stored_value 509 anywhere — the third
// friend in this save is stored_value 507 (= Silvia, npc_data_ofs_id 7),
// not 509 (Anson). We assert against the fixture's actual contents so
// the test reflects ground truth rather than a typo'd reference. If the
// fixture is later replaced with a save that DOES have Anson, this
// assertion should be updated alongside the new fixture.
// ---------------------------------------------------------------------------

console.log('\n--- Friends-Met parsing (active slot, body 0x500..0x4300) ---');
{
  const active = parseBefore.activeSlot;
  const activeSlotParse = active === 'A' ? slotABefore : slotBBefore;
  const friends = activeSlotParse.friendsMet;

  // Load the NPC encoding the same way the browser would.
  const NPC_ENCODING_PATH = path.join(REPO_ROOT, 'public/data/npc_encoding.json');
  const rawNpcEncoding = JSON.parse(fs.readFileSync(NPC_ENCODING_PATH, 'utf8'));
  const npcByStored = rawNpcEncoding.mapping_stored_to_npc ?? {};

  console.log(`  active slot: ${active}`);
  console.log(`  total unique friends: ${friends.length}`);
  for (const f of friends) {
    const info = npcByStored[String(f.storedValue)];
    const en = info ? info.en_name : '(unmapped)';
    const jp = info ? info.jp_name : '—';
    console.log(
      `    stored=${f.storedValue} (0x${f.storedValue.toString(16).toUpperCase()}) ` +
      `EN=${JSON.stringify(en)} JP=${JSON.stringify(jp)} ` +
      `offsets=${f.bodyOffsets.map(o => '0x' + o.toString(16)).join(',')}`,
    );
  }

  // Active slot for this fixture is B, and its even-aligned scan in
  // body 0x500..0x4300 finds exactly these four NPC stored_values:
  //   505 → Zoe   (offsets 0x3120)
  //   506 → Chloe (offsets 0x2f86, 0x2f90, 0x32b0)
  //   507 → Silvia (offsets 0x4160, 0x42f0)
  //   517 → Naomi (offsets 0x1140, 0x12ee)
  // No false positives, no missed entries — the dedup-after-even-scan
  // strategy gives a clean roster.
  const expected = [
    { stored: 505, en: 'Zoe',    jp: 'ザマス' },
    { stored: 506, en: 'Chloe',  jp: 'ゆうこ' },
    { stored: 507, en: 'Silvia', jp: 'シルビア' },
    { stored: 517, en: 'Naomi',  jp: 'ヨサコ' },
  ];

  assertEq('friends-met count = 4 (no false positives, no missing)', friends.length, expected.length);
  expected.forEach((exp, i) => {
    const got = friends[i];
    assertEq(`friends-met[${i}] storedValue = ${exp.stored}`, got.storedValue, exp.stored);
    assertEq(`friends-met[${i}] iid = ${exp.stored - 500}`, got.iid, exp.stored - 500);
    const info = npcByStored[String(got.storedValue)];
    assertEq(`friends-met[${i}] EN name = ${exp.en}`, info ? info.en_name : null, exp.en);
    assertEq(`friends-met[${i}] JP name = ${exp.jp}`, info ? info.jp_name : null, exp.jp);
  });

  // The dedupe-by-value is the load-bearing invariant — without it, the
  // same NPC would appear once per offset in the displayed list.
  // Confirm by walking bodyOffsets and verifying we have at LEAST one
  // entry per friend with multiple offsets (Chloe has 3, Naomi has 2,
  // Silvia has 2 — see notes above).
  const chloe = friends.find(f => f.storedValue === 506);
  assertTrue('Chloe (506) has multiple offsets recorded (dedupe is real)',
    chloe !== undefined && chloe.bodyOffsets.length > 1);

  // Order must be ascending by stored_value (matches the spec).
  for (let i = 1; i < friends.length; i++) {
    assertTrue(
      `friends-met sorted ascending: [${i - 1}].storedValue < [${i}].storedValue`,
      friends[i - 1].storedValue < friends[i].storedValue,
    );
  }
}

// ---------------------------------------------------------------------------
// step-258: independent-field round-trip tests
//
// The pre-step-258 editor treated body 0x47E + 0x1149C + 0x114BA as three
// mirror copies of the player name, mirroring every player_name write to
// all three. Submission #16 (player="WEASLEY" shop="Shop Weasleys"
// town="HOGSMEADE") proved the offsets are independent fields:
//
//   body 0x1149C = PLAYER (e.g. WEASLEY)
//   body 0x114B2 = SHOP   (e.g. Shop Weasleys)
//   body 0x47E   = TOWN   (e.g. HOGSMEADE)
//
// Tests below:
//   1. Parse submission #16 (if available) and assert each parsed
//      field shows its correct distinct value.
//   2. Per-field isolation: edit each of {player, shop, town} on
//      tongari_en.dsv individually and assert the other two fields
//      are byte-identical to their pre-edit value. This catches any
//      future regression where one edit accidentally writes to a
//      sibling field's offset.
// ---------------------------------------------------------------------------

console.log('\n--- step-258: submission #16 parse fixture (3 distinct names) ---');

const SAVE_16_PATH = 'C:/Users/Tyler/AppData/Local/Temp/save_16.dsv';
let save16Parse = null;
if (fs.existsSync(SAVE_16_PATH)) {
  const save16 = new Uint8Array(fs.readFileSync(SAVE_16_PATH));
  save16Parse = await parser.parseSaveFile(save16);
  const s16Active = save16Parse.activeSlot === 'A' ? save16Parse.slotA : save16Parse.slotB;
  console.log(`  save #16 active slot: ${save16Parse.activeSlot}`);
  console.log(`  save #16 active-slot player: ${JSON.stringify(s16Active.playerName)}`);
  console.log(`  save #16 active-slot shop:   ${JSON.stringify(s16Active.shopName)}`);
  console.log(`  save #16 active-slot town:   ${JSON.stringify(s16Active.townName)}`);
  assertEq(
    'save #16 active-slot player name = "WEASLEY"',
    s16Active.playerName,
    'WEASLEY',
  );
  assertEq(
    'save #16 active-slot shop name = "Shop Weasleys"',
    s16Active.shopName,
    'Shop Weasleys',
  );
  assertEq(
    'save #16 active-slot town name = "HOGSMEADE"',
    s16Active.townName,
    'HOGSMEADE',
  );
} else {
  console.log(`  SKIP — save #16 not found at ${SAVE_16_PATH}`);
  console.log('  (download via _admin_save_files.py download 16 --to <path> to enable this anchor)');
}

console.log('\n--- step-258: per-field isolation (player edit must not touch shop/town) ---');
{
  // Edit ONLY player_name and assert the shop + town fields' raw bytes
  // round-trip identical to the pre-edit values.
  const isolEdits = [{ kind: 'player_name', value: 'IsoP' }];
  const isolResult = editor.applyEdits(parseBefore.wrapper.payload, isolEdits);
  const isolParse = await parser.parseSaveFile(isolResult.payload);
  const isolA = isolParse.slotA;
  const isolB = isolParse.slotB;

  assertEq('isolated player edit: slot A playerName became IsoP', isolA.playerName, 'IsoP');
  assertEq('isolated player edit: slot B playerName became IsoP', isolB.playerName, 'IsoP');
  // shop + town must be byte-identical to before.
  assertEq('isolated player edit: slot A shopName unchanged', isolA.shopName, slotABefore.shopName);
  assertEq('isolated player edit: slot A townName unchanged', isolA.townName, slotABefore.townName);
  assertEq('isolated player edit: slot B shopName unchanged', isolB.shopName, slotBBefore.shopName);
  assertEq('isolated player edit: slot B townName unchanged', isolB.townName, slotBBefore.townName);

  // Byte-level check: bytes at 0x47E (town) and 0x114B2 (shop) in the
  // edited payload must equal their pre-edit values across the full
  // field width. This catches the pre-step-258 bug at the byte layer,
  // where decodeUtf16Le might NUL-terminate before showing a regression.
  const SLOT_A_BASE = 0x100;
  for (let i = 0; i < 10; i++) {
    const orig = parseBefore.wrapper.payload[SLOT_A_BASE + 0x47e + i];
    const after = isolResult.payload[SLOT_A_BASE + 0x47e + i];
    if (orig !== after) {
      console.error(`FAIL: isolated player edit corrupted town byte at slot A body 0x47E+${i}: 0x${orig.toString(16)} -> 0x${after.toString(16)}`);
      failures++;
    }
  }
  for (let i = 0; i < 12; i++) {
    const orig = parseBefore.wrapper.payload[SLOT_A_BASE + 0x114b2 + i];
    const after = isolResult.payload[SLOT_A_BASE + 0x114b2 + i];
    if (orig !== after) {
      console.error(`FAIL: isolated player edit corrupted shop byte at slot A body 0x114B2+${i}: 0x${orig.toString(16)} -> 0x${after.toString(16)}`);
      failures++;
    }
  }
  console.log('PASS: byte-level check — town (0x47E) and shop (0x114B2) fields untouched by player edit');
}

console.log('\n--- step-258: per-field isolation (shop edit must not touch player/town) ---');
{
  const isolEdits = [{ kind: 'shop_name', value: 'IsoS' }];
  const isolResult = editor.applyEdits(parseBefore.wrapper.payload, isolEdits);
  const isolParse = await parser.parseSaveFile(isolResult.payload);
  const isolA = isolParse.slotA;
  const isolB = isolParse.slotB;

  assertEq('isolated shop edit: slot A shopName became IsoS', isolA.shopName, 'IsoS');
  assertEq('isolated shop edit: slot B shopName became IsoS', isolB.shopName, 'IsoS');
  assertEq('isolated shop edit: slot A playerName unchanged', isolA.playerName, slotABefore.playerName);
  assertEq('isolated shop edit: slot A townName unchanged', isolA.townName, slotABefore.townName);
  assertEq('isolated shop edit: slot B playerName unchanged', isolB.playerName, slotBBefore.playerName);
  assertEq('isolated shop edit: slot B townName unchanged', isolB.townName, slotBBefore.townName);

  const SLOT_A_BASE = 0x100;
  for (let i = 0; i < 10; i++) {
    const orig = parseBefore.wrapper.payload[SLOT_A_BASE + 0x47e + i];
    const after = isolResult.payload[SLOT_A_BASE + 0x47e + i];
    if (orig !== after) {
      console.error(`FAIL: isolated shop edit corrupted town byte at slot A body 0x47E+${i}: 0x${orig.toString(16)} -> 0x${after.toString(16)}`);
      failures++;
    }
  }
  for (let i = 0; i < 22; i++) {
    const orig = parseBefore.wrapper.payload[SLOT_A_BASE + 0x1149c + i];
    const after = isolResult.payload[SLOT_A_BASE + 0x1149c + i];
    if (orig !== after) {
      console.error(`FAIL: isolated shop edit corrupted player byte at slot A body 0x1149C+${i}: 0x${orig.toString(16)} -> 0x${after.toString(16)}`);
      failures++;
    }
  }
  console.log('PASS: byte-level check — town (0x47E) and player (0x1149C) fields untouched by shop edit');
}

console.log('\n--- step-258: per-field isolation (town edit must not touch player/shop) ---');
{
  const isolEdits = [{ kind: 'town_name', value: 'IsoT' }];
  const isolResult = editor.applyEdits(parseBefore.wrapper.payload, isolEdits);
  const isolParse = await parser.parseSaveFile(isolResult.payload);
  const isolA = isolParse.slotA;
  const isolB = isolParse.slotB;

  assertEq('isolated town edit: slot A townName became IsoT', isolA.townName, 'IsoT');
  assertEq('isolated town edit: slot B townName became IsoT', isolB.townName, 'IsoT');
  assertEq('isolated town edit: slot A playerName unchanged', isolA.playerName, slotABefore.playerName);
  assertEq('isolated town edit: slot A shopName unchanged', isolA.shopName, slotABefore.shopName);
  assertEq('isolated town edit: slot B playerName unchanged', isolB.playerName, slotBBefore.playerName);
  assertEq('isolated town edit: slot B shopName unchanged', isolB.shopName, slotBBefore.shopName);

  const SLOT_A_BASE = 0x100;
  for (let i = 0; i < 12; i++) {
    const orig = parseBefore.wrapper.payload[SLOT_A_BASE + 0x114b2 + i];
    const after = isolResult.payload[SLOT_A_BASE + 0x114b2 + i];
    if (orig !== after) {
      console.error(`FAIL: isolated town edit corrupted shop byte at slot A body 0x114B2+${i}: 0x${orig.toString(16)} -> 0x${after.toString(16)}`);
      failures++;
    }
  }
  for (let i = 0; i < 22; i++) {
    const orig = parseBefore.wrapper.payload[SLOT_A_BASE + 0x1149c + i];
    const after = isolResult.payload[SLOT_A_BASE + 0x1149c + i];
    if (orig !== after) {
      console.error(`FAIL: isolated town edit corrupted player byte at slot A body 0x1149C+${i}: 0x${orig.toString(16)} -> 0x${after.toString(16)}`);
      failures++;
    }
  }
  console.log('PASS: byte-level check — shop (0x114B2) and player (0x1149C) fields untouched by town edit');
}

// If submission #16 is available, run the same byte-level isolation
// check against ITS bytes — the empirical anchor where the three fields
// hold genuinely distinct strings means a regression to mirror-writes
// would show up as obvious cross-contamination.
if (save16Parse && save16Parse.wrapper.payload) {
  console.log('\n--- step-258: per-field isolation against submission #16 (distinct names) ---');
  const s16Active = save16Parse.activeSlot === 'A' ? save16Parse.slotA : save16Parse.slotB;
  // Apply only a player edit and confirm shop ("Shop Weasleys") + town
  // ("HOGSMEADE") survive intact in the active slot.
  const isolEdits = [{ kind: 'player_name', value: 'Harry' }];
  const isolResult = editor.applyEdits(save16Parse.wrapper.payload, isolEdits);
  const isolParse = await parser.parseSaveFile(isolResult.payload);
  const isolActive = isolParse.activeSlot === 'A' ? isolParse.slotA : isolParse.slotB;
  assertEq('save #16 isolated player edit: playerName = Harry', isolActive.playerName, 'Harry');
  assertEq('save #16 isolated player edit: shopName still = "Shop Weasleys"', isolActive.shopName, 'Shop Weasleys');
  assertEq('save #16 isolated player edit: townName still = "HOGSMEADE"', isolActive.townName, 'HOGSMEADE');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
