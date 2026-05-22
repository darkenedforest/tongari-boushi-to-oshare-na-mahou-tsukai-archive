// Edit primitives for Tongari Boushi save files. Mirrors
// `src/translator/_savefile_edit.py` from the translation repo, plus extends
// the editable surface to the regions whose offsets are known but whose in-
// game-safety is still BETA:
//
//   - Ritch (u32 LE at body 0x1CFD0) — confirmed safe
//   - Player name (UTF-16 LE) — written to THREE mirror copies:
//       * body 0x47E   (10 bytes, §22 canonical authoritative)
//       * body 0x1149C (22 bytes wide, character record per-display copy)
//       * body 0x114BA (10 bytes, §12.1 secondary cached copy)
//   - School/town name (UTF-16 LE) — written to TWO mirror copies:
//       * body 0x114B2 (12 bytes, empirically observed in v2.31 EN saves)
//       * body 0x115B2 (12 bytes, format-notes §5 documented)
//   - Catalog announcement body text (body 0x162B6, stride 0xA8) — beta
//   - Catalog announcement REMOVAL (zero-fill 168 bytes + trailing 0xFFFF sentinel)
//   - Per-NPC mail body text (body 0x17400+, stride 0xA8) — beta
//   - Garden plant tile (plant_id byte + grow_time byte) — beta
//
// step-252 fixes:
//   1. Catalog/mail text edits were writing 2 bytes too far into each
//      entry. STRIDED_ENTRY_HEADER_LEN was 8 but the parser reads from
//      offset +6 (the on-disk header is 6 bytes, not 8). Empirical dump
//      of tongari_en.dsv: text "WEEKLY CATALOG\nBreaking news…" starts
//      at +6 (entry @ body 0x162B6). With headerLen=8 the writer skipped
//      the first character ('W'), leaving the first 2 bytes of the
//      original header in place. On re-load the parser then decoded
//      those 2 stale header bytes as the first UTF-16 character (often
//      a control char that broke the in-game render). Fix: header is 6.
//   2. School name + player name editing surfaces added (previously
//      neither field had an inline-edit affordance; school name was
//      mis-located at 0x47E per step-250 but empirical evidence on
//      v2.31 EN saves shows shop/school name at 0x114B2 and the
//      §22-canonical player name at 0x47E).
//   3. Catalog "Remove" affordance: zero-fills the 168-byte entry then
//      writes the empty-slot sentinel `FF FF` at +0xA6:+0xA7. This is
//      the exact byte pattern observed in fresh-save empty catalog
//      slots (see entry 4..6 in tongari_en.dsv).
//
// step-262 (LaytonLoztew port) removed the `resident_name` edit kind —
// the underlying "Town residents @ body 0x1E0E0 stride 0x22F8 max 8"
// region was a fictional Game 3 hypothesis (Game 1's real classmate
// pool is 11 × 164 B at file 0x64D8, structurally incompatible with
// our removed claim). The UI no longer exposes this affordance.
//
// All edits write to BOTH slot A and slot B (mirror), then recompute the
// THREE levels of checksum the game checks:
//
//   1. The 20-byte slot-header checksum at body[0x00..0x02], computed over
//      body[0x00..0x14] with body[0x00..0x02] zeroed. RFC1071 Internet
//      Checksum (ARM9 0x02078A0C). Confirmed step-173.
//   2. The body-level checksum at body[0x14..0x16], computed over
//      body[0x14..0x14+0x1CDDC] with body[0x14..0x16] zeroed. Same RFC1071
//      algorithm. Phase-7 step-219 discovery; step-223 confirmed this is
//      required (53/55 corpus saves match the stored value, so the game
//      reads/writes it).
//   3. The extra[0] checksum at extra[0][0..0x02], computed over
//      extra[0][0..0x22F8] with extra[0][0..0x02] zeroed. Same RFC1071
//      algorithm. extra[0] starts at slot+0x1CDF0 (file 0x01CEF0 for
//      slot A, 0x05CDF0 for slot B). Confirmed step-234 against 36/36
//      initialised extra[0] regions in the corpus. Ritch
//      (body 0x1CFD0 = extra[0]+0x1E0) lives INSIDE extra[0], so any
//      Ritch edit MUST recompute this csum or the game rejects the slot.
//      The previous editor only fixed (1) + (2) and silently produced
//      Ritch-edited saves the game refused to load — this commit is the
//      fix.
//
// Order — bottom-up by scope:
//   1. extra[0] csum first (smallest nested region; though it lives just
//      OUTSIDE the body-csum range, doing it first keeps the order
//      monotonic in scope size).
//   2. body csum second.
//   3. header csum last.
//
// The DeSmuME .dsv wrapper (122-byte footer) is metadata only and is
// preserved verbatim when present.

