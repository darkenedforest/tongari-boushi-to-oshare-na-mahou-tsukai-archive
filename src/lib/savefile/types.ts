// Types describing what we currently know how to parse out of a Tongari
// Boushi save file. Mirrors the regions documented in
// `notes/savefile_format.md` of the translation repo as of step-176/177.
//
// Confidence:
//   - 'confirmed'  : exact byte semantics nailed down via differential test
//                    saves or ARM9 disassembly.
//   - 'candidate'  : structure clear but field semantics unverified.
//   - 'disputed'   : a previously-shipped interpretation has been rejected
//                    by later evidence; the raw bytes still display but
//                    their meaning is unknown. See per-region note text
//                    for the rejection trail.

export type Confidence = 'confirmed' | 'candidate' | 'disputed';

export type SlotLabel = 'A' | 'B';

export interface WrapperInfo {
  /** Original byte length of the file as the user supplied it. */
  originalSize: number;
  /** 'dsv' = DeSmuME 122-byte footer detected, 'raw' = 524288 bytes raw EEPROM. */
  kind: 'dsv' | 'raw' | 'unknown';
  /** Final 524288-byte payload after wrapper stripping, or null if unrecognised. */
  payload: Uint8Array | null;
  /** Hex of the trailing footer bytes when kind === 'dsv'; null otherwise. */
  footerHex: string | null;
  /** Human-readable explanation of the size mismatch when kind === 'unknown'. */
  error: string | null;
}

export interface PreambleInfo {
  /** UTF-16 LE decode of the first 16 bytes (the title magic). */
  titleMagic: string;
  /** True iff titleMagic === '「とんがり　２．５」'. */
  titleMagicOk: boolean;
  /** byte at preamble offset 0x10. */
  saveGenCounter: number;
  /** byte at preamble offset 0x11 (mirror of 0x10). */
  saveGenCounterMirror: number;
  /** True iff counter == counterMirror. */
  counterPaired: boolean;
}

export interface ChecksumInfo {
  storedHex: string;
  computedHex: string;
  ok: boolean;
}

export interface DateTimeInfo {
  /** The raw 8 bytes as a hex string. */
  rawHex: string;
  /** Decoded ISO-like date string, or '(unset)' when bytes are 0/FF. */
  decoded: string;
}

/** Raw 8-byte record at body[0x4300:0x4480] stride 8. The "category /
 *  sub_index" decomposition is a HOLDOVER from the rejected step-176/177
 *  framework — step-232 found no ARM9 accessor touches this region and
 *  the (cat<<8)|sub mapping was an artifact of misreading a u16 LE item
 *  ID. We retain the fields purely so the UI can keep showing the raw
 *  bytes; their semantics are unknown. See `notes/save_analysis/
 *  _blockers.md` (step-232 entry) for the full rejection trail. */
export interface InventorySlot {
  /** Slot offset relative to slot body. */
  bodyOffset: number;
  /** High byte of the first u16 at this offset. Semantics unconfirmed. */
  category: number;
  /** Low byte of the first u16 at this offset. Semantics unconfirmed. */
  subIndex: number;
  /** Hex of the remaining 6 trailing bytes. Semantics unconfirmed. */
  trailingHex: string;
}

/** One of the 15 player-inventory bag slots starting at body 0x1D9B6, stride
 *  6 bytes. The on-disk record layout is:
 *    +0..1  u16 LE stored_value (game's internal item-ID — distinct from the
 *           itemname.ofs positional iid; see public/data/inventory_encoding.json
 *           for the iid↔stored mapping).
 *    +2..4  three padding bytes (always 0x00 0x00 0x00 in known saves).
 *    +5     u8  quantity (1..255 when occupied).
 *    empty: ff ff ff ff ff 00 (sentinel — slot is unused).
 *  Encoding cracked in the translation repo's step-260 research (ARM9 lookup
 *  function 0x0200BB2C + per-category base/count tables). */
