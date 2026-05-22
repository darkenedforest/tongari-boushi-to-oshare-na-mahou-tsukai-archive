// End-to-end round-trip test for the in-browser save editor.
//
// 1. Load the test save file from disk.
// 2. Run the same parseSaveFile() the React inspector runs, snapshot.
// 3. Apply a set of edits via applyEdits() — covers every new feature:
//    - school_name
//    - player_name (5 chars, the §22 cap)
//    - catalog (text edit at one slot)
//    - catalog_clear (remove at another slot)
//    - ritch (to confirm we didn't break the previously-working path)
// 4. Re-wrap as .dsv and reparse.
// 5. Assert the edits round-trip cleanly: read-back values match what
//    we wrote, untouched fields are preserved, and all three checksum
//    levels pass on the re-parsed save.
//
// Run with:
//   ./node_modules/.bin/esbuild --bundle --platform=node --format=esm \
//     --outfile=/tmp/savefile-bundle.mjs scripts/test_savefile_roundtrip.mjs \
//     && node /tmp/savefile-bundle.mjs
//
// (The bundle step resolves the bare TypeScript imports that the in-
// browser source uses. Node can't resolve `./parser` -> `./parser.ts`
// natively without bundling.)

import fs from 'node:fs';
import path from 'node:path';

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

// ---------------------------------------------------------------------------
// Plan the edits
// ---------------------------------------------------------------------------

const targetCatalogEdit = slotABefore.catalogEntries[1];  // entry #2
const targetCatalogRemove = slotABefore.catalogEntries[3]; // entry #4

const edits = [
  { kind: 'player_name', value: 'ABEL' },         // 4 chars, within 5-char §22 cap
  { kind: 'school_name', value: 'Magus' },        // 5 chars, within 6-char §5 cap
  { kind: 'ritch', value: 42424 },
  { kind: 'catalog', entryOffset: targetCatalogEdit.bodyOffset, text: 'STAGE-2-EDITED\nHello world!\nThis is a round-trip test.' },
  { kind: 'catalog_clear', entryOffset: targetCatalogRemove.bodyOffset },
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
const slotBAfter = parseAfter.slotB;
console.log(`  player name: ${JSON.stringify(slotBAfter.playerName)}`);
console.log(`  school name: ${JSON.stringify(slotBAfter.schoolName)}`);
console.log(`  ritch: ${slotBAfter.ritch}`);
console.log(`  header csum ok: ${slotBAfter.checksum.ok}`);
console.log(`  body csum ok:   ${slotBAfter.bodyChecksum.ok}`);
console.log(`  extra0 csum ok: ${slotBAfter.extra0Checksum.ok}`);

// ---------------------------------------------------------------------------
// Assertions
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

console.log('\n--- Assertions ---');
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

// Catalog edit round-trip: the entry at targetCatalogEdit.bodyOffset
// should read back exactly the edited text. Look up by bodyOffset.
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

// Catalog remove round-trip: the entry at targetCatalogRemove.bodyOffset
// should NOT appear in slotAAfter.catalogEntries (parser's plausible-
// text + nontrivial-bytes filter skips fully-cleared slots).
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

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