import {
  OFFSETS,
  RAW_SIZE,
  DSV_FOOTER_LEN,
  BODY_CSUM_RANGE_LEN,
  EXTRA0_OFFSET,
  EXTRA0_LEN,
  inetCsum16,
} from './parser';

const SLOT_A_BASE = 0x100;
const SLOT_B_BASE = 0x40000;
const HEADER_LEN = 0x14;

const TEXT_ENCODER_UTF16 = (() => {
  // TextEncoder only supports utf-8. We hand-roll a UTF-16 LE encoder.
  return {
    encode(s: string, maxChars?: number): Uint8Array {
      const out: number[] = [];
      let count = 0;
      for (const ch of s) {
        if (maxChars !== undefined && count >= maxChars) break;
        const cp = ch.codePointAt(0)!;
        if (cp <= 0xffff) {
          out.push(cp & 0xff, (cp >> 8) & 0xff);
          count++;
        } else {
          // Surrogate pair — clamp away (game doesn't support emoji-plane).
          // Skip silently rather than expand surrogates we know the game
          // won't render.
        }
      }
      return new Uint8Array(out);
    },
  };
})();

// ---------------------------------------------------------------------------
// Pending-edit model
// ---------------------------------------------------------------------------

export type PendingEdit =
  | { kind: 'ritch'; value: number }
  | { kind: 'player_name'; value: string }
  | { kind: 'school_name'; value: string }
  | { kind: 'catalog'; entryOffset: number; text: string }
  | { kind: 'catalog_clear'; entryOffset: number }
  | { kind: 'mail'; entryOffset: number; text: string }
  | { kind: 'garden_tile'; recordOffset: number; plantId: number; growTime: number }
  /** Player inventory bag slot (one of the 15 records at body 0x1D9B6,
   *  stride 6). slotIndex 0..14. `storedValue=null + quantity=0` writes
   *  the empty sentinel (ff ff ff ff ff 00). */
  | {
      kind: 'inventory_slot';
      slotIndex: number;
      storedValue: number | null;
      quantity: number;
    };

export interface ApplyResult {
  /** New 524288-byte raw payload with all edits applied + checksums fixed. */
  payload: Uint8Array;
  /** Updated stored slot-header checksum hex strings per slot. */
  slotAChecksumHex: string;
  slotBChecksumHex: string;
  /** Updated stored body-level checksum hex strings per slot. */
  slotABodyChecksumHex: string;
  slotBBodyChecksumHex: string;
  /** Updated stored extra[0] checksum hex strings per slot. */
  slotAExtra0ChecksumHex: string;
  slotBExtra0ChecksumHex: string;
}

// ---------------------------------------------------------------------------
// Low-level writers (operate on the raw 524288-byte payload)
// ---------------------------------------------------------------------------

function bodyOffsetToFile(slot: 'A' | 'B', bodyOffset: number): number {
  return (slot === 'A' ? SLOT_A_BASE : SLOT_B_BASE) + bodyOffset;
}

function writeUtf16LeFixedWidth(
  payload: Uint8Array,
  slot: 'A' | 'B',
  bodyOffset: number,
  byteWidth: number,
  text: string,
  maxChars: number,
): void {
  const enc = TEXT_ENCODER_UTF16.encode(text, maxChars);
  const fileOffset = bodyOffsetToFile(slot, bodyOffset);
  // Zero-fill the entire field first so old chars beyond the new length
  // are wiped.
  for (let i = 0; i < byteWidth; i++) payload[fileOffset + i] = 0;
  const len = Math.min(enc.length, byteWidth);
  for (let i = 0; i < len; i++) payload[fileOffset + i] = enc[i];
}