export interface InventoryBagSlot {
  /** 0..14 — slot position within the 15-entry bag. */
  index: number;
  /** Slot-A body offset of this record (= 0x1D9B6 + index*6). */
  bodyOffset: number;
  /** True if this slot is the empty sentinel `ff ff ff ff ff 00`. */
  empty: boolean;
  /** u16 LE at +0..2 (the stored_value). 0xFFFF for empty slots. */
  storedValue: number;
  /** Decoded iid (positional index into itemname.ofs / item-names lookup), or
   *  null if the stored_value doesn't map to a known item or the slot is
   *  empty. */
  iid: number | null;
  /** Quantity byte at +5. 0 for empty slots. */
  quantity: number;
  /** Hex of the full 6-byte record for debugging. */
  rawHex: string;
}

export interface CatalogEntry {
  index: number;
  bodyOffset: number;
  /** UTF-16 LE decode of the body text. */
  text: string;
  /** First 8 bytes (header) as hex. */
  headerHex: string;
}

export interface MailEntry {
  index: number;
  bodyOffset: number;
  text: string;
  headerHex: string;
}

export interface GardenTile {
  index: number;
  bodyOffset: number;
  plantId: number;
  growTime: number;
  /** Hex of the full 12-byte record for context. */
  rawHex: string;
}

export interface GardenSummary {
  totalTiles: number;
  populatedTiles: number;
  /** Populated tiles only — empty tiles (all 0x00 or 0xFF) are filtered. */
  tiles: GardenTile[];
}

export interface ActivityRecord {
  index: number;
  bodyOffset: number;
  /** First 3 bytes — record header. */
  headerHex: string;
  /** Bytes 3..7 as u32 LE. */
  dateOrSequence: number;
  /** Bytes 7..9 as u16 LE. */
  countOrState: number;
  /** Whether all 9 bytes are 0xFF (sentinel). */
  sentinel: boolean;
}

export interface CollectionStatRecord {
  index: number;
  bodyOffset: number;
  /** 14 raw bytes as hex. */
  rawHex: string;
}

export interface BankRecord {
  index: number;
  bodyOffset: number;
  /** 6 raw bytes as hex. */
  rawHex: string;
}

/** One slot of the 8-entry town residents table at body 0x1E0E0
 *  (stride 0x22F8 bytes, max 8 residents). Confirmed via the
 *  3DS dump upload_12 which has populated residents モコるん +
 *  ラビーな at slots 0..1 and vacant zeros at slots 2..3.
 *
 *  Each slot can be in one of three states:
 *    - 'populated'  — currently lives in the player's town; first 16
 *                     bytes hold the UTF-16 LE NPC name.
 *    - 'vacant'     — was once active but the resident moved out;
 *                     bytes are zeroed (slot can be reused).
 *    - 'uninitialised' — slot never used; bytes are 0xFF.
 *
 *  Field map per `notes/savefile_format.md` §30:
 *    +0x00..0x0F  NPC name (UTF-16 LE, zero-padded; max 8 chars)
 *    +0x10..0x1F  padding
 *    +0x20..0x420 house decoration bitmap
 *    +0x420..end  relationship stats / affinity history / gift log /
 *                  dialog-seen flags
 *  We parse only the name + state byte here; the inspector renders
 *  the rest as read-only diagnostic bytes if needed. */
export type TownResidentState = 'populated' | 'vacant' | 'uninitialised';

export interface TownResident {
  /** 0..7 — slot position within the 8-entry table. */
  index: number;
  /** Slot-A body offset of this record (= 0x1E0E0 + index*0x22F8). */
  bodyOffset: number;
  /** Tri-state per the first 16 bytes (the name field). */
  state: TownResidentState;
  /** Decoded UTF-16 LE NPC name for populated slots; '' otherwise. */
  name: string;
  /** First 16 bytes of the slot as hex, for raw diagnostics. */
  firstBytesHex: string;
}

