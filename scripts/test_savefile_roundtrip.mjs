// End-to-end round-trip test for the in-browser save editor.
//
// 1. Load the test save file from disk.
// 2. Run the same parseSaveFile() the React inspector runs, snapshot.
// 3. Apply a set of edits via applyEdits() — covers every edit kind:
//    - school_name
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
console.log(`wrapper kind: ${parseBefore.wrapper.kind}`);
const slotABefore = parseBefore.slotA;
const slotBBefore = parseBefore.slotB;
console.log(`slot A:`);
console.log(`  player name: ${JSON.stringify(slotABefore.playerName)}`);
console.log(`  player name canonical (§22 copy): ${JSON.stringify(slotABefore.playerNameCanonical)}`);
console.log(`  school name: ${JSON.stringify(slotABefore.schoolName)}`);
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

console.log('\n--- Parse assertions (slot B inventory bag) ---');
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
  const bagSlot = slotBBefore.inventoryBag[exp.slot - 1];
  assertEq(
    `slot B inv slot ${exp.slot}: storedValue`,
    bagSlot.storedValue,
    exp.storedValue,
  );
  assertEq(
    `slot B inv slot ${exp.slot}: empty=false`,
    bagSlot.empty,
    false,
  );
  assertEq(
    `slot B inv slot ${exp.slot}: quantity`,
    bagSlot.quantity,
    exp.quantity,
  );
  const iid = iidByStored(bagSlot.storedValue);
  const name = iid !== null ? nameByIid(iid) : null;
  assertEq(
    `slot B inv slot ${exp.slot}: iid→name`,
    name,
    exp.expectedName,
  );
}
// Slots 8..14 should be the empty sentinel.
for (const idx of [8, 9, 10, 11, 12, 13, 14]) {
  const bagSlot = slotBBefore.inventoryBag[idx - 1];
  assertEq(
    `slot B inv slot ${idx}: empty=true`,
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
  { kind: 'player_name', value: 'ABEL' },         // 4 chars, within 5-char §22 cap
  { kind: 'school_name', value: 'Magus' },        // 5 chars, within 6-char §5 cap
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
console.log(`  player name canonical (§22 copy): ${JSON.stringify(slotAAfter.playerNameCanonical)}`);
console.log(`  school name: ${JSON.stringify(slotAAfter.schoolName)}`);
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
console.log(`  school name: ${JSON.stringify(slotBAfter.schoolName)}`);
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
assertEq('slot A player name canonical (§22 copy) after = ABEL', slotAAfter.playerNameCanonical, 'ABEL');
assertEq('slot A school name after = Magus', slotAAfter.schoolName, 'Magus');
assertEq('slot A ritch after = 42424', slotAAfter.ritch, 42424);
assertEq('slot B player name after = ABEL', slotBAfter.playerName, 'ABEL');
assertEq('slot B school name after = Magus', slotBAfter.schoolName, 'Magus');
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

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