function writeU32Le(
  payload: Uint8Array,
  slot: 'A' | 'B',
  bodyOffset: number,
  value: number,
): void {
  const fileOffset = bodyOffsetToFile(slot, bodyOffset);
  payload[fileOffset + 0] = value & 0xff;
  payload[fileOffset + 1] = (value >>> 8) & 0xff;
  payload[fileOffset + 2] = (value >>> 16) & 0xff;
  payload[fileOffset + 3] = (value >>> 24) & 0xff;
}

function writeByte(
  payload: Uint8Array,
  slot: 'A' | 'B',
  bodyOffset: number,
  value: number,
): void {
  payload[bodyOffsetToFile(slot, bodyOffset)] = value & 0xff;
}

function fixHeaderChecksum(payload: Uint8Array, slot: 'A' | 'B'): number {
  const base = slot === 'A' ? SLOT_A_BASE : SLOT_B_BASE;
  // Build a temp header with the csum word zeroed.
  const headerCopy = new Uint8Array(HEADER_LEN);
  for (let i = 0; i < HEADER_LEN; i++) headerCopy[i] = payload[base + i];
  headerCopy[0] = 0;
  headerCopy[1] = 0;
  const csum = inetCsum16(headerCopy);
  payload[base] = csum & 0xff;
  payload[base + 1] = (csum >>> 8) & 0xff;
  return csum;
}

/** Recompute the body-level RFC1071 checksum at body[0x14:0x16] over
 *  body[0x14..0x14+0x1CDDC] with body[0x14:0x16] zeroed, then store the
 *  result back as u16 LE at body[0x14:0x16].
 *
 *  Body offsets are relative to the slot body start (= file offset
 *  SLOT_A_BASE for slot A, SLOT_B_BASE for slot B). Must run AFTER all
 *  edits but BEFORE the slot-header csum (the header csum only covers
 *  body[0x00..0x14] so it's independent — but doing this first keeps
 *  the order matching the in-game write path documented in phase-7).
 */
function fixBodyChecksum(payload: Uint8Array, slot: 'A' | 'B'): number {
  const base = slot === 'A' ? SLOT_A_BASE : SLOT_B_BASE;
  const start = base + OFFSETS.bodyChecksum;
  const end = start + BODY_CSUM_RANGE_LEN;
  if (end > payload.length) {
    throw new Error(
      `Body-csum range [0x${start.toString(16)}..0x${end.toString(16)}) ` +
      `exceeds payload length ${payload.length}.`,
    );
  }
  // Copy the covered region so we can zero the first two bytes before
  // computing without mutating the actual payload until we know the
  // result.
  const region = new Uint8Array(BODY_CSUM_RANGE_LEN);
  for (let i = 0; i < BODY_CSUM_RANGE_LEN; i++) region[i] = payload[start + i];
  region[0] = 0;
  region[1] = 0;
  const csum = inetCsum16(region);
  payload[start] = csum & 0xff;
  payload[start + 1] = (csum >>> 8) & 0xff;
  return csum;
}

/** Recompute the extra[0] RFC1071 checksum at extra[0][0:2] over
 *  extra[0][0..0x22F8] with extra[0][0:2] zeroed, then store the result
 *  back as u16 LE at extra[0][0:2].
 *
 *  extra[0] starts at slot+0x1CDF0 (file 0x01CEF0 for slot A, 0x05CDF0
 *  for slot B). Ritch (body 0x1CFD0 = extra[0]+0x1E0) lives INSIDE this
 *  region, so any Ritch edit invalidates this csum. The previous editor
 *  did NOT touch this csum, so Ritch-edited saves were rejected by the
 *  game's load-time integrity check; step-234 added it.
 *
 *  This csum is independent of both the body csum (extra[0] sits
 *  entirely OUTSIDE the body-csum range, which ends at body 0x1CDF0 =
 *  the same offset where extra[0] starts) and the header csum, so
 *  ordering within the three-level repair doesn't matter for
 *  correctness — we do it first for clarity. */