/** One row in the per-slot "Friends Met" view — a friend / met-NPC found
 *  in the save-body 0x500..0x4300 NPC-history region.
 *
 *  Encoding (translation-repo step-346): the u16 LE `stored_value` is
 *  `npc_data_ofs_id + 500`, range 500..751 across the 252 NPCs catalogued
 *  in `notes/npc_encoding.json`. The save's encounter-log / friend-list /
 *  gift-log sub-tables within 0x500..0x4300 each reference the same NPC by
 *  storing the same u16 at multiple offsets, so we deduplicate per
 *  stored_value to produce a clean per-NPC list rather than per-offset
 *  noise.
 *
 *  The resolved `name_en`, `name_jp`, `iid`, `category`, and
 *  `categoryLabel` are filled in by SaveFileInspector.tsx at render time
 *  from the loaded NPC encoding JSON (the parser stays bundle-light by
 *  not embedding all 252 names). When the JSON is still loading these
 *  fields are null / empty and only the `storedValue` is shown. */
export interface FriendMet {
  /** u16 LE stored_value (500..751) found in body 0x500..0x4300. */
  storedValue: number;
  /** All body offsets in 0x500..0x4300 where this stored_value was found.
   *  Useful for diagnostics; the display surfaces the count rather than
   *  every offset. Even-aligned scan only — see parseFriendsMet doc. */
  bodyOffsets: number[];
  /** Resolved npc_data_ofs_id = storedValue - 500. */
  iid: number;
}

export interface EventFlagSummary {
  /** Total bytes in the region 0x18..0x460. */
  totalBytes: number;
  /** Total set bits across the region. */
  setBits: number;
  /** First 64 bytes as hex for preview. */
  previewHex: string;
}

/** One collection-style bitmap in the family at slot_rel 0x1CDF0
 *  (translation-repo notes/savefile_format.md §57). All ten bitmaps in
 *  this family are produced by ARM9 setters that funnel into the
 *  bounds-checked bit primitive at 0x0201BCB0. Each is a thin wrapper
 *  with its own (base, max_bits) pair. The first (offset 0x1CDF2, 173
 *  bits) is the clothing+garden inventory from §53; the other nine are
 *  same-family bitmaps whose semantics are still TBD pending the
 *  caller-of-setters trace (step-365). */
export interface CollectionBitmap {
  /** Slot-relative body offset where this bitmap's bytes start. */
  offset: number;
  /** Max bit count (= argument the ARM9 setter passes to the bit
   *  primitive). The on-disk byte width is `ceil(maxBits / 8)`. */
  maxBits: number;
  /** Population count — number of bits actually set in this slot's
   *  copy of the bitmap. Diagnostic; useful for spot-identifying which
   *  bitmap a category likely lives in. */
  populatedBits: number;
  /** Hex of the bitmap bytes for the diagnostic raw view. */
  rawHex: string;
  /** ARM9 setter function address that owns this bitmap (literal pool
   *  word found in step-364 trace). Surfaced for debugging only. */
  setterAddr: number;
  /** Human-readable label when the semantic is known, or null when it
   *  is still TBD pending the caller-of-setters trace. */
  label: string | null;
  /** Brief note shown in the inspector (e.g. "§53 confirmed",
   *  "magazines-read candidate"). Always populated; tells the user
   *  what to do with the row even when `label === null`. */
  semanticNote: string;
}

export interface WizardLevelCandidate {
  /** Body offset (= 0x11488 + 0x5a). */
  bodyOffset: number;
  /** Raw byte read from that offset. */
  rawByte: number;
  /** Heuristic flag — true if the value looks like a plausible level
   *  (0..99 range across a corpus that spans fresh→heavily-played). False
   *  today because all 55 saves in step-223's corpus stored 0x00. */
  plausible: boolean;
  /** Human-readable explanation surfaced in the UI next to the value. */
  note: string;
}

export interface SlotParse {
  label: SlotLabel;
  /** True if the slot body is entirely 0xFF — never used. */
  uninitialised: boolean;

