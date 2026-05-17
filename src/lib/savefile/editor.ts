// Edit primitives for Tongari Boushi save files. Mirrors
// `src/translator/_savefile_edit.py` from the translation repo, plus extends
// the editable surface to the regions whose offsets are known but whose in-
// game-safety is still BETA:
//
//   - Ritch (u32 LE at body 0x1CFD0) — confirmed safe
//   - Player name (UTF-16 LE × 5 at body A 0x47E) — confirmed safe
//   - Catalog announcement body text (body 0x163F2, stride 0xA8) — beta
//   - Per-NPC mail body text (body 0x17400+, stride 0xA8) — beta
//   - Resident name (body 0x1E0E0+ stride 0x22F8, first 16 bytes) — beta
//   - Garden plant tile (plant_id byte + grow_time byte) — beta
//
// All edits write to BOTH slot A and slot B (mirror), then recompute the
// 20-byte header checksum (RFC1071 Internet Checksum) for both slots. The
// game only enforces that single header csum — everything past body[0x14]
// is free-form.
//
// The DeSmuME .dsv wrapper (122-byte footer) is metadata only and is
// preserved verbatim when present.

import { OFFSETS, RAW_SIZE, DSV_FOOTER_LEN, inetCsum16 } from './parser';

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
  | { kind: 'catalog'; entryOffset: number; text: string }
  | { kind: 'mail'; entryOffset: number; text: string }
  | { kind: 'resident_name'; recordOffset: number; name: string }
  | { kind: 'garden_tile'; recordOffset: number; plantId: number; growTime: number };

export interface ApplyResult {
  /** New 524288-byte raw payload with all edits applied + checksums fixed. */
  payload: Uint8Array;
  /** Updated stored-checksum hex strings per slot, for UI confirmation. */
  slotAChecksumHex: string;
  slotBChecksumHex: string;
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

// ---------------------------------------------------------------------------
// Edit-region constraints used by the UI
// ---------------------------------------------------------------------------

/** Player name is 10 bytes = 5 UTF-16 LE characters. */
export const PLAYER_NAME_MAX_CHARS = 5;

/** Each catalog / mail entry is 0xA8 = 168 bytes. The first 8 bytes are
 *  the entry header (we don't touch). The remaining 160 bytes hold UTF-16
 *  text → max 80 characters per entry. */
export const STRIDED_ENTRY_HEADER_LEN = 8;
export const CATALOG_TEXT_MAX_CHARS =
  Math.floor((OFFSETS.catalogStride - STRIDED_ENTRY_HEADER_LEN) / 2);
export const MAIL_TEXT_MAX_CHARS =
  Math.floor((OFFSETS.mailStride - STRIDED_ENTRY_HEADER_LEN) / 2);

/** Resident records: only the first 16 bytes (= 8 UTF-16 LE chars) hold
 *  the name. The rest of the 0x22F8 record is left untouched. */
export const RESIDENT_NAME_MAX_CHARS = 8;
export const RESIDENT_NAME_BYTE_WIDTH = 16;

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
        const encLen = TEXT_ENCODER_UTF16.encode(edit.value, PLAYER_NAME_MAX_CHARS).length;
        if (encLen > OFFSETS.playerNameLen) {
          throw new Error(
            `Player name too long: encoded ${encLen} bytes, max ${OFFSETS.playerNameLen}.`,
          );
        }
        writeUtf16LeFixedWidth(
          payload,
          'A',
          OFFSETS.playerName,
          OFFSETS.playerNameLen,
          edit.value,
          PLAYER_NAME_MAX_CHARS,
        );
        writeUtf16LeFixedWidth(
          payload,
          'B',
          OFFSETS.playerName,
          OFFSETS.playerNameLen,
          edit.value,
          PLAYER_NAME_MAX_CHARS,
        );
        break;
      }
      case 'catalog': {
        // Write into the body of each catalog entry — text region only,
        // header bytes unchanged.
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
      case 'resident_name': {
        for (const slot of ['A', 'B'] as const) {
          writeUtf16LeFixedWidth(
            payload,
            slot,
            edit.recordOffset,
            RESIDENT_NAME_BYTE_WIDTH,
            edit.name,
            RESIDENT_NAME_MAX_CHARS,
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
    }
  }

  // Fix both slot checksums.
  const csumA = fixHeaderChecksum(payload, 'A');
  const csumB = fixHeaderChecksum(payload, 'B');

  return {
    payload,
    slotAChecksumHex: '0x' + csumA.toString(16).padStart(4, '0'),
    slotBChecksumHex: '0x' + csumB.toString(16).padStart(4, '0'),
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