function fixExtra0Checksum(payload: Uint8Array, slot: 'A' | 'B'): number {
  const base = slot === 'A' ? SLOT_A_BASE : SLOT_B_BASE;
  const start = base + EXTRA0_OFFSET;
  const end = start + EXTRA0_LEN;
  if (end > payload.length) {
    throw new Error(
      `Extra[0] range [0x${start.toString(16)}..0x${end.toString(16)}) ` +
      `exceeds payload length ${payload.length}.`,
    );
  }
  const region = new Uint8Array(EXTRA0_LEN);
  for (let i = 0; i < EXTRA0_LEN; i++) region[i] = payload[start + i];
  region[0] = 0;
  region[1] = 0;
  const csum = inetCsum16(region);
  payload[start] = csum & 0xff;
  payload[start + 1] = (csum >>> 8) & 0xff;
  return csum;
}

// ---------------------------------------------------------------------------
// Edit-region constraints used by the UI
// ---------------------------------------------------------------------------

/** Player name capacity per §22 of the format notes: 10 bytes UTF-16 LE
 *  (up to 5 characters). The §22 canonical authoritative location at body
 *  0x47E is exactly 10 bytes wide; the character-record copy at body
 *  0x1149C reserves more (zero-padded), so the 5-char cap is the safe
 *  bound across all mirrors. */
export const PLAYER_NAME_MAX_CHARS = 5;

/** Player-name mirror offsets (slot-relative body offsets). All written
 *  on every player_name edit so the in-game render picks up the change
 *  regardless of which copy the game reads. See step-252 header notes. */
export const PLAYER_NAME_OFFSETS = [
  /** §22 canonical authoritative — body 0x47E, 10 bytes. */
  { offset: 0x47e, width: 10 },
  /** Character-record per-display copy — body 0x1149C. The archive's
   *  parser also reads this offset; width remains 22 (zero-pad beyond
   *  the 10 name bytes) so we don't leave stale per-character data
   *  between 0x114A6..0x114B1. */
  { offset: 0x1149c, width: 22 },
  /** §12.1 secondary cached copy — body 0x114BA, 10 bytes. */
  { offset: 0x114ba, width: 10 },
] as const;

/** School / shop / town name. Capacity per §5 of the format notes: 12
 *  bytes UTF-16 LE (up to 6 characters). */
export const SCHOOL_NAME_MAX_CHARS = 6;

/** School-name mirror offsets. v2.31 EN saves empirically store the
 *  shop/town name at body 0x114B2 (verified via tongari_en.dsv: bytes
 *  `53 00 68 00 6F 00 70 00` spell "Shop" starting at that offset).
 *  Format notes §5 documents the offset as 0x115B2; that location is
 *  empty in our v2.31 corpus but we write there too in case a different
 *  build / region reads from it. */
export const SCHOOL_NAME_OFFSETS = [
  { offset: 0x114b2, width: 12 },
  { offset: 0x115b2, width: 12 },
] as const;

/** Each catalog / mail entry is 0xA8 = 168 bytes. The on-disk layout
 *  is a 6-byte header (00 00 status month-marker month day) followed by
 *  162 bytes of UTF-16 LE body text. Confirmed empirically: in
 *  tongari_en.dsv entry 0 the string "WEEKLY CATALOG\nBreaking news…"
 *  starts at +6 inside its 168-byte slot.
 *
 *  step-252 fix: this constant was 8 prior to step-252, causing the
 *  catalog / mail text writers to skip the first character of the new
 *  text AND leave 2 stale bytes of the original header at +6..+7.
 *  Re-loading then decoded those stale bytes as the leading UTF-16
 *  codepoint of the entry. */
export const STRIDED_ENTRY_HEADER_LEN = 6;
export const CATALOG_TEXT_MAX_CHARS =
  Math.floor((OFFSETS.catalogStride - STRIDED_ENTRY_HEADER_LEN) / 2);
export const MAIL_TEXT_MAX_CHARS =
  Math.floor((OFFSETS.mailStride - STRIDED_ENTRY_HEADER_LEN) / 2);