  // Header (body[0x00..0x14])
  checksum: ChecksumInfo;
  /** Body-level RFC1071 checksum over body[0x14..0x14+0x1CDDC] with the
   *  first 2 bytes zeroed, stored at body[0x14:0x16]. Phase-7 step-219
   *  discovery; step-223 validation confirmed against 53/55 corpus saves.
   *  Any editor touching bytes >= body[0x14] (and inside the body-csum
   *  range) MUST recompute this. */
  bodyChecksum: ChecksumInfo;
  /** Extra[0] RFC1071 checksum over extra[0][0..0x22F8] with the first 2
   *  bytes zeroed, stored at extra[0][0:2]. extra[0] is the per-slot
   *  Family-C meta record starting at slot+0x1CDF0 (file 0x01CEF0 for
   *  slot A, 0x05CDF0 for slot B). Ritch (slot+0x1CFD0 = extra[0]+0x1E0)
   *  lives inside this region, so any Ritch edit invalidates this csum.
   *  step-234 discovery — the previous editor.ts did NOT recompute this
   *  csum after Ritch edits, producing saves the game refuses to load. */
  extra0Checksum: ChecksumInfo;
  /** body[0x02:0x04] LE — expected 0x0161. */
  formatVersionMagic: number;
  /** body[0x06] active-flag. */
  activeFlag: number;
  /** body[0x07] other-slot indicator. */
  otherSlotByte: number;
  /** body[0x00] — per-slot save-write counter. */
  saveCounter: number;
  /** body[0x01] — counter companion (body[0x00] + per-cartridge salt per
   *  §20). Differs between slots by ±1 when the slots have written at
   *  different cadences, even when body[0x00] is identical, so it's a
   *  reliable secondary signal for active-slot detection. */
  saveCounterCompanion: number;
  /** Raw 6-byte last-save timestamp at body[0x494..0x49A] (YY MM DD HH MM
   *  SS encoding per §22). Byte-wise lexical comparison orders the slots
   *  chronologically — used by chooseActiveSlot to pick the
   *  most-recently-written slot. Empty string if the slot is
   *  uninitialised. */
  lastSaveTimestampRawHex: string;
  /** body[0x14:0x16] LE — per-save fingerprint random. */
  perSaveFingerprint: number;
  /** body[0x16:0x18] LE — format version sub-code (0x0900=v2.31, 0x102C=3DS). */
  formatVersionSubcode: number;

  // Profile region (step-258 re-resolution — three INDEPENDENT fields,
  // not three mirrors of one field as step-252 mistakenly believed):
  //   - body 0x1149C : PLAYER name  (character-record copy)
  //   - body 0x114B2 : SHOP name    (the player's shop / business name)
  //   - body 0x47E   : TOWN name    (the player's town name)
  // Submission #16 (Harry Potter playthrough with distinct
  // player="WEASLEY" / shop="Shop Weasleys" / town="HOGSMEADE") refuted
  // step-252's "all three are player-name mirrors" claim. The
  // pre-step-258 editor's player_name edit kind wrote to all three
  // offsets and corrupted town + shop on every player rename.
  /** Player display name from the character record at body 0x1149C. */
  playerName: string;
  /** Shop name from body 0x114B2 (UTF-16 LE; 12 bytes / 6 chars
   *  editor-exposed). Submitted saves have shown the field can hold
   *  more than 12 bytes (e.g. "Shop Weasleys" = 26 bytes), but the
   *  editor caps writes at 6 chars to match the in-game name-entry
   *  surface. */
  shopName: string;
  /** Town name from body 0x47E (10 bytes UTF-16 LE / 5 chars). */
  townName: string;
  lastSaveTimestamp: DateTimeInfo;
  characterCreateTimestamp: DateTimeInfo;

  // Wallet (body 0x1CFD0..0x1CFD4)
  ritch: number | null;

  // Raw 8-byte records at body[0x4300..0x4480]. Previously labelled
  // "active inventory"; step-232 rejected that framework. Surfaced read-
  // only as a research region (see InventorySlot doc above).
  activeInventory: InventorySlot[];

