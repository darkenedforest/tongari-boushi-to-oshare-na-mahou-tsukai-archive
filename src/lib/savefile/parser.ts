// Pure parsing functions for Tongari Boushi save files. All work in this
// module happens in-browser on a Uint8Array. (The component that mounts
// this parser also fires a separate silent background upload to the
// save_files Supabase backend — that's done at the component layer, not
// here. See SaveFileInspector.tsx.)
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
  CollectionBitmap,
  CollectionStatRecord,
  DateTimeInfo,
  EventFlagSummary,
  FriendMet,
  Game1Checksum,
  Game1Classmate,
  Game1Decode,
  Game1MysteryFlag,
  Game1Player,
  Game1Spell,
  Game1Title,
  GardenSummary,
  InventoryBagSlot,
  InventorySlot,
  MailEntry,
  PreambleInfo,
  SaveParse,
  SlotLabel,
  SlotParse,
  TownResident,
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

  // Profile region — step-258 re-resolution:
  //
  // Three INDEPENDENT fields, not three mirrors. step-252 had labelled
  // body 0x47E + 0x1149C + 0x114BA as "player-name mirror copies"
  // because the corpus we checked at the time had Tyler using the same
  // name for player / shop / town in every fixture, so every offset
  // trivially matched. Submission #16 (Harry Potter playthrough with
  // distinct names) refuted that:
  //
  //   - body 0x47E   = TOWN name   (e.g. "HOGSMEADE" in submission #16)
  //                    10 bytes UTF-16 LE, up to 5 chars.
  //   - body 0x1149C = PLAYER name (e.g. "WEASLEY" in submission #16)
  //                    22 bytes UTF-16 LE, character-record copy.
  //   - body 0x114B2 = SHOP name   (e.g. "Shop Weasleys" in submission #16,
  //                    "Shopタイラ" in tongari_en.dsv)
  //                    12+ bytes UTF-16 LE.
  //
  // Body 0x114BA and body 0x115B2 are NOT separate fields:
  //   - 0x114BA is offset +8 inside the 0x114B2 shop-name field
  //     (= bytes 8..17 of the same string).
  //   - 0x115B2 is empty (zeros) in every v2.31 corpus save we've
  //     checked. No empirical evidence any build/region reads from
  //     it. step-252 wrote to it as a "documented mirror" but the
  //     §5-format-notes claim that offset is the canonical shop
  //     location was itself wrong — the data lives 0x100 earlier.
  //
  // The pre-step-258 editor treated player_name writes as mirrors
  // across 0x47E + 0x1149C + 0x114BA, which clobbered the town name
  // on every player rename and corrupted the middle of the shop
  // name. step-258 separates the three fields and exposes them as
  // independent edit kinds.
  // Shop and town field WIDTHS used for reading. The in-game name-entry
  // surface lets the player type at most ~6 chars for shop, ~5 for town,
  // but submitted saves (e.g. submission #16) show the underlying byte
  // fields can hold significantly longer strings — likely set by the
  // game's "Shop "-prefix template or by older non-EN entry surfaces.
  // We read up to the next known structural boundary so the inspector
  // surfaces whatever the bytes contain. The EDITOR caps writes at the
  // in-game-entry character limits via SHOP_NAME_MAX_CHARS /
  // TOWN_NAME_MAX_CHARS in editor.ts and zero-fills the field through
  // its full readable width so older long-string content is wiped on
  // edit.
  shopName: 0x114b2,
  shopNameLen: 32, // up to 16 chars read; editor writes up to 6 chars + zero pads
  /** Town name. Body 0x47E. Field runs up to the timestamp marker at
   *  body 0x494, so read up to 22 bytes (11 chars). Editor caps writes
   *  at 5 chars. */
  townName: 0x47e,
  townNameLen: 22,
  lastSaveTs: 0x494,
  charCreateTs: 0x4a4,

  /** Body offset of the player's display name. 22 bytes UTF-16 LE,
   *  up to 11 chars (we cap the editor at 5 to match the in-game
   *  name-entry surface). Phase-7 ARM9 trace identifies this as the
   *  primary character-record copy at body 0x11488 + 0x14. */
  playerName: 0x1149c,
  playerNameLen: 22, // up to 11 UTF-16 LE chars (editor caps at 5)

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

  // Player inventory bag — 15 slots × 6-byte records at body 0x1D9B6.
  // Encoding cracked in translation-repo step-260: ARM9 lookup function
  // 0x0200BB2C plus per-category internal-ID base/count tables at
  // RAM 0x0209CCC4 / 0x0209CD14 / 0x0209CC9C define 39 categories with
  // disjoint internal-ID ranges. The stored u16 LE at +0 is the game's
  // internal item-ID (NOT the itemname.ofs positional iid); the iid↔
  // stored_value bridge lives in public/data/inventory_encoding.json
  // (3346 entries, full bijection). Per-record layout:
  //   +0..1  u16 LE stored_value
  //   +2..4  three 0x00 padding bytes
  //   +5     u8  quantity (1..255 when occupied)
  // Empty sentinel: ff ff ff ff ff 00. Verified against tongari_en.dsv
  // slot-B inventory (7 occupied slots 1..7 + slot 15 King Oyster
  // Mushroom; slots 8..14 sentinel).
  inventoryBagStart: 0x1d9b6,
  inventoryBagCount: 15,
  inventoryBagStride: 6,

  // Wallet
  ritch: 0x1cfd0,

  // Bank transaction log
  bankStart: 0x1cfd4,
  bankEnd: 0x1e0e0,
  bankRecordSize: 6,

  // Town residents table — 8 fixed slots × 0x22F8 (8952) bytes at body
  // 0x1E0E0. §30 of `notes/savefile_format.md` documents the layout; the
  // 3DS dump upload_12 in the translation repo's corpus has populated
  // residents モコるん (Mokorun) at slot 0 and ラビーな (Rabina) at slot 1,
  // with vacant zeros at slots 2..3 and 0xFF UNINIT bytes at slots 4..7
  // — visible directly at the documented offsets.
  //
  // Per-record layout:
  //   +0x00..0x0F  NPC name (UTF-16 LE, zero-padded; max 8 chars)
  //   +0x10..0x1F  padding
  //   +0x20..0x420 house decoration bitmap (4-bit-per-pixel wallpaper +
  //                floor tiles — the `aa aa bb bb ee ee` patterns visible
  //                in hex dumps)
  //   +0x420..end  relationship stats + per-day affinity history +
  //                gift log + dialog-seen flags
  //
  // Tri-state per slot via the first 16 bytes (the name field):
  //   - populated  (non-FF, non-zero): in-town resident
  //   - vacant     (all 0x00): resident moved out, slot reusable
  //   - uninit     (all 0xFF): slot never used
  //
  // Step-262's removal note rejected this region by Game-1 analogy
  // (mqreader.js documents 11 × 164 B classmate slots at file 0x64D8 for
  // Magician's Quest, which the comment claimed proved 8 × 0x22F8 was
  // structurally wrong). But Game 3 (Tongari Boushi) and Game 1
  // (Magician's Quest) ARE different games — Game 3 allows a fixed 8-
  // resident town with full per-NPC house customisation (the 1 KiB house-
  // decoration bitmap at +0x20..0x420), which Magician's Quest does not
  // have. The 0x22F8 stride was therefore genuinely Game-3-specific, not
  // a transposition error. §30's empirical evidence (upload_12 reading
  // モコるん at the exact predicted offset) overrides the analogy.
  //
  // Step-262 also REMOVED two adjacent regions that ARE genuinely
  // unconfirmed and stay removed:
  //   - "NPC relationship records @ body 0x119C0+ stride 0x500" — no
  //     ARM9 evidence; pattern-matched noise.
  //   - "173-bit inventory bitmap @ body 0x1CDF2" — appeared to decode
  //     against a real ARM9 trace but produced items the player did NOT
  //     own. Bytes are real, meaning unknown.
  residentsStart: 0x1e0e0,
  residentsStride: 0x22f8,
  residentsCount: 8,
  residentsNameLen: 16,

  // Friends-met / NPC encounter region — body 0x500..0x4300 (15,616
  // bytes). Within this region, every NPC the player has encountered or
  // befriended appears as a u16 LE stored_value (= npc_data_ofs_id + 500,
  // range 500..751) at one or more non-aligned offsets — there are
  // multiple sub-tables (encounter log, friend list, gift log, etc.)
  // and they don't all use the same record layout, so the same NPC may
  // be referenced from several offsets inside this 15 KB block. NPC
  // encoding cracked in translation-repo step-346 (commit 0941cbca, tag
  // step-346-npc-encoding) via differential save analysis + ARM9 NPC
  // tables at RAM 0x020A1660 / 0x020A1670 / 0x020A1690.
  //
  // The parser scans EVEN-aligned offsets only — odd-aligned reads
  // would catch byte-pairs that straddle unrelated record boundaries
  // and happen to land in the 500..751 range as false positives. The
  // sub-region boundaries within this 15 KB block are NOT yet decoded
  // (open question per translation-repo notes/savefile_format.md §55),
  // so editing affordances are deliberately not exposed here — we just
  // surface the deduplicated list of NPCs the player has met.
  friendsRegionStart: 0x500,
  friendsRegionEnd: 0x4300,
  friendStoredValueMin: 500,
  friendStoredValueMax: 751,
} as const;