// step-262: RESIDENT_NAME_MAX_CHARS / RESIDENT_NAME_BYTE_WIDTH removed
// — the 0x1E0E0 residents region was a fictional hypothesis and the UI
// affordance was deleted alongside the parser.

/** Inventory bag: 15 slots × 6-byte records at body 0x1D9B6.
 *
 *  Per-record layout (when occupied):
 *    +0..1  u16 LE stored_value (NOT itemname.ofs iid — see
 *           public/data/inventory_encoding.json for the iid↔stored map)
 *    +2..4  three 0x00 padding bytes (always)
 *    +5     u8  quantity (1..255)
 *  Empty slot sentinel: `ff ff ff ff ff 00`.
 *
 *  Cracked in translation-repo step-260 via ARM9 lookup function
 *  0x0200BB2C + per-category base/count tables. Verified against
 *  tongari_en.dsv's slot-B inventory (7 occupied slots + slot 15
 *  King Oyster Mushroom). */
export const INVENTORY_BAG_BASE = 0x1d9b6;
export const INVENTORY_BAG_COUNT = 15;
export const INVENTORY_BAG_STRIDE = 6;
export const INVENTORY_QUANTITY_MIN = 1;
export const INVENTORY_QUANTITY_MAX = 255;

function writeInventorySlot(
  payload: Uint8Array,
  slot: 'A' | 'B',
  slotIndex: number,
  storedValue: number | null,
  quantity: number,
): void {
  if (slotIndex < 0 || slotIndex >= INVENTORY_BAG_COUNT) {
    throw new Error(`Inventory slotIndex out of range: ${slotIndex}`);
  }
  const bodyOffset = INVENTORY_BAG_BASE + slotIndex * INVENTORY_BAG_STRIDE;
  const fileOffset = bodyOffsetToFile(slot, bodyOffset);
  if (storedValue === null) {
    // Empty sentinel: ff ff ff ff ff 00. Matches the byte pattern of
    // every unused slot in the corpus (e.g. tongari_en.dsv slots 8..14).
    payload[fileOffset + 0] = 0xff;
    payload[fileOffset + 1] = 0xff;
    payload[fileOffset + 2] = 0xff;
    payload[fileOffset + 3] = 0xff;
    payload[fileOffset + 4] = 0xff;
    payload[fileOffset + 5] = 0x00;
    return;
  }
  if (storedValue < 0 || storedValue > 0xffff) {
    throw new Error(`Inventory storedValue out of u16 range: ${storedValue}`);
  }
  if (
    !Number.isFinite(quantity) ||
    quantity < INVENTORY_QUANTITY_MIN ||
    quantity > INVENTORY_QUANTITY_MAX
  ) {
    throw new Error(
      `Inventory quantity must be ${INVENTORY_QUANTITY_MIN}..${INVENTORY_QUANTITY_MAX}, got ${quantity}.`,
    );
  }
  payload[fileOffset + 0] = storedValue & 0xff;
  payload[fileOffset + 1] = (storedValue >>> 8) & 0xff;
  // Three 0x00 padding bytes. Every observed populated slot in the
  // corpus has these three bytes zero — they're a structural part of
  // the 6-byte record, not stale data.
  payload[fileOffset + 2] = 0x00;
  payload[fileOffset + 3] = 0x00;
  payload[fileOffset + 4] = 0x00;
  payload[fileOffset + 5] = quantity & 0xff;
}

// ---------------------------------------------------------------------------
// Apply edits
// ---------------------------------------------------------------------------