  /** Player inventory bag — 15 fixed slots at body 0x1D9B6, stride 6 bytes.
   *  Each slot is either the empty sentinel `ff ff ff ff ff 00` or a
   *  populated record with u16 LE stored_value + 3 padding bytes + u8
   *  quantity. Encoding cracked in translation-repo step-260. */
  inventoryBag: InventoryBagSlot[];

  // Catalog announcements (0x163F2 stride 0xA8)
  catalogEntries: CatalogEntry[];

  // Per-NPC mail (0x17400+ stride 0xA8)
  mailEntries: MailEntry[];

  // Garden plant tiles (0x12400..0x16000, 12-byte records)
  garden: GardenSummary;

  // Event flag region (0x18..0x460)
  eventFlags: EventFlagSummary;

  // Activity log (0x0B500..0x0B900, 9-byte records)
  activityLog: ActivityRecord[];

  // Collection statistics (0x11550..0x115F4, 14 records of variable size)
  collectionStats: CollectionStatRecord[];

  // Bank transaction log (0x1CFD4..0x1E0E0, 6-byte records)
  bankLog: BankRecord[];

  // Town residents table — 8 fixed slots × 0x22F8 stride at body 0x1E0E0.
  // §30 confirmed via the 3DS dump upload_12 (slots 0..1 populated with
  // モコるん / ラビーな; slots 2..3 vacant zeros; slots 4..7 uninitialised
  // 0xFF). Read-only in the inspector — editing residents in/out would
  // require copying ROM templates whose location we haven't pinned, but
  // surfacing the roster + per-slot state matches the rest of the editor's
  // diagnostic depth.
  townResidents: TownResident[];

  // Wizard-level candidate (body 0x11488 + 0x5a). Read-only.
  wizardLevelCandidate: WizardLevelCandidate;

  /** Friends / NPCs met — deduplicated list of u16 LE stored_values in
   *  the range 500..751 found at even-aligned offsets in body
   *  0x500..0x4300. NPC encoding cracked in translation-repo step-346.
   *  Read-only in the inspector — sub-region boundaries inside that 15 KB
   *  block (encounter log / friend list / gift log) aren't decoded yet,
   *  so we can't safely add or remove individual entries. */
  friendsMet: FriendMet[];

  /** Collection-bitmap family at slot_rel 0x1CDF0 (translation-repo
   *  notes/savefile_format.md §57, step-364). Ten same-shape bitmaps
   *  packed back-to-back, all serviced by the bit primitive at ARM9
   *  0x0201BCB0. Read-only — the inventory one is bit-by-bit cracked
   *  in §53 and editable elsewhere via inventoryBag; the other nine
   *  are surfaced as semantics-TBD diagnostic rows so the family is
   *  visible in the inspector while the caller-of-setters trace
   *  (step-365) pins their meanings. */
  collectionBitmaps: CollectionBitmap[];
}

// ---------------------------------------------------------------------------
// Game 1 (Magician's Quest / Enchanted Folk) decoder — DORMANT for Game 3
// ---------------------------------------------------------------------------
//
// LaytonLoztew's mqreader.js (notes/_external_mqreader.js in the
// translation repo) documents the full save layout for Game 1 ONLY. Our
// corpus is entirely Game 3 saves, so this panel will be empty for every
// known save in the wild today — but if a Game 1 (Magician's Quest /
// Enchanted Folk) cartridge save ever shows up, this decoder will fire
// and the inspector will render real, attributed data.
//
// Detection: file[0x00..0x08] as u64 big-endian == 0x0DCEAB8906593DA2.
// Source: mqreader.js displayFile() switch at line 2875.

export interface Game1Checksum {
  /** Stored u16 BE at file 0x20. */
  storedHex: string;
  /** Computed via the Konami custom algorithm (NOT RFC1071):
   *   seed = 6825; for i in 0..32768: add u16-BE at i*2, skip i==16,
   *   sum %= 65535; return 65535 - sum. */
  computedHex: string;
  ok: boolean;
}

