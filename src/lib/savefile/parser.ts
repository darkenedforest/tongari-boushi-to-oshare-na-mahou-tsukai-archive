// Pure parsing functions for Tongari Boushi save files. All work happens
// in-browser on a Uint8Array — nothing is uploaded, nothing is persisted
// server-side.
//
// Implementation mirrors the Python references at
//   src/translator/_savefile_inspect.py
//   src/translator/_savefile_edit.py
// in the translation repo. See `notes/savefile_format.md` for the field
// map this code is based on (step-173 / 176 / 177 reverse-engineering).

import type {
  ActivityRecord,
  BankRecord,
  CatalogEntry,
  ChecksumInfo,
  CollectionStatRecord,
  DateTimeInfo,
  EventFlagSummary,
  GardenSummary,
  InventoryBitmapEntry,
  InventoryBitmapSummary,
  InventorySlot,
  MailEntry,
  NpcRecord,
  PreambleInfo,
  ResidentInfo,
  SaveParse,
  SlotLabel,
  SlotParse,
  WizardLevelCandidate,
  WrapperInfo,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RAW_SIZE = 0x80000; // 524288 bytes
export const DSV_FOOTER_LEN = 122;
const DSV_FOOTER_MAGIC_STR = '|-DESMUME SAVE-|';

const SLOT_A_BASE = 0x100;
const SLOT_B_BASE = 0x40000;
const SLOT_BODY_LEN = 0x40000 - 0x100; // slot A body length (slot B is 0x40000 bytes)

const HEADER_LEN = 0x14;
/** Length of the body region covered by the body-level RFC1071 checksum:
 *  body[0x14 .. 0x14 + 0x1CDDC]. Confirmed via _savefile_validate_all.py:
 *  matches the stored body csum at body[0x14:0x16] across 53/55 saves in
 *  the corpus. */
const BODY_CSUM_LEN = 0x1cddc;
const FORMAT_MAGIC = 0x0161;

// Offsets are all relative to the slot body start.
export const OFFSETS = {
  // Header (0x00..0x14)
  checksum: 0x00,
  formatMagic: 0x02,
  activeFlag: 0x06,
  otherSlotByte: 0x07,
  /** Stored u16 LE body-level RFC1071 checksum (covers body[0x14..0x14+0x1CDDC]
   *  with body[0x14:0x16] zeroed). Predecessor's section-34 claim that there
   *  is "no body-wide CRC" was rejected by step-219 / step-220, and confirmed
   *  again by step-223 _savefile_validate_all.py against 53/55 saves. */
  bodyChecksum: 0x14,
  /** Body-level format version sub-code (0x0900 = v2.31, 0x102C = 3DS dump). */
  formatSubcode: 0x16,
  // Predecessor used the name `perSaveFingerprint` for body[0x14:0x16]; we
  // keep the alias here so the rest of the parse code that reads it as a
  // u16 still works, but the canonical interpretation is "body checksum
  // word" — modifying any byte in body[0x14..] invalidates this u16.
  perSaveFingerprint: 0x14,

  // Event flag region
  eventFlagsStart: 0x18,
  eventFlagsEnd: 0x460,

  // Player + school name (body 0x460..0x4B0). step-250 reclassification:
  // body 0x47E was previously labelled "player name", but Tyler's
  // melonDS-confirmed save14 reveals it's actually the SCHOOL name
  // (the title shown on the save-load screen — save14 shows "Revere"
  // here while the in-dialog player name is "Lamb"). The real player
  // display name lives inside the character record at body 0x11488 +
  // 0x14 = body 0x1149C, per phase-7's character-record decode.
  schoolName: 0x47e,
  schoolNameLen: 12, // 6 UTF-16 LE chars (max)
  lastSaveTs: 0x494,
  charCreateTs: 0x4a4,

  /** Body offset of the player's display name (inside the character
   *  record at body 0x11488, intra offset +0x14). Verified against
   *  save14: "Lamb" sits at body 0x1149C. Length 0x16 = 11 UTF-16
   *  LE chars max per phase-7. */
  playerName: 0x1149c,
  playerNameLen: 22, // 11 UTF-16 LE chars (per phase-7 layout)

  // Unconfirmed region — body[0x4300..0x4480], stride 8. Previously
  // (step-176/177) labelled "active inventory" with a (cat<<8)|sub
  // decomposition. step-232 rejected that framework: no ARM9 accessor
  // touches this offset and the lone "confirmed" mapping
  // (cat=2,sub=6)->1887 (Transmitter) was an artifact of misreading a
  // u16 LE item ID as a packed (cat,sub) tuple. The raw bytes are still
  // surfaced for research purposes; their semantics are unknown.
  // See notes/save_analysis/_blockers.md (step-232) in the translation
  // repo for the rejection trail.
  activeInvStart: 0x4300,
  activeInvEnd: 0x4480,
  activeInvSlotSize: 8,

  // Activity log
  activityLogStart: 0x0b500,
  activityLogEnd: 0x0b900,
  activityRecordSize: 9,

  // Collection statistics
  collectionStatsStart: 0x11550,
  collectionStatsEnd: 0x115f4,
  collectionStatsRecordSize: 14,

  // 4×1080-byte character records (0x11488 .. 0x1257C). record[0] is the
  // player's character record; records[1..3] are reserved (always zero).
  // step-223 validation confirmed the first 20 bytes of record[0] are NOT
  // the player display name — phase-7's claim there was wrong; the real
  // display name lives at body 0x47E. Inside record[0] the byte at +0x5a
  // is the documented WIZARD-LEVEL CANDIDATE per phase 7. In our 55-save
  // corpus the byte was 0x00 in every initialized save, so the candidate
  // is shown READ-ONLY with a "please test" caveat — we do NOT promote it
  // to confirmed yet.
  characterRecordsStart: 0x11488,
  characterRecordSize: 0x438,
  characterRecordCount: 4,
  /** Offset within record[0] of the wizard-level candidate byte. */
  wizardLevelCandidateOffset: 0x5a,

  // NPC relationship records
  npcRecordsStart: 0x119c0,
  // We bound the dump at the wardrobe-table boundary so we don't run
  // off into garden territory.
  npcRecordsEnd: 0x12400,
  // The NPC records pack at variable strides; we sample at a generous
  // 0x500 stride for the inspector's purposes (matches what the dump
  // tool produces). This is preview-only — full semantics aren't pinned.
  npcRecordStride: 0x500,

  // Garden tiles. Predecessor said 0x12414; step-223 _savefile_validate_all
  // proved that's INSIDE the 4×1080 char-record array (which occupies
  // 0x11488..0x1257C). The validator's plant-pattern score peaks at the
  // first 12-byte stride AFTER the character-records end. We use 0x12568
  // because it wins the per-save score race on upload_12 (the most
  // populated save in the corpus); the character-records end at 0x1257C
  // and 0x12568 sits 0x14 bytes earlier — that overlap is OK because the
  // last reserved char record is all-zero, so we count 0 plant tiles
  // there.
  gardenStart: 0x12568,
  gardenEnd: 0x16000,
  gardenRecordSize: 12,

  // Catalog announcements. Predecessor said 0x163F2; phase 7 corrected to
  // 0x162BC. step-223 confirmed neither is exactly right: a stride-0xA8
  // scan that anchors on the "こんしゅう" catalog template proves the true
  // entry-0 start is 0x162B6. The 0x162BC the brief mentioned points 6
  // bytes into entry 0 (between the entry's 8-byte metadata header and
  // its text body). We use 0x162B6 so the 8-byte header decoded by the
  // entry-text scanner lines up with the on-disk record layout.
  catalogStart: 0x162b6,
  catalogEnd: 0x17400,
  catalogStride: 0xa8,

  // Per-NPC mail bodies
  mailStart: 0x17400,
  mailEnd: 0x1cfd0,
  mailStride: 0xa8,

  // Wallet
  ritch: 0x1cfd0,

  // Bank transaction log
  bankStart: 0x1cfd4,
  bankEnd: 0x1e0e0,
  bankRecordSize: 6,

  // Town residents
  residentsStart: 0x1e0e0,
  residentsRecordSize: 0x22f8,
  residentsMax: 8,

  // Inventory bitmap (step-237). 173-bit packed bitmap inside the
  // FAMILY-C extra-record [0] at save_buffer_C + 2. Bit 0..139 = clothing
  // (item_ids 1000..1139), bit 140..172 = garden decorations (item_ids
  // 2000..2032). Bits 173..175 are unused padding (always read by the
  // game's bit-getter but ignored because max=173 bounds-check trips).
  // ARM9 evidence: setter at 0x0201B56C calls 0x0201BCB0(base=svC+2,
  // max=173) which calls 0x02006E44 (bit-set primitive).
  inventoryBitmapStart: 0x1cdf2,
  inventoryBitmapLen: 22,
  inventoryBitmapBitCount: 173,
} as const;

/** Per-category metadata for the inventory bitmap. Hard-coded to match
 *  the ARM9 tables at 0x020A1660 (per-cat item_id base) and 0x020A1670
 *  (per-cat count). The bitmap only covers cats 0 and 1; cats 2 and 3
 *  are stored in other save regions. */
const INVENTORY_BITMAP_CATEGORIES = [
  { id: 0, itemIdBase: 1000, count: 140, bitIndexBase: 0 },
  { id: 1, itemIdBase: 2000, count: 33, bitIndexBase: 140 },
] as const;

/** Body-level RFC1071 checksum range length. Exported because the editor
 *  also needs it when recomputing after edits. */
export const BODY_CSUM_RANGE_LEN = BODY_CSUM_LEN;

/** Slot-relative offset of extra[0] (the per-slot Family-C meta record).
 *  File offset = SLOT_A_BASE + EXTRA0_OFFSET = 0x01CEF0 for slot A and
 *  SLOT_B_BASE + EXTRA0_OFFSET = 0x05CDF0 for slot B. Confirmed step-234
 *  via empirical csum verification on 36/36 initialised slots. */
export const EXTRA0_OFFSET = 0x1cdf0;

/** Length of the extra[0] record AND the RFC1071 csum range over it.
 *  Stored u16 LE at extra[0][0:2] over extra[0][0..0x22F8] with the first
 *  2 bytes zeroed. */
export const EXTRA0_LEN = 0x22f8;

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += b[i].toString(16).padStart(2, '0');
  }
  return s;
}