/** Body-level RFC1071 checksum range length. Exported because the editor
 *  also needs it when recomputing after edits. */
export const BODY_CSUM_RANGE_LEN = BODY_CSUM_LEN;

/** Slot-relative offset of extra[0] (the per-slot Family-C meta record).
 *  File offset = SLOT_A_BASE + EXTRA0_OFFSET = 0x01CEF0 for slot A and
 *  SLOT_B_BASE + EXTRA0_OFFSET = 0x05CDF0 for slot B. Confirmed step-234
 *  via empirical csum verification on 36/36 initialised slots. */
export const EXTRA0_OFFSET = 0x1cdf0;

// ---------------------------------------------------------------------------
// Collection-bitmap family (translation-repo notes/savefile_format.md §57)
// ---------------------------------------------------------------------------
//
// Ten same-shape bitmaps packed back-to-back at slot_rel 0x1CDF2..0x1D0BD,
// all serviced by the bit-set/bit-test primitive at ARM9 0x0201BCB0. Each
// row below is one bitmap. The first (offset 0x1CDF2, 173 bits) is the
// clothing+garden inventory whose semantics are fully decoded in §53; the
// other nine are documented in §57 with width / setter address / Zeno-save
// bit count but their precise meanings are TBD pending the ARM9
// caller-of-setters trace (translation-repo step-365).
//
// An eleventh setter at ARM9 0x0201B6A8 also uses the same bit primitive
// but with a base pointing into a separate BSS buffer (*0x020A3D14), so
// that bitmap is NOT persisted into the save file and is intentionally
// absent from this table.

export interface CollectionBitmapSpec {
  offset: number;
  maxBits: number;
  setterAddr: number;
  label: string | null;
  semanticNote: string;
}