export function applyEdits(
  originalPayload: Uint8Array,
  edits: PendingEdit[],
): ApplyResult {
  if (originalPayload.length !== RAW_SIZE) {
    throw new Error(
      `applyEdits requires a 524288-byte raw payload (got ${originalPayload.length}).`,
    );
  }
  // Defensive copy so we don't mutate the caller's array.
  const payload = new Uint8Array(originalPayload);

  for (const edit of edits) {
    switch (edit.kind) {
      case 'ritch': {
        if (!Number.isFinite(edit.value) || edit.value < 0 || edit.value > 0xffffffff) {
          throw new Error(`Ritch out of range: ${edit.value}`);
        }
        writeU32Le(payload, 'A', OFFSETS.ritch, edit.value);
        writeU32Le(payload, 'B', OFFSETS.ritch, edit.value);
        break;
      }
      case 'player_name': {
        // Encode once so we can sanity-check length against the
        // tightest mirror copy. PLAYER_NAME_MAX_CHARS caps the input
        // to 5 chars / 10 bytes UTF-16 LE — that's the §22 canonical
        // capacity.
        const encLen = TEXT_ENCODER_UTF16.encode(edit.value, PLAYER_NAME_MAX_CHARS).length;
        // Tightest mirror is 10 bytes (the §22 / §12.1 copies); the
        // character-record copy at 0x1149C is wider so a 10-byte
        // payload always fits there too.
        if (encLen > 10) {
          throw new Error(
            `Player name too long: encoded ${encLen} bytes, max 10.`,
          );
        }
        for (const { offset, width } of PLAYER_NAME_OFFSETS) {
          writeUtf16LeFixedWidth(
            payload, 'A', offset, width, edit.value, PLAYER_NAME_MAX_CHARS,
          );
          writeUtf16LeFixedWidth(
            payload, 'B', offset, width, edit.value, PLAYER_NAME_MAX_CHARS,
          );
        }
        break;
      }
      case 'school_name': {
        const encLen = TEXT_ENCODER_UTF16.encode(edit.value, SCHOOL_NAME_MAX_CHARS).length;
        if (encLen > 12) {
          throw new Error(
            `School name too long: encoded ${encLen} bytes, max 12.`,
          );
        }
        for (const { offset, width } of SCHOOL_NAME_OFFSETS) {
          writeUtf16LeFixedWidth(
            payload, 'A', offset, width, edit.value, SCHOOL_NAME_MAX_CHARS,
          );
          writeUtf16LeFixedWidth(
            payload, 'B', offset, width, edit.value, SCHOOL_NAME_MAX_CHARS,
          );
        }
        break;
      }
      case 'catalog': {
        // Write into the body of each catalog entry — text region only,
        // header bytes (the 6-byte status+date prefix) are preserved.
        const textStart = edit.entryOffset + STRIDED_ENTRY_HEADER_LEN;
        const byteWidth = OFFSETS.catalogStride - STRIDED_ENTRY_HEADER_LEN;
        for (const slot of ['A', 'B'] as const) {
          writeUtf16LeFixedWidth(
            payload,
            slot,
            textStart,
            byteWidth,
            edit.text,
            CATALOG_TEXT_MAX_CHARS,
          );
        }
        break;
      }
      case 'catalog_clear': {
        // Zero-fill the entire 168-byte entry then write the empty-slot
        // sentinel 0xFF 0xFF at the LAST 2 bytes (+0xA6..+0xA7). This
        // mimics the byte pattern of unused catalog slots in fresh-save
        // / partially-populated saves (verified against entries 4..6 of
        // tongari_en.dsv: all-zero body with trailing `ff ff`). The
        // parser's plausible-text heuristic skips entries with fewer
        // than 4 non-(0x00|0xFF) bytes in the post-header region, so
        // cleared slots disappear from the UI list and the in-game
        // catalog screen treats the slot as empty.
        const entry = edit.entryOffset;
        for (const slot of ['A', 'B'] as const) {
          const base = slot === 'A' ? SLOT_A_BASE : SLOT_B_BASE;
          for (let i = 0; i < OFFSETS.catalogStride; i++) {
            payload[base + entry + i] = 0;
          }
          // Trailing 0xFF 0xFF empty-slot sentinel.
          payload[base + entry + OFFSETS.catalogStride - 2] = 0xff;
          payload[base + entry + OFFSETS.catalogStride - 1] = 0xff;
        }
        break;
      }
      case 'mail': {
        const textStart = edit.entryOffset + STRIDED_ENTRY_HEADER_LEN;
        const byteWidth = OFFSETS.mailStride - STRIDED_ENTRY_HEADER_LEN;
        for (const slot of ['A', 'B'] as const) {
          writeUtf16LeFixedWidth(
            payload,
            slot,
            textStart,
            byteWidth,
            edit.text,
            MAIL_TEXT_MAX_CHARS,
          );
        }
        break;
      }
      case 'garden_tile': {
        // 12-byte record: byte 0 = plant_id, byte 4 = grow_time. Other
        // bytes in the record are left untouched.
        for (const slot of ['A', 'B'] as const) {
          writeByte(payload, slot, edit.recordOffset + 0, edit.plantId & 0xff);
          writeByte(payload, slot, edit.recordOffset + 4, edit.growTime & 0xff);
        }
        break;
      }
      case 'inventory_slot': {
        // Mirror the write to both slots so the edit survives the next
        // ping-pong save regardless of which slot the game considers
        // active at load time. This mirrors what every other write kind
        // does (player_name, school_name, ritch, catalog, mail, garden).
        for (const slot of ['A', 'B'] as const) {
          writeInventorySlot(
            payload,
            slot,
            edit.slotIndex,
            edit.storedValue,
            edit.quantity,
          );
        }
        break;
      }
    }
  }

  // Fix all three checksums for both slots, in the right order. All three
  // are independent of each other (extra[0] sits outside the body-csum
  // range, body-csum sits outside the header-csum range), so any order
  // works for correctness — we go bottom-up by scope for clarity:
  //   1. extra[0] csum  — covers extra[0][0..0x22F8], stored at +0
  //      (step-234 added this; previously missing → Ritch edits broke saves).
  //   2. body csum      — covers body[0x14..0x14+0x1CDDC], stored at +0x14
  //      (step-223 added this; previously missing → most edits broke saves).
  //   3. header csum    — covers body[0x00..0x14], stored at +0
  //      (step-173 — the original csum that the predecessor knew about).
  const extra0CsumA = fixExtra0Checksum(payload, 'A');
  const extra0CsumB = fixExtra0Checksum(payload, 'B');
  const bodyCsumA = fixBodyChecksum(payload, 'A');
  const bodyCsumB = fixBodyChecksum(payload, 'B');
  const csumA = fixHeaderChecksum(payload, 'A');
  const csumB = fixHeaderChecksum(payload, 'B');

  return {
    payload,
    slotAChecksumHex: '0x' + csumA.toString(16).padStart(4, '0'),
    slotBChecksumHex: '0x' + csumB.toString(16).padStart(4, '0'),
    slotABodyChecksumHex: '0x' + bodyCsumA.toString(16).padStart(4, '0'),
    slotBBodyChecksumHex: '0x' + bodyCsumB.toString(16).padStart(4, '0'),
    slotAExtra0ChecksumHex: '0x' + extra0CsumA.toString(16).padStart(4, '0'),
    slotBExtra0ChecksumHex: '0x' + extra0CsumB.toString(16).padStart(4, '0'),
  };
}