function u16le(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32le(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Decode up to `maxChars` UTF-16 LE characters from `data` starting at
 *  byte offset 0, stopping at the first NUL pair. */
function decodeUtf16Le(data: Uint8Array, maxChars: number): string {
  const decoder = new TextDecoder('utf-16le');
  // Trim to maxChars * 2 bytes, then stop at first null pair.
  const len = Math.min(maxChars * 2, data.length);
  let end = len;
  for (let i = 0; i + 1 < len; i += 2) {
    if (data[i] === 0 && data[i + 1] === 0) {
      end = i;
      break;
    }
  }
  if (end === 0) return '';
  return decoder.decode(data.subarray(0, end));
}

/** RFC1071 Internet Checksum — 16-bit one's-complement folded sum, then
 *  bitwise NOT. Reproduces ARM9 0x02078A0C exactly. */
export function inetCsum16(data: Uint8Array): number {
  const n = data.length;
  let r = 0;
  let i = 0;
  const pairs = n >> 1;
  for (let p = 0; p < pairs; p++) {
    r += data[i] | (data[i + 1] << 8);
    i += 2;
  }
  if (n & 1) {
    r += data[i];
  }
  r = (r & 0xffff) + (r >>> 16);
  r = (r & 0xffff) + (r >>> 16);
  return ~r & 0xffff;
}

/** True if every byte in `view` equals `b`. */
function allBytesEqual(view: Uint8Array, b: number): boolean {
  for (let i = 0; i < view.length; i++) {
    if (view[i] !== b) return false;
  }
  return true;
}

/** Count of set bits across `view`. */
function popcountBytes(view: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < view.length; i++) {
    let x = view[i];
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    x = (x + (x >> 4)) & 0x0f;
    count += x;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Wrapper detection
// ---------------------------------------------------------------------------

const DSV_FOOTER_MAGIC_BYTES = new TextEncoder().encode(DSV_FOOTER_MAGIC_STR);

function endsWithDsvMagic(buf: Uint8Array): boolean {
  if (buf.length < DSV_FOOTER_MAGIC_BYTES.length) return false;
  const tail = buf.subarray(buf.length - DSV_FOOTER_MAGIC_BYTES.length);
  for (let i = 0; i < DSV_FOOTER_MAGIC_BYTES.length; i++) {
    if (tail[i] !== DSV_FOOTER_MAGIC_BYTES[i]) return false;
  }
  return true;
}

export function detectWrapper(file: Uint8Array): WrapperInfo {
  const originalSize = file.length;
  if (originalSize === RAW_SIZE) {
    return {
      originalSize,
      kind: 'raw',
      payload: file,
      footerHex: null,
      error: null,
    };
  }
  if (originalSize === RAW_SIZE + DSV_FOOTER_LEN && endsWithDsvMagic(file)) {
    const payload = file.subarray(0, RAW_SIZE);
    const footer = file.subarray(RAW_SIZE);
    return {
      originalSize,
      kind: 'dsv',
      payload,
      footerHex: bytesToHex(footer),
      error: null,
    };
  }
  return {
    originalSize,
    kind: 'unknown',
    payload: null,
    footerHex: null,
    error: `Unrecognised save size ${originalSize} bytes. Expected ${RAW_SIZE} (raw EEPROM) or ${RAW_SIZE + DSV_FOOTER_LEN} (DeSmuME .dsv with 122-byte footer).`,
  };
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

export async function sha256Hex(buf: Uint8Array): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return '';
  // Coerce to a fresh ArrayBuffer to satisfy strict typings.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  const hash = await crypto.subtle.digest('SHA-256', ab);
  return bytesToHex(new Uint8Array(hash));
}

// ---------------------------------------------------------------------------
// Preamble
// ---------------------------------------------------------------------------

// 8 codepoints: U+3068 U+3093 U+304C U+308A U+3000 U+FF12 U+FF0E U+FF15
// → "とんがり" + ideographic space + "２．５" (fullwidth digits + period).
// The savefile_format.md doc shows it bracketed as 「とんがり ２．５」, but the
// raw EEPROM bytes contain no 「 」 corners — the brackets are a doc
// convention only. Match the actual on-disk title.
const EXPECTED_TITLE = 'とんがり　２．５';

export function parsePreamble(payload: Uint8Array): PreambleInfo {
  const titleBytes = payload.subarray(0, 16);
  const title = decodeUtf16Le(titleBytes, 8);
  const ctr = payload[0x10];
  const mirror = payload[0x11];
  return {
    titleMagic: title,
    titleMagicOk: title === EXPECTED_TITLE,
    saveGenCounter: ctr,
    saveGenCounterMirror: mirror,
    counterPaired: ctr === mirror,
  };
}

// ---------------------------------------------------------------------------
// Header / checksum
// ---------------------------------------------------------------------------

function verifyHeaderChecksum(body: Uint8Array): ChecksumInfo {
  const header = body.slice(0, HEADER_LEN);
  const stored = header[0] | (header[1] << 8);
  header[0] = 0;
  header[1] = 0;
  const computed = inetCsum16(header);
  return {
    storedHex: '0x' + stored.toString(16).padStart(4, '0'),
    computedHex: '0x' + computed.toString(16).padStart(4, '0'),
    ok: stored === computed,
  };
}

/** Verify the body-level RFC1071 checksum at body[0x14:0x16] over
 *  body[0x14 .. 0x14 + 0x1CDDC] with body[0x14:0x16] zeroed.
 *
 *  Phase-7 step-219 discovered this checksum; predecessor's section-34
 *  claim of "single header-only integrity check, no body-wide CRC" was
 *  wrong. step-223 confirms this is required for any editor that writes
 *  beyond body[0x14] — the slot-header csum alone is NOT enough. */
function verifyBodyChecksum(body: Uint8Array): ChecksumInfo {
  if (body.length < OFFSETS.bodyChecksum + BODY_CSUM_LEN) {
    return { storedHex: '0xffff', computedHex: '0xffff', ok: false };
  }
  // Copy out the covered region (we have to zero the first two bytes
  // before computing).
  const region = body.slice(OFFSETS.bodyChecksum, OFFSETS.bodyChecksum + BODY_CSUM_LEN);
  const stored = region[0] | (region[1] << 8);
  region[0] = 0;
  region[1] = 0;
  const computed = inetCsum16(region);
  return {
    storedHex: '0x' + stored.toString(16).padStart(4, '0'),
    computedHex: '0x' + computed.toString(16).padStart(4, '0'),
    ok: stored === computed,
  };
}

/** Verify the extra[0] RFC1071 checksum at extra[0][0:2] over
 *  extra[0][0..0x22F8] with the first 2 bytes zeroed.
 *
 *  extra[0] starts at slot-relative 0x1CDF0 (file 0x01CEF0 for slot A,
 *  0x05CDF0 for slot B) and is exactly 0x22F8 bytes long. Ritch
 *  (slot+0x1CFD0 = extra[0]+0x1E0) lives inside this region. step-234
 *  discovered the previous editor.ts did NOT recompute this csum after
 *  Ritch edits, producing saves the game refuses to load; this verify
 *  surfaces it in the UI so the same regression is caught visually. */
function verifyExtra0Checksum(body: Uint8Array): ChecksumInfo {
  if (body.length < EXTRA0_OFFSET + EXTRA0_LEN) {
    return { storedHex: '0xffff', computedHex: '0xffff', ok: false };
  }
  const region = body.slice(EXTRA0_OFFSET, EXTRA0_OFFSET + EXTRA0_LEN);
  const stored = region[0] | (region[1] << 8);
  region[0] = 0;
  region[1] = 0;
  const computed = inetCsum16(region);
  return {
    storedHex: '0x' + stored.toString(16).padStart(4, '0'),
    computedHex: '0x' + computed.toString(16).padStart(4, '0'),
    ok: stored === computed,
  };
}

// ---------------------------------------------------------------------------
// Datetime
// ---------------------------------------------------------------------------

function decodeDatetime(bytes: Uint8Array): DateTimeInfo {
  const rawHex = bytesToHex(bytes);
  if (bytes.length < 6) return { rawHex, decoded: '?' };
  // Unset checks: all-FF, all-zero, or leading FF.
  const y = bytes[0];
  const m = bytes[1];
  const d = bytes[2];
  const h = bytes[3];
  const mn = bytes[4];
  const s = bytes[5];
  if (y === 0xff || (y === 0 && m === 0 && d === 0)) {
    return { rawHex, decoded: '(unset)' };
  }
  const yyyy = 2000 + y;
  const pad = (n: number) => n.toString(10).padStart(2, '0');
  return {
    rawHex,
    decoded: `${yyyy}-${pad(m)}-${pad(d)} ${pad(h)}:${pad(mn)}:${pad(s)}`,
  };
}

// ---------------------------------------------------------------------------
// Inventory bitmap (step-237 — the REAL inventory)
// ---------------------------------------------------------------------------

/** Parse the 173-bit packed bitmap at slot_rel 0x1CDF2 (= save_buffer_C+2)
 *  into a list of owned (cat, sub_index, item_id) entries.
 *
 *  Bit-packing is standard LSB-first within each byte:
 *  `byte_offset = bit_index / 8`, `mask = 1 << (bit_index & 7)`.
 *  Bit indices 0..139 are cat 0 (clothing item_ids 1000..1139); 140..172
 *  are cat 1 (garden decoration item_ids 2000..2032); 173..175 are
 *  always read by the byte-level get/set primitive but the game's
 *  bounds-checked dispatcher (max=173) ignores them.
 *
 *  ARM9 evidence: setter at 0x0201B56C, primitives at 0x02006E44/E5C,
 *  bounds dispatcher at 0x0201BCB0. See translation repo at
 *  `notes/save_analysis/_inventory_found.md` for the full trace.
 */
function parseInventoryBitmap(body: Uint8Array): InventoryBitmapSummary {
  const start = OFFSETS.inventoryBitmapStart;
  const len = OFFSETS.inventoryBitmapLen;
  const region = body.subarray(start, start + len);
  // Total bits set across all 22 bytes (including the 3 padding bits).
  let totalBitsSet = 0;
  for (let i = 0; i < region.length; i++) {
    let x = region[i];
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    x = (x + (x >> 4)) & 0x0f;
    totalBitsSet += x;
  }
  // Walk the meaningful range and decode owned-item entries.
  const entries: InventoryBitmapEntry[] = [];
  let ownedBitsSet = 0;
  for (const cat of INVENTORY_BITMAP_CATEGORIES) {
    for (let sub = 0; sub < cat.count; sub++) {
      const bitIndex = cat.bitIndexBase + sub;
      const byte = region[bitIndex >> 3];
      if (byte === undefined) continue;
      const set = (byte >> (bitIndex & 7)) & 1;
      if (!set) continue;
      ownedBitsSet++;
      entries.push({
        bitIndex,
        category: cat.id,
        subIndex: sub,
        itemId: cat.itemIdBase + sub,
      });
    }
  }
  return {
    totalBitsSet,
    ownedBitsSet,
    entries,
    rawHex: bytesToHex(region),
  };
}

// ---------------------------------------------------------------------------
// Inventory (legacy body+0x4300 region — DISPUTED, see step-232/237)
// ---------------------------------------------------------------------------

function parseActiveInventory(body: Uint8Array, view: DataView): InventorySlot[] {
  const slots: InventorySlot[] = [];
  for (
    let off = OFFSETS.activeInvStart;
    off < OFFSETS.activeInvEnd;
    off += OFFSETS.activeInvSlotSize
  ) {
    const word = u16le(view, off);
    if (word === 0x0000 || word === 0xffff) continue;
    const category = (word >> 8) & 0xff;
    const subIndex = word & 0xff;
    const trailing = body.subarray(off + 2, off + 8);
    slots.push({
      bodyOffset: off,
      category,
      subIndex,
      trailingHex: bytesToHex(trailing),
    });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Residents
// ---------------------------------------------------------------------------

function parseResidents(body: Uint8Array): ResidentInfo[] {
  const out: ResidentInfo[] = [];
  for (let i = 0; i < OFFSETS.residentsMax; i++) {
    const start = OFFSETS.residentsStart + i * OFFSETS.residentsRecordSize;
    if (start + 0x20 > body.length) break;
    const head = body.subarray(start, start + 16);
    const previewSlice = body.subarray(start, start + 32);
    let state: 'uninit' | 'vacant' | 'active';
    let name = '';
    if (allBytesEqual(head, 0xff)) {
      state = 'uninit';
    } else if (allBytesEqual(head, 0x00)) {
      state = 'vacant';
    } else {
      state = 'active';
      name = decodeUtf16Le(head, 8);
    }
    out.push({
      index: i,
      bodyOffset: start,
      state,
      name,
      previewHex: bytesToHex(previewSlice),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Catalog announcements
// ---------------------------------------------------------------------------

/** Heuristic: does this UTF-16 LE decoded string contain enough plausible
 *  text to be worth surfacing? Used to filter the strided text scanners
 *  (catalog announcements, mail bodies) so we don't show pages of
 *  mojibake from empty regions where the underlying bytes happen to be
 *  non-null but aren't real text. */
function looksLikePlausibleText(s: string): boolean {
  if (s.length < 3) return false;
  let plausible = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i) ?? 0;
    // ASCII printable
    if (cp >= 0x20 && cp <= 0x7e) {
      plausible++;
      continue;
    }
    // Hiragana / Katakana / CJK Unified Ideographs / Halfwidth-Fullwidth /
    // Ideographic space, common Japanese punctuation
    if (
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0x3040 && cp <= 0x309f) ||
      (cp >= 0x30a0 && cp <= 0x30ff) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xff00 && cp <= 0xffef) ||
      cp === 0x2026 || // …
      cp === 0x2605 || // ★
      cp === 0x266a || // ♪
      cp === 0x266b
    ) {
      plausible++;
    }
  }
  // Demand >=60% plausible, and at least 3 plausible chars total.
  return plausible >= 3 && plausible * 5 >= s.length * 3;
}

function parseStridedTextEntries(
  body: Uint8Array,
  start: number,
  end: number,
  stride: number,
  headerLen: number,
): { index: number; bodyOffset: number; text: string; headerHex: string }[] {
  const out: { index: number; bodyOffset: number; text: string; headerHex: string }[] = [];
  let idx = 0;
  for (let off = start; off + stride <= end && off + stride <= body.length; off += stride) {
    const entry = body.subarray(off, off + stride);
    // Skip purely-empty entries (all 0xFF or all 0x00 or all 0x77 padding).
    if (allBytesEqual(entry, 0xff) || allBytesEqual(entry, 0x00)) {
      idx++;
      continue;
    }
    // Quick reject: if the post-header region has fewer than 4 non-zero,
    // non-0xFF bytes, treat this entry as empty.
    const textSpace = entry.subarray(headerLen);
    let nontrivialBytes = 0;
    for (let i = 0; i < textSpace.length; i++) {
      const b = textSpace[i];
      if (b !== 0x00 && b !== 0xff) nontrivialBytes++;
    }
    if (nontrivialBytes < 4) {
      idx++;
      continue;
    }
    const header = entry.subarray(0, headerLen);
    const text = decodeUtf16Le(textSpace, Math.floor(textSpace.length / 2));
    if (!looksLikePlausibleText(text)) {
      idx++;
      continue;
    }
    out.push({
      index: idx,
      bodyOffset: off,
      text,
      headerHex: bytesToHex(header),
    });
    idx++;
  }
  return out;
}

function parseCatalog(body: Uint8Array): CatalogEntry[] {
  // step-249: catalog records use a 6-byte header (status + date),
  // not 8. Empirical verification against save14_v2.31_11772ritch:
  // with headerLen=8 the parser truncated "Sorry I left without..."
  // to "orry I left without..." (lost the leading "S"). The on-disk
  // layout, per per-record dump, is:
  //   +0x00..+0x05: 6-byte header (00 00 status-byte 04 month day)
  //   +0x06..+0x86: main UTF-16 LE body text (max ~64 chars)
  //   +0x88..+0xA7: trailing sender / addressee NPC name (UTF-16 LE)
  return parseStridedTextEntries(
    body,
    OFFSETS.catalogStart,
    OFFSETS.catalogEnd,
    OFFSETS.catalogStride,
    6,
  );
}

function parseMail(body: Uint8Array): MailEntry[] {
  // step-249: mail bodies use the same 6-byte header structure as catalog
  // entries. With headerLen=8 the inspector rendered the last 10 bytes
  // of a record (e.g. "iva" — tail of "Aint no diva" in save14). Going
  // to 6 surfaces the full text body. Note that the mail-region bytes in
  // our corpus look more like shop/NPC metadata than free-form letters
  // for many records — the inspector will still show few populated rows
  // even after the fix because most slots are genuinely empty.
  return parseStridedTextEntries(
    body,
    OFFSETS.mailStart,
    OFFSETS.mailEnd,
    OFFSETS.mailStride,
    6,
  );
}

// ---------------------------------------------------------------------------
// NPC records
// ---------------------------------------------------------------------------

function parseNpcRecords(body: Uint8Array): NpcRecord[] {
  // step-249: these records do NOT store inline UTF-16 NPC names. Per-save
  // dumps at body 0x119C0+0x500*N show packed ID/state bytes (e.g.
  // `07 13 00 00 00 00 00 00 00 00 00 00 00 ff 00 00 44 61 ...`) — no
  // UTF-16 LE name field exists at +0x00. The previous decoder produced
  // single-character garbage like "ጇ" by reinterpreting two state bytes
  // as a UTF-16 codepoint, so we now treat every populated record as
  // name-less and surface only the raw bytes. A future revision can add
  // an NPC-ID-to-name lookup once the record's ID-field offset is pinned.
  const out: NpcRecord[] = [];
  let idx = 0;
  for (
    let off = OFFSETS.npcRecordsStart;
    off + 0x30 <= OFFSETS.npcRecordsEnd && off + 0x30 <= body.length;
    off += OFFSETS.npcRecordStride
  ) {
    const head = body.subarray(off, off + 16);
    const preview = body.subarray(off + 16, off + 48);
    const uninit = allBytesEqual(head, 0xff);
    const vacant = allBytesEqual(head, 0x00);
    // step-249: intentionally NOT decoding `head` as UTF-16 — that
    // produced mojibake on every save in our corpus. The first 16
    // bytes are packed state bytes, not a UTF-16 name field. We leave
    // `name` empty so the inspector renders "(empty)" honestly.
    const name = '';
    out.push({
      index: idx,
      bodyOffset: off,
      name,
      uninit,
      vacant,
      previewHex: bytesToHex(preview),
    });
    idx++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Garden
// ---------------------------------------------------------------------------

function parseGarden(body: Uint8Array): GardenSummary {
  let total = 0;
  let populated = 0;
  const tiles: import('./types').GardenTile[] = [];
  let idx = 0;
  for (
    let off = OFFSETS.gardenStart;
    off + OFFSETS.gardenRecordSize <= OFFSETS.gardenEnd &&
    off + OFFSETS.gardenRecordSize <= body.length;
    off += OFFSETS.gardenRecordSize
  ) {
    total++;
    const rec = body.subarray(off, off + OFFSETS.gardenRecordSize);
    const isEmpty = allBytesEqual(rec, 0xff) || allBytesEqual(rec, 0x00);
    if (!isEmpty) {
      populated++;
      tiles.push({
        index: idx,
        bodyOffset: off,
        plantId: rec[0],
        growTime: rec[4],
        rawHex: bytesToHex(rec),
      });
    }
    idx++;
  }
  return { totalTiles: total, populatedTiles: populated, tiles };
}

// ---------------------------------------------------------------------------
// Event flags
// ---------------------------------------------------------------------------

function parseEventFlags(body: Uint8Array): EventFlagSummary {
  const region = body.subarray(OFFSETS.eventFlagsStart, OFFSETS.eventFlagsEnd);
  const previewLen = Math.min(64, region.length);
  return {
    totalBytes: region.length,
    setBits: popcountBytes(region),
    previewHex: bytesToHex(region.subarray(0, previewLen)),
  };
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

function parseActivityLog(body: Uint8Array, view: DataView): ActivityRecord[] {
  const out: ActivityRecord[] = [];
  let idx = 0;
  for (
    let off = OFFSETS.activityLogStart;
    off + OFFSETS.activityRecordSize <= OFFSETS.activityLogEnd &&
    off + OFFSETS.activityRecordSize <= body.length;
    off += OFFSETS.activityRecordSize
  ) {
    const rec = body.subarray(off, off + OFFSETS.activityRecordSize);
    const sentinel = allBytesEqual(rec, 0xff);
    out.push({
      index: idx,
      bodyOffset: off,
      headerHex: bytesToHex(rec.subarray(0, 3)),
      dateOrSequence: u32le(view, off + 3),
      countOrState: u16le(view, off + 7),
      sentinel,
    });
    idx++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collection stats
// ---------------------------------------------------------------------------

function parseCollectionStats(body: Uint8Array): CollectionStatRecord[] {
  const out: CollectionStatRecord[] = [];
  let idx = 0;
  for (
    let off = OFFSETS.collectionStatsStart;
    off + OFFSETS.collectionStatsRecordSize <= OFFSETS.collectionStatsEnd &&
    off + OFFSETS.collectionStatsRecordSize <= body.length;
    off += OFFSETS.collectionStatsRecordSize
  ) {
    const rec = body.subarray(off, off + OFFSETS.collectionStatsRecordSize);
    out.push({
      index: idx,
      bodyOffset: off,
      rawHex: bytesToHex(rec),
    });
    idx++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bank log
// ---------------------------------------------------------------------------

function parseBankLog(body: Uint8Array): BankRecord[] {
  const out: BankRecord[] = [];
  let idx = 0;
  for (
    let off = OFFSETS.bankStart;
    off + OFFSETS.bankRecordSize <= OFFSETS.bankEnd &&
    off + OFFSETS.bankRecordSize <= body.length;
    off += OFFSETS.bankRecordSize
  ) {
    const rec = body.subarray(off, off + OFFSETS.bankRecordSize);
    if (!allBytesEqual(rec, 0xff) && !allBytesEqual(rec, 0x00)) {
      out.push({
        index: idx,
        bodyOffset: off,
        rawHex: bytesToHex(rec),
      });
    }
    idx++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wizard-level candidate
// ---------------------------------------------------------------------------

/** Read body[characterRecordsStart + wizardLevelCandidateOffset] (= body
 *  0x11488 + 0x5a). Phase-7 said the per-character init routine writes
 *  0x0a here, hypothesizing "wizard starting level". step-223 validation
 *  found every initialized save in our corpus stores 0x00, NOT the 0x0a
 *  init value. This means EITHER the byte gets cleared by some later code
 *  path, OR the init claim is wrong. We surface the candidate read-only
 *  with a clear "please test" caveat — no edit affordance yet. */
function parseWizardLevelCandidate(body: Uint8Array): WizardLevelCandidate {
  const off = OFFSETS.characterRecordsStart + OFFSETS.wizardLevelCandidateOffset;
  if (off >= body.length) {
    return {
      bodyOffset: off,
      rawByte: 0,
      plausible: false,
      note: 'Out of range — save is shorter than expected.',
    };
  }
  const raw = body[off];
  return {
    bodyOffset: off,
    rawByte: raw,
    // Across step-223's 55-save corpus this byte was 0 in every save.
    // Until a save shows a non-zero value AND we have confirmation it
    // tracks the player's wizard rank, we mark this read-only and "not
    // plausible as a level".
    plausible: false,
    note:
      'Candidate field per phase-7 ARM9 trace (body 0x11488 + 0x5a). step-223 ' +
      'validation found this byte is 0 in 55/55 saves in the corpus, ' +
      'contradicting phase-7’s hypothesis that init writes 0x0a here. ' +
      'Read-only — please test by saving at known wizard ranks and report.',
  };
}

// ---------------------------------------------------------------------------
// Slot parsing
// ---------------------------------------------------------------------------

function parseSlot(body: Uint8Array, label: SlotLabel): SlotParse {
  const uninit = allBytesEqual(body.subarray(0, 0x100), 0xff);
  const checksum = verifyHeaderChecksum(body);
  const bodyChecksum = verifyBodyChecksum(body);
  const extra0Checksum = verifyExtra0Checksum(body);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

  if (uninit) {
    return {
      label,
      uninitialised: true,
      checksum: { storedHex: '0xffff', computedHex: '0xffff', ok: true },
      bodyChecksum: { storedHex: '0xffff', computedHex: '0xffff', ok: true },
      extra0Checksum: { storedHex: '0xffff', computedHex: '0xffff', ok: true },
      formatVersionMagic: 0xffff,
      activeFlag: 0xff,
      otherSlotByte: 0xff,
      saveCounter: 0xff,
      perSaveFingerprint: 0xffff,
      formatVersionSubcode: 0xffff,
      playerName: '',
      schoolName: '',
      lastSaveTimestamp: { rawHex: '', decoded: '(uninit)' },
      characterCreateTimestamp: { rawHex: '', decoded: '(uninit)' },
      ritch: null,
      activeInventory: [],
      catalogEntries: [],
      mailEntries: [],
      npcRecords: [],
      residents: [],
      garden: { totalTiles: 0, populatedTiles: 0, tiles: [] },
      eventFlags: { totalBytes: 0, setBits: 0, previewHex: '' },
      activityLog: [],
      collectionStats: [],
      bankLog: [],
      wizardLevelCandidate: {
        bodyOffset: OFFSETS.characterRecordsStart + OFFSETS.wizardLevelCandidateOffset,
        rawByte: 0xff,
        plausible: false,
        note: 'Slot is uninitialised.',
      },
      inventoryBitmap: {
        totalBitsSet: 0,
        ownedBitsSet: 0,
        entries: [],
        rawHex: '',
      },
    };
  }

  const playerName = decodeUtf16Le(
    body.subarray(OFFSETS.playerName, OFFSETS.playerName + OFFSETS.playerNameLen),
    11,
  );

  const schoolName = decodeUtf16Le(
    body.subarray(OFFSETS.schoolName, OFFSETS.schoolName + OFFSETS.schoolNameLen),
    6,
  );

  const lastSaveTimestamp = decodeDatetime(
    body.subarray(OFFSETS.lastSaveTs, OFFSETS.lastSaveTs + 8),
  );
  const characterCreateTimestamp = decodeDatetime(
    body.subarray(OFFSETS.charCreateTs, OFFSETS.charCreateTs + 8),
  );

  const ritchVal = u32le(view, OFFSETS.ritch);
  const ritch = ritchVal === 0xffffffff ? null : ritchVal;

  return {
    label,
    uninitialised: false,
    checksum,
    bodyChecksum,
    extra0Checksum,
    formatVersionMagic: u16le(view, OFFSETS.formatMagic),
    activeFlag: body[OFFSETS.activeFlag],
    otherSlotByte: body[OFFSETS.otherSlotByte],
    saveCounter: body[OFFSETS.checksum], // body[0] = per-slot save counter low byte
    perSaveFingerprint: u16le(view, OFFSETS.perSaveFingerprint),
    formatVersionSubcode: u16le(view, OFFSETS.formatSubcode),
    playerName,
    schoolName,
    lastSaveTimestamp,
    characterCreateTimestamp,
    ritch,
    activeInventory: parseActiveInventory(body, view),
    catalogEntries: parseCatalog(body),
    mailEntries: parseMail(body),
    npcRecords: parseNpcRecords(body),
    residents: parseResidents(body),
    garden: parseGarden(body),
    eventFlags: parseEventFlags(body),
    activityLog: parseActivityLog(body, view),
    collectionStats: parseCollectionStats(body),
    bankLog: parseBankLog(body),
    wizardLevelCandidate: parseWizardLevelCandidate(body),
    inventoryBitmap: parseInventoryBitmap(body),
  };
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

function chooseActiveSlot(
  a: SlotParse | null,
  b: SlotParse | null,
): { label: SlotLabel | null; reason: string } {
  if (a && !a.uninitialised && (!b || b.uninitialised)) {
    return { label: 'A', reason: 'Slot B is uninitialised — A is the only valid save.' };
  }
  if (b && !b.uninitialised && (!a || a.uninitialised)) {
    return { label: 'B', reason: 'Slot A is uninitialised — B is the only valid save.' };
  }
  if (a && b && !a.uninitialised && !b.uninitialised) {
    // Higher save counter wins; on tie, slot A wins as the documented primary.
    if (a.saveCounter !== b.saveCounter) {
      if (a.saveCounter > b.saveCounter) {
        return {
          label: 'A',
          reason: `Slot A counter (0x${a.saveCounter.toString(16)}) > B (0x${b.saveCounter.toString(16)}).`,
        };
      }
      return {
        label: 'B',
        reason: `Slot B counter (0x${b.saveCounter.toString(16)}) > A (0x${a.saveCounter.toString(16)}).`,
      };
    }
    return {
      label: 'A',
      reason: 'Counters match; defaulting to A (documented primary).',
    };
  }
  return { label: null, reason: 'Neither slot looks initialised.' };
}

export async function parseSaveFile(file: Uint8Array): Promise<SaveParse> {
  const fileSha256 = await sha256Hex(file);
  const wrapper = detectWrapper(file);

  if (wrapper.payload === null) {
    return {
      wrapper,
      preamble: null,
      slotA: null,
      slotB: null,
      payloadSha256: '',
      fileSha256,
      activeSlot: null,
      activeSlotReason: 'Could not strip wrapper.',
    };
  }

  const payload = wrapper.payload;
  const payloadSha256 = await sha256Hex(payload);
  const preamble = parsePreamble(payload);

  // Slot A: body starts at file offset 0x100, ends at 0x40000.
  const slotABody = payload.subarray(SLOT_A_BASE, SLOT_A_BASE + SLOT_BODY_LEN);
  // Slot B: body starts at file offset 0x40000, ends at 0x80000. Slot B has
  // NO preamble — the body starts immediately. We use 0x40000 bytes for it.
  const slotBBody = payload.subarray(SLOT_B_BASE, SLOT_B_BASE + 0x40000);

  const slotA = parseSlot(slotABody, 'A');
  const slotB = parseSlot(slotBBody, 'B');

  const { label: activeSlot, reason: activeSlotReason } = chooseActiveSlot(slotA, slotB);

  return {
    wrapper,
    preamble,
    slotA,
    slotB,
    payloadSha256,
    fileSha256,
    activeSlot,
    activeSlotReason,
  };
}

// ---------------------------------------------------------------------------
// Region descriptors used by the UI
// ---------------------------------------------------------------------------

export const REGION_DESCRIPTORS = {
  wrapper: { id: 'wrapper', title: 'Wrapper detection', range: 'file footer', confidence: 'confirmed' as const },
  preamble: { id: 'preamble', title: 'Preamble — title magic + save-gen counter', range: '0x0000–0x00FF', confidence: 'confirmed' as const },
  checksum: { id: 'checksum', title: 'Header checksum (RFC1071 Internet Checksum)', range: 'body[0x00:0x14], stored at 0x00:0x02', confidence: 'confirmed' as const },
  bodyChecksum: { id: 'bodyChecksum', title: 'Body-level checksum (RFC1071)', range: 'body[0x14:0x14+0x1CDDC], stored at 0x14:0x16', confidence: 'confirmed' as const },
  extra0Checksum: { id: 'extra0Checksum', title: 'Extra[0] checksum (RFC1071)', range: 'extra[0][0:0x22F8], stored at extra[0][0:2] (file 0x01CEF0 / 0x05CDF0)', confidence: 'confirmed' as const },
  versionMagic: { id: 'versionMagic', title: 'Format version magic + sub-code', range: 'body[0x02:0x04] + body[0x16:0x18]', confidence: 'confirmed' as const },
  wizardLevelCandidate: { id: 'wizardLevelCandidate', title: 'Wizard level candidate (read-only — please test)', range: 'body[0x11488 + 0x5a]', confidence: 'candidate' as const },
  eventFlags: { id: 'eventFlags', title: 'Event flag region', range: 'body[0x18:0x460], ~1 KiB bit-flags', confidence: 'candidate' as const },
  profile: { id: 'profile', title: 'Player + school name', range: 'school body[0x47E:0x48A]; player body[0x1149C:0x114B2]', confidence: 'confirmed' as const },
  inventoryBitmap: { id: 'inventoryBitmap', title: 'Inventory bitmap (clothing + garden decorations)', range: 'slot_rel 0x1CDF2 (file 0x1CEF2 / 0x5CDF2), 173-bit packed bitmap', confidence: 'confirmed' as const },
  inventory: { id: 'inventory', title: 'Region at body 0x4300 — semantics unconfirmed (previously labelled "active inventory")', range: 'body[0x4300:0x4480], 8-byte stride', confidence: 'disputed' as const },
  activityLog: { id: 'activityLog', title: 'Activity log', range: 'body[0x0B500:0x0B900], 9-byte records', confidence: 'candidate' as const },
  collectionStats: { id: 'collectionStats', title: 'Collection statistics', range: 'body[0x11550:0x115F4], 14-byte records', confidence: 'candidate' as const },
  npcRecords: { id: 'npcRecords', title: 'Per-NPC relationship records', range: 'body[0x119C0+], variable stride (preview)', confidence: 'candidate' as const },
  garden: { id: 'garden', title: 'Garden plant tile state', range: 'body[0x12400:0x16000], 12-byte records', confidence: 'confirmed' as const },
  catalog: { id: 'catalog', title: 'Shop catalog announcement board', range: 'body[0x163F2+], 168-byte stride', confidence: 'confirmed' as const },
  mail: { id: 'mail', title: 'Per-NPC mail bodies', range: 'body[0x17400+], 168-byte stride', confidence: 'confirmed' as const },
  ritch: { id: 'ritch', title: 'Ritch (wallet)', range: 'body[0x1CFD0], u32 LE', confidence: 'confirmed' as const },
  bankLog: { id: 'bankLog', title: 'Bank transaction log', range: 'body[0x1CFD4:0x1E0E0], 6-byte records', confidence: 'candidate' as const },
  timestamps: { id: 'timestamps', title: 'Last-save + character-create timestamps', range: 'body[0x494] / body[0x4A4]', confidence: 'confirmed' as const },
  residents: { id: 'residents', title: 'Town residents (max 8)', range: 'body[0x1E0E0], stride 0x22F8', confidence: 'confirmed' as const },
};

export const FORMAT_MAGIC_EXPECTED = FORMAT_MAGIC;