export const COLLECTION_BITMAP_SPECS: readonly CollectionBitmapSpec[] = [
  {
    offset: 0x1cdf2,
    maxBits: 173,
    setterAddr: 0x0201b56c,
    label: 'Clothing + Garden Inventory',
    semanticNote:
      '§53 confirmed: item_ids 1000..1139 (clothing) + 2000..2032 (garden decorations). Editable via the Inventory Bag section above.',
  },
  {
    offset: 0x1ce08,
    maxBits: 12,
    setterAddr: 0x0201b5d8,
    label: null,
    semanticNote: 'semantics TBD (small 12-bit flag bank). Pending caller-of-setters trace (translation-repo step-365).',
  },
  {
    offset: 0x1ce0a,
    maxBits: 10,
    setterAddr: 0x0201b60c,
    label: null,
    semanticNote: 'semantics TBD (small 10-bit flag bank). Pending caller-of-setters trace.',
  },
  {
    offset: 0x1ce0c,
    maxBits: 20,
    setterAddr: 0x0201b640,
    label: null,
    semanticNote: 'semantics TBD (20-bit flag bank). Pending caller-of-setters trace.',
  },
  {
    offset: 0x1ce0f,
    maxBits: 24,
    setterAddr: 0x0201b674,
    label: null,
    semanticNote:
      'semantics TBD (24-bit field). Likely magazine-issues-read (fits ~30 issues, width matches the magazine count). Pending caller-of-setters trace.',
  },
  {
    offset: 0x1ce12,
    maxBits: 266,
    setterAddr: 0x0201b6dc,
    label: null,
    semanticNote:
      'semantics TBD (266 bits). Bitmap A — 99 set in the Zeno reference save, strong fish-or-bug catalog candidate. Pending caller-of-setters trace.',
  },
  {
    offset: 0x1ce34,
    maxBits: 266,
    setterAddr: 0x0201b718,
    label: null,
    semanticNote:
      'semantics TBD (266 bits). Bitmap B — 0 set in Zeno but same-width sibling of 0x1CE12, likely the other half of the fish-and-bug catalog pair. Pending caller-of-setters trace.',
  },
  {
    offset: 0x1ce56,
    maxBits: 258,
    setterAddr: 0x0201b754,
    label: null,
    semanticNote:
      'semantics TBD (258 bits). Bitmap C — 162 set in Zeno (densest of the family); candidate "NPCs met" or "items-seen". Pending caller-of-setters trace.',
  },
  {
    offset: 0x1ce77,
    maxBits: 258,
    setterAddr: 0x0201b790,
    label: null,
    semanticNote:
      'semantics TBD (258 bits). Bitmap D — 3 set in Zeno (sparsest); candidate rare-events / completion-stamps. Pending caller-of-setters trace.',
  },
  {
    offset: 0x1ce98,
    maxBits: 2344,
    setterAddr: 0x0201b7cc,
    label: null,
    semanticNote:
      'semantics TBD (2344 bits = 293 bytes — by far the largest in the family). Strong candidate for the global story-event flag table. Pending caller-of-setters trace.',
  },
] as const;

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

/** Read N bits starting at byte offset `offset` from `body` and return
 *  ONLY the count of set bits in that window, ignoring any trailing
 *  bits inside the last byte that fall beyond `maxBits`. Used for
 *  the collection-bitmap family (§57) where adjacent bitmaps share
 *  the trailing bits of the last byte of their predecessor.
 *
 *  Byte width is `ceil(maxBits / 8)`. The final byte's high bits beyond
 *  the bitmap's own range are masked off before being popcounted, so a
 *  neighbouring bitmap's bits aren't accidentally attributed to this
 *  one's population count. */
export function popcountBitmapWindow(
  body: Uint8Array,
  offset: number,
  maxBits: number,
): number {
  if (maxBits <= 0) return 0;
  const fullBytes = Math.floor(maxBits / 8);
  const tailBits = maxBits - fullBytes * 8;
  const end = offset + fullBytes;
  if (end > body.length) return 0;
  let count = 0;
  for (let i = offset; i < end; i++) {
    let x = body[i];
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    x = (x + (x >> 4)) & 0x0f;
    count += x;
  }
  if (tailBits > 0 && end < body.length) {
    const mask = (1 << tailBits) - 1;
    let x = body[end] & mask;
    x = x - ((x >> 1) & 0x55);
    x = (x & 0x33) + ((x >> 2) & 0x33);
    x = (x + (x >> 4)) & 0x0f;
    count += x;
  }
  return count;
}

/** Hex-dump of the byte window that holds `maxBits` bits starting at
 *  `offset`. Always returns the full `ceil(maxBits / 8)` bytes (so the
 *  diagnostic view shows the same window the population count is
 *  computed against). */