// ---------------------------------------------------------------------------
// Re-wrap helper (rebuild a .dsv from a raw payload + the original footer)
// ---------------------------------------------------------------------------

export function rewrapForDownload(
  payload: Uint8Array,
  wrapperKind: 'dsv' | 'raw',
  originalFile: Uint8Array,
): Uint8Array {
  if (wrapperKind === 'raw') {
    return payload;
  }
  // DSV: append the original 122-byte footer verbatim. The footer stores
  // DeSmuME chip-id metadata — preserving it byte-for-byte is the safest
  // path; if the user reloads in DeSmuME with the original cart binding
  // the emulator accepts it.
  if (originalFile.length !== RAW_SIZE + DSV_FOOTER_LEN) {
    throw new Error(
      `Cannot re-wrap as .dsv: original file is ${originalFile.length} bytes, expected ${RAW_SIZE + DSV_FOOTER_LEN}.`,
    );
  }
  const out = new Uint8Array(RAW_SIZE + DSV_FOOTER_LEN);
  out.set(payload, 0);
  out.set(originalFile.subarray(RAW_SIZE), RAW_SIZE);
  return out;
}

// ---------------------------------------------------------------------------
// Filename helper
// ---------------------------------------------------------------------------

export function suffixFilenameForEdit(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name + '_edited';
  return name.slice(0, dot) + '_edited' + name.slice(dot);
}
