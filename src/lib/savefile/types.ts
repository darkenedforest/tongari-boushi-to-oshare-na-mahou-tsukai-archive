// Types describing what we currently know how to parse out of a Tongari
// Boushi save file. Mirrors the regions documented in
// `notes/savefile_format.md` of the translation repo as of step-176/177.
//
// Confidence:
//   - 'confirmed'  : exact byte semantics nailed down via differential test
//                    saves or ARM9 disassembly.
//   - 'candidate'  : structure clear but field semantics unverified.

export type Confidence = 'confirmed' | 'candidate';

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

export interface InventorySlot {
  /** Slot offset relative to slot body. */
  bodyOffset: number;
  /** Top byte of packed u16 — item category. */
  category: number;
  /** Low byte of packed u16 — item sub-index within category. */
  subIndex: number;
  /** Hex of the remaining 6 trailing bytes (acquisition time/flags). */
  trailingHex: string;
}

export interface ResidentInfo {
  index: number;
  bodyOffset: number;
  /** 'uninit' (all 0xFF — never inhabited), 'vacant' (all zero), or 'active'. */
  state: 'uninit' | 'vacant' | 'active';
  /** UTF-16 LE name when state === 'active'. */
  name: string;
  /** First 32 bytes of the record as hex (preview). */
  previewHex: string;
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

export interface NpcRecord {
  index: number;
  bodyOffset: number;
  /** First 16 bytes decoded as UTF-16 LE — the NPC name. */
  name: string;
  /** Whether the first 16 bytes were all 0xFF (never met). */
  uninit: boolean;
  /** Whether the first 16 bytes were all zero (record cleared). */
  vacant: boolean;
  /** Hex preview of first 32 bytes after the name. */
  previewHex: string;
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

export interface EventFlagSummary {
  /** Total bytes in the region 0x18..0x460. */
  totalBytes: number;
  /** Total set bits across the region. */
  setBits: number;
  /** First 64 bytes as hex for preview. */
  previewHex: string;
}

export interface SlotParse {
  label: SlotLabel;
  /** True if the slot body is entirely 0xFF — never used. */
  uninitialised: boolean;

  // Header (body[0x00..0x14])
  checksum: ChecksumInfo;
  /** body[0x02:0x04] LE — expected 0x0161. */
  formatVersionMagic: number;
  /** body[0x06] active-flag. */
  activeFlag: number;
  /** body[0x07] other-slot indicator. */
  otherSlotByte: number;
  /** body[0x00] — per-slot save-write counter. */
  saveCounter: number;
  /** body[0x14:0x16] LE — per-save fingerprint random. */
  perSaveFingerprint: number;
  /** body[0x16:0x18] LE — format version sub-code (0x0900=v2.31, 0x102C=3DS). */
  formatVersionSubcode: number;

  // Profile region (body 0x460..0x4B0)
  playerName: string;
  lastSaveTimestamp: DateTimeInfo;
  characterCreateTimestamp: DateTimeInfo;

  // Wallet (body 0x1CFD0..0x1CFD4)
  ritch: number | null;

  // Active inventory (body 0x4300..0x4480)
  activeInventory: InventorySlot[];

  // Catalog announcements (0x163F2 stride 0xA8)
  catalogEntries: CatalogEntry[];

  // Per-NPC mail (0x17400+ stride 0xA8)
  mailEntries: MailEntry[];

  // Per-NPC relationship records (0x119C0+ — list raw record names)
  npcRecords: NpcRecord[];

  // Town residents (0x1E0E0 stride 0x22F8, max 8)
  residents: ResidentInfo[];

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
}

export interface SaveParse {
  wrapper: WrapperInfo;
  preamble: PreambleInfo | null;
  slotA: SlotParse | null;
  slotB: SlotParse | null;
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