function bitmapWindowHex(
  body: Uint8Array,
  offset: number,
  maxBits: number,
): string {
  const byteLen = Math.ceil(maxBits / 8);
  const end = Math.min(offset + byteLen, body.length);
  return bytesToHex(body.subarray(offset, end));
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
// Inventory bag (15-slot player inventory at body 0x1D9B6)
// ---------------------------------------------------------------------------

/** Parse the 15-slot inventory bag. The iid decode itself is left as null
 *  here — the parser doesn't ship the stored↔iid mapping (lives in the
 *  fetched public/data/inventory_encoding.json so the bundle stays small).
 *  The component layer in SaveFileInspector.tsx fills in the iid once the
 *  lookups payload has loaded. */
function parseInventoryBag(body: Uint8Array): InventoryBagSlot[] {
  const out: InventoryBagSlot[] = [];
  for (let i = 0; i < OFFSETS.inventoryBagCount; i++) {
    const off = OFFSETS.inventoryBagStart + i * OFFSETS.inventoryBagStride;
    const rec = body.subarray(off, off + OFFSETS.inventoryBagStride);
    // Empty sentinel: ff ff ff ff ff 00.
    const isEmpty =
      rec[0] === 0xff && rec[1] === 0xff && rec[2] === 0xff &&
      rec[3] === 0xff && rec[4] === 0xff && rec[5] === 0x00;
    const storedValue = rec[0] | (rec[1] << 8);
    const quantity = rec[5];
    out.push({
      index: i,
      bodyOffset: off,
      empty: isEmpty,
      storedValue,
      // iid is resolved at render time once the inventory_encoding lookup
      // has loaded. Parser stays decode-only on the bytes themselves.
      iid: null,
      quantity,
      rawHex: bytesToHex(rec),
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
// Town residents (8 slots × 0x22F8 at body 0x1E0E0)
// ---------------------------------------------------------------------------

/** Parse the 8-slot town-residents table at body 0x1E0E0 (stride 0x22F8).
 *  §30 confirmed via the 3DS dump upload_12: slot 0 = モコるん (bytes
 *  `e2 30 b3 30 8b 30 93 30 00 00 00 00 00 00 00 00`), slot 1 = ラビーな,
 *  slots 2..3 = vacant zeros, slots 4..7 = 0xFF uninitialised.
 *
 *  Returns every slot (not just populated ones) so the inspector can
 *  show the full 0..7 table with per-slot state. */
function parseTownResidents(body: Uint8Array): TownResident[] {
  const out: TownResident[] = [];
  for (let i = 0; i < OFFSETS.residentsCount; i++) {
    const off = OFFSETS.residentsStart + i * OFFSETS.residentsStride;
    // Defensive: a slot may run past the slot body if the save is
    // truncated. We still emit a record (state=uninitialised) rather than
    // throwing, so the inspector can render gracefully.
    if (off + OFFSETS.residentsNameLen > body.length) {
      out.push({
        index: i,
        bodyOffset: off,
        state: 'uninitialised',
        name: '',
        firstBytesHex: '',
      });
      continue;
    }
    const nameField = body.subarray(off, off + OFFSETS.residentsNameLen);
    let allFF = true;
    let allZero = true;
    for (let j = 0; j < nameField.length; j++) {
      const b = nameField[j];
      if (b !== 0xff) allFF = false;
      if (b !== 0x00) allZero = false;
      if (!allFF && !allZero) break;
    }
    let state: TownResident['state'];
    if (allFF) state = 'uninitialised';
    else if (allZero) state = 'vacant';
    else state = 'populated';
    const name = state === 'populated'
      ? decodeUtf16Le(nameField, OFFSETS.residentsNameLen / 2)
      : '';
    out.push({
      index: i,
      bodyOffset: off,
      state,
      name,
      firstBytesHex: bytesToHex(nameField),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Friends met — NPC encounter / friend-list region at body 0x500..0x4300
// ---------------------------------------------------------------------------

/** Scan body 0x500..0x4300 for u16 LE values in the range 500..751
 *  (valid NPC stored_values per translation-repo step-346), deduplicate
 *  by value, and return the list sorted by stored_value ascending.
 *
 *  We scan EVEN offsets only. The internal sub-tables in this 15 KB
 *  region (encounter log, friend list, gift log, etc.) all align their
 *  u16 stored_value fields on 2-byte boundaries; odd-aligned reads
 *  would walk straight through unrelated record boundaries and pick up
 *  byte-pairs that happen to land in the 500..751 range as false
 *  positives. Empirically on tongari_en.dsv the even-aligned scan
 *  produces exactly the player's met-NPC roster with no noise.
 *
 *  Sub-region boundaries within 0x500..0x4300 aren't yet decoded — the
 *  same stored_value will commonly appear at several offsets (one per
 *  sub-table that references the NPC). We track every offset where the
 *  value appears for diagnostics but display only the deduped list. */
export function parseFriendsMet(body: Uint8Array): FriendMet[] {
  const offsetsByValue = new Map<number, number[]>();
  const lo = OFFSETS.friendsRegionStart;
  const hi = Math.min(OFFSETS.friendsRegionEnd, body.length);
  const vLo = OFFSETS.friendStoredValueMin;
  const vHi = OFFSETS.friendStoredValueMax;
  for (let off = lo; off + 2 <= hi; off += 2) {
    const v = body[off] | (body[off + 1] << 8);
    if (v < vLo || v > vHi) continue;
    let list = offsetsByValue.get(v);
    if (!list) {
      list = [];
      offsetsByValue.set(v, list);
    }
    list.push(off);
  }
  const out: FriendMet[] = [];
  for (const [storedValue, offsets] of offsetsByValue) {
    out.push({
      storedValue,
      bodyOffsets: offsets,
      iid: storedValue - 500,
    });
  }
  out.sort((a, b) => a.storedValue - b.storedValue);
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

/** Parse the collection-bitmap family at slot_rel 0x1CDF0
 *  (translation-repo notes/savefile_format.md §57). Returns one
 *  {offset, maxBits, populatedBits, rawHex, setterAddr, label,
 *  semanticNote} record per spec in COLLECTION_BITMAP_SPECS. Read-only
 *  in the inspector — the only semantically-decoded member of the
 *  family is the §53 clothing+garden inventory, edited elsewhere via
 *  the Inventory Bag section. */
function parseCollectionBitmaps(body: Uint8Array): CollectionBitmap[] {
  return COLLECTION_BITMAP_SPECS.map(spec => ({
    offset: spec.offset,
    maxBits: spec.maxBits,
    populatedBits: popcountBitmapWindow(body, spec.offset, spec.maxBits),
    rawHex: bitmapWindowHex(body, spec.offset, spec.maxBits),
    setterAddr: spec.setterAddr,
    label: spec.label,
    semanticNote: spec.semanticNote,
  }));
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
      saveCounterCompanion: 0xff,
      lastSaveTimestampRawHex: '',
      perSaveFingerprint: 0xffff,
      formatVersionSubcode: 0xffff,
      playerName: '',
      shopName: '',
      townName: '',
      lastSaveTimestamp: { rawHex: '', decoded: '(uninit)' },
      characterCreateTimestamp: { rawHex: '', decoded: '(uninit)' },
      ritch: null,
      activeInventory: [],
      inventoryBag: [],
      catalogEntries: [],
      mailEntries: [],
      garden: { totalTiles: 0, populatedTiles: 0, tiles: [] },
      eventFlags: { totalBytes: 0, setBits: 0, previewHex: '' },
      activityLog: [],
      collectionStats: [],
      bankLog: [],
      townResidents: [],
      wizardLevelCandidate: {
        bodyOffset: OFFSETS.characterRecordsStart + OFFSETS.wizardLevelCandidateOffset,
        rawByte: 0xff,
        plausible: false,
        note: 'Slot is uninitialised.',
      },
      friendsMet: [],
      collectionBitmaps: [],
    };
  }

  // step-258 re-resolution: three independent fields, not three
  // mirrors. See the OFFSETS comment block above for the submission
  // #16 evidence trail.
  const playerName = decodeUtf16Le(
    body.subarray(OFFSETS.playerName, OFFSETS.playerName + OFFSETS.playerNameLen),
    11,
  );

  const shopName = decodeUtf16Le(
    body.subarray(OFFSETS.shopName, OFFSETS.shopName + OFFSETS.shopNameLen),
    16,
  );

  const townName = decodeUtf16Le(
    body.subarray(OFFSETS.townName, OFFSETS.townName + OFFSETS.townNameLen),
    11,
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
    saveCounterCompanion: body[OFFSETS.checksum + 1], // body[1] = body[0] + cartridge salt
    lastSaveTimestampRawHex: bytesToHex(
      body.subarray(OFFSETS.lastSaveTs, OFFSETS.lastSaveTs + 6),
    ),
    perSaveFingerprint: u16le(view, OFFSETS.perSaveFingerprint),
    formatVersionSubcode: u16le(view, OFFSETS.formatSubcode),
    playerName,
    shopName,
    townName,
    lastSaveTimestamp,
    characterCreateTimestamp,
    ritch,
    activeInventory: parseActiveInventory(body, view),
    inventoryBag: parseInventoryBag(body),
    catalogEntries: parseCatalog(body),
    mailEntries: parseMail(body),
    garden: parseGarden(body),
    eventFlags: parseEventFlags(body),
    activityLog: parseActivityLog(body, view),
    collectionStats: parseCollectionStats(body),
    bankLog: parseBankLog(body),
    townResidents: parseTownResidents(body),
    wizardLevelCandidate: parseWizardLevelCandidate(body),
    friendsMet: parseFriendsMet(body),
    collectionBitmaps: parseCollectionBitmaps(body),
  };
}

// ---------------------------------------------------------------------------
// Game 1 (Magician's Quest / Enchanted Folk) decoder
// ---------------------------------------------------------------------------
//
// This entire section is a port of LaytonLoztew's mqreader.js
// (`notes/_external_mqreader.js` in the translation repo, lines
// 2780..3869). The author documented the FULL save layout for Game 1
// only; Game 3 (Tongari Boushi to Oshare na Mahou Tsukai) was left as a
// `printOshareSaveData()` stub. So this decoder runs ONLY when the file
// magic at offset 0x00 matches Game 1.
//
// Detection: file[0x00..0x08] read as u64 big-endian == 0x0DCEAB8906593DA2.
// (mqreader.js line 2877.)
//
// None of our corpus saves are Game 1 — every save we've collected is a
// Tongari Boushi (Game 3) save with magic 0x683093304C308A30. This panel
// is therefore DORMANT in production, but the structural foundation is
// here for if a Magician's Quest / Enchanted Folk save ever shows up.

const GAME1_MAGIC_HEX = '0dceab8906593da2';
const GAME3_MAGIC_HEX = '683093304c308a30';

/** Read a u16 BE at byte offset `at` from `data`. Out-of-range returns 0. */
function u16be(data: Uint8Array, at: number): number {
  if (at + 1 >= data.length) return 0;
  return (data[at] << 8) | data[at + 1];
}

/** Read a u32 LE at byte offset `at` from `data`. */
function u32leAt(data: Uint8Array, at: number): number {
  if (at + 3 >= data.length) return 0;
  return (
    data[at] |
    (data[at + 1] << 8) |
    (data[at + 2] << 16) |
    (data[at + 3] << 24)
  ) >>> 0;
}

/** Read a u16 LE at byte offset `at` from `data`. */
function u16leAt(data: Uint8Array, at: number): number {
  if (at + 1 >= data.length) return 0;
  return data[at] | (data[at + 1] << 8);
}

/** Compute the Game 1 file-level checksum. Per mqreader.js
 *  calcChecksum() lines 2855..2873:
 *      seed = 6825 (0x1AA9)
 *      for i in 0..32768 (= 64 KiB worth of u16 words):
 *          word = u16_BE(i * 2); if i == 16: word = 0
 *          val += word; val %= 65535
 *      return 65535 - val
 *
 *  The stored checksum is a u16 BE at file 0x20. Treating word index 16
 *  (= byte offset 0x20) as zero excludes the stored checksum itself
 *  from the sum so the file is self-verifying.
 *
 *  This is NOT RFC1071 — Konami's seed of 6825 and modulus of 65535
 *  (not 65536) make it a custom one's-complement-style algorithm. */
function computeGame1Checksum(file: Uint8Array): number {
  let val = 6825;
  for (let i = 0; i < 32768; i++) {
    let word = u16be(file, i * 2);
    if (i === 16) word = 0;
    val += word;
    val %= 65535;
  }
  return 65535 - val;
}

/** Detect whether `file` looks like a Game 1 save. We require the first
 *  8 bytes to match the documented Game 1 magic exactly. */
function isGame1File(file: Uint8Array): boolean {
  if (file.length < 8) return false;
  let hex = '';
  for (let i = 0; i < 8; i++) hex += file[i].toString(16).padStart(2, '0');
  return hex === GAME1_MAGIC_HEX;
}

/** Bit n (LSB-first) of byte `data[at]`. */
function getBit(data: Uint8Array, at: number, bit: number): boolean {
  if (at < 0 || at >= data.length) return false;
  return ((data[at] >> bit) & 1) === 1;
}

// LaytonLoztew tables, copied verbatim from mqreader.js lines 4..212 +
// 2786..2840. Kept inline so this decoder has zero external lookups —
// it's a self-contained port of the public reader.

const GAME1_PLAYER_CODES = [0x9df8, 0xb5dc, 0xcdc0, 0xe5a4] as const;

const GAME1_WIZARD_LEVELS = [
  'Apprentice Wizard',
  '1-Star Wizard',
  '2-Star Wizard',
  '3-Star Wizard',
  '4-Star Wizard',
  'Magnus Wizard',
];

const GAME1_HAIRSTYLES = [
  'Crew Cut', 'Center Part', 'Side Part', 'Pigtails', 'Ponytail', 'Bun',
  'Loose Curls', 'Cool Cut', 'Bowl Cut', 'Mop Top', 'Bob Cut', 'Curled Ends',
];

const GAME1_HAIR_COLORS = [
  'Flame', 'Blue', 'Purple', 'Yellow', 'Brown', 'White', 'Pink', 'Green',
];

const GAME1_TITLES = [
  'Wise Wizard', 'Great Wizard', 'Corsair Wizard', 'Evil Wizard',
  'Love Wizard', 'A La Mode Wizard', 'Flower Wizard', 'Stylish Wizard',
  'Gallant Wizard', 'Skull Wizard', 'Insect Wizard', 'Fish Wizard',
];

const GAME1_MAGIC = [
  'Flatulence', 'Metal Basin', 'Spiderweb', 'Sleep', 'Magnetic',
  'Love Insight', 'Transformation', 'Party Popper', 'Cloud Hammock',
  'Shooting Star', 'Treasure Hunt', 'Lightning',
];

const GAME1_INCANTATIONS = [
  'Rainmaking', 'Rainbow', 'Flower rain', 'Star message', 'Friendship',
  'Declare love', 'Sweet dreams', 'Make peace', 'Sit by me', 'Popularity',
  'Honor Student', 'Invisibility', 'Mystery bloom', 'Mystery Gate',
  'Secret saving', 'Sharp-eared', 'Treasure Hunt', 'Lucky', 'Mushroom',
  'Connect doors', 'Phantasm', 'World Tree',
];

const GAME1_MYSTERIES = [
  'Nessie', 'Mokele-mbembe', 'Candyman', 'Portrait', 'Spirit', 'Unicorn',
  'Sphinx', 'Mimic', 'Dragon', 'Martian', 'Doppelganger', 'Werewolf',
  'Death', 'Gargoyle', 'Krampus', 'Minotaur', 'Gremlin', 'Apparition',
  'Ogre', 'Dryad', 'Jack Frost', 'Homunculus', 'Familiar', 'Mermaid',
  'Siren', 'Yeti', 'Cerberus', 'Tom', 'Subterranean', 'Forbidden Tome',
  "Jack-O'-Lantern", 'First Principal', 'Spirited Away', 'Nightmare',
  'Tapir', 'Wild Hound', 'Ghost', 'Satyr', 'Fairy', 'Santa Claus', 'UFO',
  'Wind Weasel', 'Mystery Circle', 'Dullahan', 'Manticore', 'Griffin',
  'Harpy', 'Matchstick Girl', 'Kraken', 'Golem', 'Kappa', 'Leprechaun',
];

const GAME1_CLASSMATES = [
  'Ben', 'Richard', 'Rudolph', 'Cocoa', 'Fifi', 'Zoe', 'Chloe', 'Silvia',
  'Suzy', 'Anson', 'Wuss', 'Chester', 'Theo', 'Damian', 'Bernard', 'Ellis',
  'Pamela', 'Naomi', 'Billy', 'Molly', 'Libby', 'Havana', 'Abasi', 'Ralph',
  'Derrick', 'Whitney', 'Django', 'Stuart', 'Tina', 'Barkley', 'Shawn',
  'Hannah', 'Felicia', 'Rodney', 'Neville', 'Sparkles', 'Napoleon', 'Sammy',
  'Moony', 'Aurora', 'Humphrey', 'Thor', 'Starla', 'Wyatt', 'Troy', 'Holly',
  'Geraldine', 'Sergey', 'Foggy', 'Lucille', 'Mikey', 'Becky', 'Madison',
  'Johnson', 'Grimble', 'Olivia', 'Brett', 'Chelsea', 'Shelly', 'Tot',
  'Frank', 'Sanderson', 'Freya', 'Nigel', 'Matthew', 'Jessica', 'Cherie',
  'Tony', 'Janet', 'Meg', 'Alexander', 'Eric', 'Petra', 'Sonya', 'Laurel',
  'Barbara', 'Petal', 'Victoria', 'Brandy', 'Marty', 'Marsha', 'Kelsey',
  'Gary', 'Lydia', 'Grace', 'James', 'Delcy', 'Blossom', 'TV-20C', 'Sarge',
  'Christine', 'Seth', 'Duke', 'Amber', 'Brownie', 'Patsy', 'Cherry',
  'Kevin', 'Phoebe', 'Abigail',
];

function decodeGame1Player(file: Uint8Array, idx: number): Game1Player {
  const code = GAME1_PLAYER_CODES[idx];
  const enrolled = getBit(file, 0x1c, idx);
  // Player name: 20 bytes (= 10 UTF-16 LE chars max) at code+0.
  // mqreader.js getPlayerName() line 3784 returns "" if first byte is 0xff.
  let name = '';
  if (file[code] !== 0xff) {
    name = decodeUtf16Le(file.subarray(code, code + 20), 10);
  }
  const stars = file[code + 0x40] ?? 0;
  const wizardLevel = file[code + 0x41] ?? 0;
  const wizardLevelName = GAME1_WIZARD_LEVELS[wizardLevel] ?? `(level ${wizardLevel})`;
  const gender = file[code + 0x20d] ?? 0;
  const birthdayDay = file[code + 0x20e] ?? 0;
  const birthdayMonth = file[code + 0x20f] ?? 0;
  const hairstyle = file[code + 0x211] ?? 0;
  const hairColor = file[code + 0x213] ?? 0;
  const ritch = u32leAt(file, code + 0x19e + 0x6a);
  const bankBalance = u32leAt(file, code + 0x1348);

  const slots: number[] = [];
  for (let i = 0; i < 15; i++) {
    slots.push(u16leAt(file, code + 0x19e + i * 2));
  }
  const equipped = {
    shirt: u16leAt(file, code + 0x19e + 0x1e),
    pants: u16leAt(file, code + 0x19e + 0x20),
    shoes: u16leAt(file, code + 0x19e + 0x22),
    headwear: u16leAt(file, code + 0x19e + 0x24),
    eyewear: u16leAt(file, code + 0x19e + 0x26),
    wizardHat: u16leAt(file, code + 0x19e + 0x2a),
  };

  // Titles. mqreader.js lines 3156-3170:
  //   indices 0..4 = bits 3..7 of code+0x2F
  //   indices 5..11 = bits 0..6 of code+0x30
  const titles: Game1Title[] = [];
  const titleBitPositions: Array<[number, number]> = [
    [0x2f, 3], [0x2f, 4], [0x2f, 5], [0x2f, 6], [0x2f, 7],
    [0x30, 0], [0x30, 1], [0x30, 2], [0x30, 3], [0x30, 4],
    [0x30, 5], [0x30, 6],
  ];
  GAME1_TITLES.forEach((titleName, i) => {
    const [off, bit] = titleBitPositions[i];
    titles.push({
      name: titleName,
      bitOffset: code + off,
      bitIndex: bit,
      set: getBit(file, code + off, bit),
    });
  });

  // Magic spells. mqreader.js lines 3172-3186:
  //   indices 0..7 = bits 0..7 of code+0x183
  //   indices 8..11 = bits 0..3 of code+0x184
  const magicSpells: Game1Spell[] = [];
  GAME1_MAGIC.forEach((spellName, i) => {
    const off = i < 8 ? 0x183 : 0x184;
    const bit = i < 8 ? i : i - 8;
    magicSpells.push({
      name: spellName,
      bitOffset: code + off,
      bitIndex: bit,
      set: getBit(file, code + off, bit),
    });
  });

  // Incantations. mqreader.js lines 3188-3212. Note the offset is
  // somewhat unusual: index 0 maps to bit 4 of code+0x185.
  const incantations: Game1Spell[] = [];
  const incantBitPositions: Array<[number, number]> = [
    [0x185, 4], [0x185, 5], [0x185, 6], [0x185, 7],
    [0x186, 0], [0x186, 1], [0x186, 2], [0x186, 3],
    [0x186, 4], [0x186, 5], [0x186, 6], [0x186, 7],
    [0x187, 0], [0x187, 1], [0x187, 2], [0x187, 3],
    [0x187, 4], [0x187, 5], [0x187, 6], [0x187, 7],
    [0x188, 0], [0x188, 1],
  ];
  GAME1_INCANTATIONS.forEach((spellName, i) => {
    const [off, bit] = incantBitPositions[i];
    incantations.push({
      name: spellName,
      bitOffset: code + off,
      bitIndex: bit,
      set: getBit(file, code + off, bit),
    });
  });

  return {
    playerIndex: idx,
    enrolled,
    name,
    wizardLevel,
    wizardLevelName,
    stars,
    gender,
    birthdayMonth,
    birthdayDay,
    hairstyle,
    hairColor,
    ritch,
    bankBalance,
    inventory: { slots, equipped },
    titles,
    magicSpells,
    incantations,
  };
}

function decodeGame1Classmates(file: Uint8Array): Game1Classmate[] {
  // mqreader.js classmateCode = 0x64d8, stride 0xa4 (164B), 11 visible slots.
  const out: Game1Classmate[] = [];
  for (let i = 0; i < 11; i++) {
    const code = 0x64d8 + i * 0xa4;
    const classmateId = file[code + 0x46] ?? 0;
    const friendshipP1 = file[code + 0x14] ?? 0;
    const friendshipP2 = file[code + 0x18] ?? 0;
    const name = classmateId > 0 && classmateId <= GAME1_CLASSMATES.length
      ? GAME1_CLASSMATES[classmateId - 1]
      : '(empty)';
    out.push({
      slotIndex: i,
      classmateId,
      name,
      friendshipP1,
      friendshipP2,
    });
  }
  return out;
}

function decodeGame1Mysteries(file: Uint8Array): Game1MysteryFlag[] {
  // 52 bits at file 0x8FA4..0x8FAA — one bit per mystery.
  const out: Game1MysteryFlag[] = [];
  GAME1_MYSTERIES.forEach((mname, i) => {
    const byteOff = 0x8fa4 + (i >> 3);
    const bit = i & 7;
    out.push({
      index: i,
      name: mname,
      set: getBit(file, byteOff, bit),
    });
  });
  return out;
}

function decodeGame1(file: Uint8Array): Game1Decode | null {
  if (!isGame1File(file)) return null;

  const stored = u16be(file, 0x20);
  const computed = computeGame1Checksum(file);
  const checksum: Game1Checksum = {
    storedHex: '0x' + stored.toString(16).padStart(4, '0'),
    computedHex: '0x' + computed.toString(16).padStart(4, '0'),
    ok: stored === computed,
  };

  const enrolmentByte = file[0x1c] ?? 0;
  const schoolName = decodeUtf16Le(file.subarray(0x8fbc, 0x8fbc + 10), 5);
  const date = {
    year: file[0x2e8] ?? 0,
    month: file[0x2e9] ?? 0,
    day: file[0x2ea] ?? 0,
    hour: file[0x2ec] ?? 0,
    minute: file[0x2ed] ?? 0,
  };

  const players: Game1Player[] = [];
  for (let p = 0; p < 4; p++) {
    players.push(decodeGame1Player(file, p));
  }
  const classmates = decodeGame1Classmates(file);
  const mysteries = decodeGame1Mysteries(file);

  return {
    detected: true,
    checksum,
    enrolmentByte,
    schoolName,
    date,
    classmates,
    mysteries,
    players,
  };
}

// Exported so the UI can format file-magic feedback without re-deriving
// the constants.
export const GAME_MAGIC_HEX = {
  game1: GAME1_MAGIC_HEX,
  game3: GAME3_MAGIC_HEX,
} as const;

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

/** Lexical comparison of two 6-byte timestamp hex strings (YY MM DD HH MM
 *  SS, each field encoded as 2 hex chars). Returns -1 / 0 / +1. Treats
 *  the empty string and an all-zero timestamp as "unset" — returns 0 so
 *  the caller falls back to the next signal. */
function compareLastSaveTimestampHex(aHex: string, bHex: string): number {
  // Unset checks per decodeDatetime(): all-FF or first byte == 0 (with
  // the rest of YY/MM/DD also 0) means the timestamp was never written.
  const aUnset = !aHex || aHex === 'ffffffffffff' || aHex.startsWith('000000');
  const bUnset = !bHex || bHex === 'ffffffffffff' || bHex.startsWith('000000');
  if (aUnset && bUnset) return 0;
  if (aUnset) return -1; // B has a timestamp, A doesn't → B is newer
  if (bUnset) return 1;
  if (aHex < bHex) return -1;
  if (aHex > bHex) return 1;
  return 0;
}

/** Pick the active slot (= the most-recently-written valid slot). The
 *  NDS ping-pong save scheme keeps both slot A and slot B independently
 *  valid; either may be the "current" one depending on which the last
 *  in-game save landed in. Discovered in step-254 after the inventory
 *  editor (step-253) hardcoded reads from slot A and showed the wrong
 *  contents whenever the most recent save was in slot B.
 *
 *  Discriminators, in priority order:
 *    1. Last-save timestamp at body[0x494..0x49A] (YY MM DD HH MM SS) —
 *       the most semantically meaningful "which slot was written last"
 *       signal. Compared lexicographically since the field encoding is
 *       already big-endian-ordered for chronological comparison.
 *    2. Counter companion at body[0x01] (per-slot counter+salt). Differs
 *       even when body[0x00] is identical, as in Tyler's tongari_en.dsv
 *       where both slots store 0x9D at body[0x00] but slot A stores
 *       0xFD vs slot B 0xFE at body[0x01].
 *    3. The per-slot save counter at body[0x00] — kept as a tertiary
 *       fallback for legacy callers.
 *    4. If every numerical signal ties, default to slot A (documented
 *       primary per §13). */
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
    // 1. Last-save timestamp comparison (preferred — semantically clear).
    const tsCmp = compareLastSaveTimestampHex(
      a.lastSaveTimestampRawHex,
      b.lastSaveTimestampRawHex,
    );
    if (tsCmp !== 0) {
      const label: SlotLabel = tsCmp > 0 ? 'A' : 'B';
      const other: SlotLabel = label === 'A' ? 'B' : 'A';
      return {
        label,
        reason:
          `Slot ${label} last-save timestamp (body[0x494]=${label === 'A' ? a.lastSaveTimestampRawHex : b.lastSaveTimestampRawHex}) ` +
          `> ${other} (${other === 'A' ? a.lastSaveTimestampRawHex : b.lastSaveTimestampRawHex}).`,
      };
    }
    // 2. Counter-companion at body[0x01] — survives the body[0x00]-tie
    //    case present in some saves.
    if (a.saveCounterCompanion !== b.saveCounterCompanion) {
      if (a.saveCounterCompanion > b.saveCounterCompanion) {
        return {
          label: 'A',
          reason:
            `Slot A counter-companion (body[0x01]=0x${a.saveCounterCompanion.toString(16)}) ` +
            `> B (0x${b.saveCounterCompanion.toString(16)}); timestamps tied.`,
        };
      }
      return {
        label: 'B',
        reason:
          `Slot B counter-companion (body[0x01]=0x${b.saveCounterCompanion.toString(16)}) ` +
          `> A (0x${a.saveCounterCompanion.toString(16)}); timestamps tied.`,
      };
    }
    // 3. body[0x00] counter — final tie-breaker before defaulting.
    if (a.saveCounter !== b.saveCounter) {
      if (a.saveCounter > b.saveCounter) {
        return {
          label: 'A',
          reason: `Slot A counter (body[0x00]=0x${a.saveCounter.toString(16)}) > B (0x${b.saveCounter.toString(16)}); timestamps + companion tied.`,
        };
      }
      return {
        label: 'B',
        reason: `Slot B counter (body[0x00]=0x${b.saveCounter.toString(16)}) > A (0x${a.saveCounter.toString(16)}); timestamps + companion tied.`,
      };
    }
    return {
      label: 'A',
      reason: 'Every active-slot signal tied; defaulting to A (documented primary).',
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
      game1: null,
      payloadSha256: '',
      fileSha256,
      activeSlot: null,
      activeSlotReason: 'Could not strip wrapper.',
    };
  }

  const payload = wrapper.payload;
  const payloadSha256 = await sha256Hex(payload);
  const preamble = parsePreamble(payload);

  // Game 1 (Magician's Quest / Enchanted Folk) decode — fires ONLY when
  // the file magic at 0x00 matches Game 1. Returns null for every Tongari
  // Boushi (Game 3) save in our corpus.
  const game1 = decodeGame1(payload);

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
    game1,
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
  profile: { id: 'profile', title: 'Player + Shop + Town names (3 independent fields, editable)', range: 'player body[0x1149C]; shop body[0x114B2]; town body[0x47E]', confidence: 'candidate' as const },
  inventory: { id: 'inventory', title: 'Region at body 0x4300 — semantics unconfirmed (previously labelled "active inventory")', range: 'body[0x4300:0x4480], 8-byte stride', confidence: 'disputed' as const },
  inventoryBag: { id: 'inventoryBag', title: 'Inventory bag — 15 slots (editable)', range: 'body[0x1D9B6:0x1DA14], 6-byte stride; per-slot u16 LE stored_value + 3B pad + u8 quantity', confidence: 'confirmed' as const },
  activityLog: { id: 'activityLog', title: 'Activity log', range: 'body[0x0B500:0x0B900], 9-byte records', confidence: 'candidate' as const },
  collectionStats: { id: 'collectionStats', title: 'Collection statistics', range: 'body[0x11550:0x115F4], 14-byte records', confidence: 'candidate' as const },
  garden: { id: 'garden', title: 'Garden plant tile state', range: 'body[0x12400:0x16000], 12-byte records', confidence: 'confirmed' as const },
  catalog: { id: 'catalog', title: 'Shop catalog announcement board (editable + removable)', range: 'body[0x162B6+], 168-byte stride (6-byte header + 162-byte UTF-16 text body)', confidence: 'confirmed' as const },
  mail: { id: 'mail', title: 'Per-NPC mail bodies', range: 'body[0x17400+], 168-byte stride', confidence: 'confirmed' as const },
  ritch: { id: 'ritch', title: 'Ritch (wallet)', range: 'body[0x1CFD0], u32 LE', confidence: 'confirmed' as const },
  bankLog: { id: 'bankLog', title: 'Bank transaction log', range: 'body[0x1CFD4:0x1E0E0], 6-byte records', confidence: 'candidate' as const },
  townResidents: { id: 'townResidents', title: 'Town residents (8 slots × 0x22F8)', range: 'body[0x1E0E0:0x2F8A0], 0x22F8-byte stride, max 8 residents; first 16 B per slot = UTF-16 LE NPC name', confidence: 'confirmed' as const },
  friendsMet: { id: 'friendsMet', title: 'Friends met — NPCs encountered / befriended (read-only)', range: 'body[0x500:0x4300], u16 LE stored_value in 500..751 (= npc_data_ofs_id + 500), even-aligned scan', confidence: 'candidate' as const },
  collectionBitmaps: { id: 'collectionBitmaps', title: 'Collection bitmaps — 10-bitmap family at slot+0x1CDF0 (read-only)', range: 'body[0x1CDF2:0x1D0BD], 459 bytes; ten same-shape bit sets serviced by ARM9 0x0201BCB0', confidence: 'candidate' as const },
  timestamps: { id: 'timestamps', title: 'Last-save + character-create timestamps', range: 'body[0x494] / body[0x4A4]', confidence: 'confirmed' as const },
  game1: { id: 'game1', title: "Game 1 (Magician's Quest / Enchanted Folk) decoder — dormant for Game 3", range: 'file[0x00..0x80000], LaytonLoztew-documented layout', confidence: 'confirmed' as const },
};

export const FORMAT_MAGIC_EXPECTED = FORMAT_MAGIC;