export interface Game1Title {
  name: string;
  bitOffset: number;
  bitIndex: number;
  set: boolean;
}

export interface Game1Spell {
  name: string;
  bitOffset: number;
  bitIndex: number;
  set: boolean;
}

export interface Game1Classmate {
  /** Slot index 0..10 (11 in-town classmate slots). */
  slotIndex: number;
  /** u8 classmate ID at code+0x46. 0 = empty slot. */
  classmateId: number;
  /** Display name from the 100-entry classmates[] table in mqreader.js. */
  name: string;
  /** Friendship with player 1 (0..32). */
  friendshipP1: number;
  /** Friendship with player 2 (0..32). */
  friendshipP2: number;
}

export interface Game1Inventory {
  /** 15 u16 LE item IDs. 0x0000 means empty. */
  slots: number[];
  /** Equipped items in fixed slots — u16 LE item IDs. */
  equipped: {
    shirt: number;
    pants: number;
    shoes: number;
    headwear: number;
    eyewear: number;
    wizardHat: number;
  };
}

export interface Game1Player {
  /** 0..3 — which player record (game supports 4). */
  playerIndex: number;
  /** True iff bit `playerIndex` of file[0x1C] is set. */
  enrolled: boolean;
  /** UTF-16 LE up to 10 chars. */
  name: string;
  /** Magician Level 0..5 (Apprentice → Magnus). */
  wizardLevel: number;
  wizardLevelName: string;
  /** Stars sub-stat 0..4. */
  stars: number;
  /** u8 — 0=Male, 1=Female. */
  gender: number;
  birthdayMonth: number;
  birthdayDay: number;
  hairstyle: number;
  hairColor: number;
  ritch: number;
  bankBalance: number;
  inventory: Game1Inventory;
  titles: Game1Title[];
  magicSpells: Game1Spell[];
  incantations: Game1Spell[];
}

export interface Game1MysteryFlag {
  index: number;
  name: string;
  set: boolean;
}

export interface Game1Decode {
  /** Always true when this object exists — file magic matched. */
  detected: true;
  /** File-level checksum (Konami sum, NOT RFC1071). */
  checksum: Game1Checksum;
  /** Enrolment bitmap at file 0x1C. */
  enrolmentByte: number;
  /** School name, 10 bytes at file 0x8FBC. */
  schoolName: string;
  /** Date/time read from file 0x2E8..0x2ED (5 u8 fields). */
  date: { year: number; month: number; day: number; hour: number; minute: number };
  /** Active classmate pool — 11 slots × 164 bytes at file 0x64D8. */
  classmates: Game1Classmate[];
  /** 52 mysteries (one bit each) at file 0x8FA4..0x8FAA. */
  mysteries: Game1MysteryFlag[];
  /** Per-player records. */
  players: Game1Player[];
}

export interface SaveParse {
  wrapper: WrapperInfo;
  preamble: PreambleInfo | null;
  slotA: SlotParse | null;
  slotB: SlotParse | null;
  /** Game 1 decode IFF the file magic matches Game 1. Null for Game 3
   *  saves (the whole inspector's normal case). */
  game1: Game1Decode | null;
  /** SHA-256 hex of the wrapper-stripped raw EEPROM payload. */
  payloadSha256: string;
  /** SHA-256 hex of the original file bytes as supplied (including any wrapper). */
  fileSha256: string;
  /** Best-effort guess at which slot is currently the "active" save. */
  activeSlot: SlotLabel | null;
  /** Human-readable explanation of how activeSlot was chosen. */
  activeSlotReason: string;
}

/** Region descriptors used to drive the UI sectioning. */
export interface RegionDescriptor {
  id: string;
  title: string;
  /** Brief offset notation, e.g. '0x1CFD0, u32 LE'. */
  range: string;
  confidence: Confidence;
}
