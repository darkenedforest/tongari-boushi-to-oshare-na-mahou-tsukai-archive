// Decoders for the slot regions mapped by the 2026-10-06 live-RAM traces
// (translation repo notes/savefile_format.md §58 and the four region notes
// notes/save_analysis/_trace_region_{A,B,C,D}*.md). Everything here reads a
// slot image indexed by slot_rel offset (slot A = file 0x100 + x) and
// returns plain data; naming (item / NPC names) is done by the UI through
// the lookup tables.
//
// Regions covered:
//   * the four player-character records at 0x1CDF0 + n·0x22F8 (wallet,
//     bank, dates, name, body type, per-record checksum)
//   * the 140 per-NPC records at 0x1257C (affinity 0..100 at +7)
//   * the player's shop (0x17DA2) and the two display ledgers inside the
//     character record (0x1149C + 0xA8 / + 0x1B0)
//   * the 8 player-named custom items at 0x1AECA
//   * the world object storage: outdoor grid 0x4AC (7680 × 5) and the 43
//     placed-object lists at 0x9AB0

import { inetCsum16 } from './parser';

// --- Player records (extra records) ----------------------------------------

export const PLAYER_RECORD_BASE = 0x1cdf0;
export const PLAYER_RECORD_SIZE = 0x22f8;
export const PLAYER_RECORD_COUNT = 4;
/** Header byte: bit n set ⇒ player record n exists. */
export const HEADER_PLAYER_MASK = 0x06;
/** Header byte: index of the player last saved (the one the title resumes). */
export const HEADER_LAST_PLAYER = 0x0b;

export const PR_WALLET = 0x1e0;
export const PR_BANK = 0x1e4;
export const PR_NPC_RELATIONS = 0x1e8; // 140 × 5
export const PR_LAST_SAVE_HALFHOUR = 0x1d1;
export const PR_LAST_SAVE_DATE = 0x1d2;
export const PR_CREATION_DATE = 0x1d6;
export const PR_PLAYER_INDEX = 0xbb4;
export const PR_BAG = 0xbc6; // 15 × 6
export const PR_CHAR_RECORD = 0x12f0; // 0x20: name[16], +0x17 body type, +0x1A.. appearance
export const PR_DWC_USER = 0x1c18; // 64 B, CRC32 at +0x3C
export const PR_VARS = 0x1fd8; // script-variable region 1, 0x320
/** Script variable 0x1002: wizard level 1..50. The license card draws
 *  badge tier = level ÷ 10 (capped 5) and stars = level mod 10 − 1 (9 at 50).
 *  Overlay ov091 0x0215D0E8. */
export const PR_WIZARD_LEVEL = 0x1fda;
/** Script variable 0x1003: rank text index 0..5 (message container 1812
 *  entry 30 + rank). ov091 0x0215D2CE. */
export const PR_WIZARD_RANK = 0x1fdb;
/** Equipped-slot table: nine 5-byte item tokens at bag+0x54C; slot 7 is the
 *  title item (3284..3289 = Apprentice Magus .. Grand Magus), slot 8 the wand. */
export const PR_EQUIPPED = 0xbc6 + 0x54c;
export const WIZARD_LEVEL_MAX = 50;
export const WIZARD_RANK_MAX = 5;
export const WIZARD_RANK_NAMES = [
  'Apprentice',
  '1-Star Wizard',
  '2-Star Wizard',
  '3-Star Wizard',
  '4-Star Wizard',
  'Great Wizard',
];

export const WALLET_MAX = 999_999;
export const BANK_MAX = 9_999_999;

export interface GameDate {
  year: number;
  month: number;
  day: number;
  weekday: number;
  text: string;
}

function readDate(b: Uint8Array, off: number): GameDate {
  const y = b[off], m = b[off + 1], d = b[off + 2], wd = b[off + 3];
  const valid = m < 12 && d < 31;
  return {
    year: 2000 + y,
    month: m + 1,
    day: d + 1,
    weekday: wd,
    text: valid ? `${2000 + y}-${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}` : '(unset)',
  };
}

function u16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}
function u32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function utf16(b: Uint8Array, off: number, maxUnits: number): string {
  let s = '';
  for (let i = 0; i < maxUnits; i++) {
    const u = u16(b, off + 2 * i);
    if (u === 0) break;
    s += String.fromCharCode(u);
  }
  return s;
}

export interface PlayerRecord {
  index: number;
  slotOffset: number;
  /** Header existence bit for this index. */
  exists: boolean;
  /** Whole record is 0xFF (never written). */
  blank: boolean;
  checksumStored: number;
  checksumComputed: number;
  checksumOk: boolean;
  /** P+0 — the index the record says it is. */
  storedIndex: number;
  wallet: number;
  bank: number;
  lastSaveDate: GameDate;
  lastSaveHalfHour: number;
  creationDate: GameDate;
  /** Character-record name (filled only by some builds; often empty). */
  name: string;
  bodyType: number;
  bagUsed: number;
  wizardLevel: number;
  rankIndex: number;
  /** Item stored_values in equipped slots 7 (title) and 8 (wand); 0xFFFF = none. */
  titleItem: number;
  wandToken: number;
}

/** RFC1071 over one player record with its checksum halfword zeroed. */
export function playerRecordChecksum(slot: Uint8Array, index: number): number {
  const base = PLAYER_RECORD_BASE + index * PLAYER_RECORD_SIZE;
  const region = new Uint8Array(PLAYER_RECORD_SIZE);
  region.set(slot.subarray(base, base + PLAYER_RECORD_SIZE));
  region[0] = 0;
  region[1] = 0;
  return inetCsum16(region);
}

export function parsePlayerRecords(slot: Uint8Array): PlayerRecord[] {
  const out: PlayerRecord[] = [];
  const mask = slot[HEADER_PLAYER_MASK] ?? 0;
  for (let n = 0; n < PLAYER_RECORD_COUNT; n++) {
    const base = PLAYER_RECORD_BASE + n * PLAYER_RECORD_SIZE;
    if (base + PLAYER_RECORD_SIZE > slot.length) break;
    let blank = true;
    for (let i = 0; i < 0x40; i++) {
      if (slot[base + i] !== 0xff) {
        blank = false;
        break;
      }
    }
    const stored = u16(slot, base);
    const computed = blank ? 0xffff : playerRecordChecksum(slot, n);
    let bagUsed = 0;
    for (let i = 0; i < 15; i++) {
      const o = base + PR_BAG + i * 6;
      if (!(slot[o] === 0xff && slot[o + 1] === 0xff)) bagUsed++;
    }
    out.push({
      index: n,
      slotOffset: base,
      exists: Boolean(mask & (1 << n)),
      blank,
      checksumStored: stored,
      checksumComputed: computed,
      checksumOk: blank || stored === computed,
      storedIndex: slot[base + PR_PLAYER_INDEX],
      wallet: u32(slot, base + PR_WALLET),
      bank: u32(slot, base + PR_BANK),
      lastSaveDate: readDate(slot, base + PR_LAST_SAVE_DATE),
      lastSaveHalfHour: slot[base + PR_LAST_SAVE_HALFHOUR],
      creationDate: readDate(slot, base + PR_CREATION_DATE),
      name: blank ? '' : utf16(slot, base + PR_CHAR_RECORD, 8),
      bodyType: slot[base + PR_CHAR_RECORD + 0x17],
      bagUsed,
      wizardLevel: slot[base + PR_WIZARD_LEVEL],
      rankIndex: slot[base + PR_WIZARD_RANK],
      titleItem: u16(slot, base + PR_EQUIPPED + 7 * 5),
      wandToken: u16(slot, base + PR_EQUIPPED + 8 * 5),
    });
  }
  return out;
}

/** Which player record the editor should treat as "the player": the one
 *  the header says was saved last, if it exists; else the first existing
 *  one; else 0. */
export function chooseActivePlayer(slot: Uint8Array, records: PlayerRecord[]): number {
  const last = slot[HEADER_LAST_PLAYER] ?? 0;
  if (last < records.length && records[last].exists && !records[last].blank) return last;
  const first = records.find(r => r.exists && !r.blank);
  return first ? first.index : 0;
}

// --- Per-NPC records (0x1257C, 140 × 0x70) ---------------------------------

export const NPC_RECORD_BASE = 0x1257c;
export const NPC_RECORD_SIZE = 0x70;
export const NPC_RECORD_COUNT = 140;
export const NPC_AFFINITY_OFF = 7;
export const NPC_AFFINITY_MAX = 100;

export interface NpcRecord {
  /** 0..139 = speaker id − 1000 = npc_data_ofs_id (stored_value − 500). */
  index: number;
  slotOffset: number;
  /** Item stored_value at +0 (0xFFFF = none): the item this NPC took from the player's shop. */
  itemStored: number;
  /** +7: 0..100, the stat the game raises/lowers with the −10/−10/+15/+100/+30/+20 table. */
  affinity: number;
  /** +8 bit0: affinity was raised. */
  raised: boolean;
  /** +9..+0x10 eight clamped counters. */
  counters: number[];
  /** +0x6D / +0x6E (variable region 5 u8 cells). */
  var5004: number;
  var5005: number;
  /** True when the record is all zero (NPC never interacted with). */
  untouched: boolean;
}

export function parseNpcRecords(slot: Uint8Array): NpcRecord[] {
  const out: NpcRecord[] = [];
  for (let i = 0; i < NPC_RECORD_COUNT; i++) {
    const base = NPC_RECORD_BASE + i * NPC_RECORD_SIZE;
    if (base + NPC_RECORD_SIZE > slot.length) break;
    let untouched = true;
    for (let k = 0; k < NPC_RECORD_SIZE; k++) {
      if (slot[base + k] !== 0) {
        untouched = false;
        break;
      }
    }
    const counters: number[] = [];
    for (let k = 0; k < 8; k++) counters.push(slot[base + 9 + k]);
    out.push({
      index: i,
      slotOffset: base,
      itemStored: u16(slot, base),
      affinity: slot[base + NPC_AFFINITY_OFF],
      raised: (slot[base + 8] & 1) === 1,
      counters,
      var5004: slot[base + 0x6d],
      var5005: slot[base + 0x6e],
      untouched,
    });
  }
  return out;
}

// --- Character record 0: shop display ledgers --------------------------------

export const CHAR_RECORD_BASE = 0x1149c;
export const CHAR_RECORD_SIZE = 0x438;
const LEDGER_OFF = 0xa8;
const LEDGER_SET_STRIDE = 0x108;
const LEDGER_ENTRY = 0xc;
const LEDGER_COUNT = 22;

export interface ShopLedgerEntry {
  set: number;
  slot: number;
  slotOffset: number;
  moneyTaken: number;
  unitsSold: number;
  stock: number;
  /** 0xFF = empty; free slots 0–14 index an external list, fixed slots 15–21 index the 7-item packed set. */
  itemRef: number;
  fixed: boolean;
  /** Item stored_value when the entry is a fixed slot (from the packed 7-item set), else null. */
  itemStored: number | null;
}

export interface ShopLedger {
  entries: ShopLedgerEntry[];
  /** +0x2CC cumulative sales total (achievement at 1,000,000). */
  lifetimeTotal: number;
  counters: number[];
}

export function parseShopLedger(slot: Uint8Array): ShopLedger {
  const rec = CHAR_RECORD_BASE;
  const entries: ShopLedgerEntry[] = [];
  for (let set = 0; set < 2; set++) {
    const packedSet = rec + 0x60 + 0x23 * set; // 7 × 5-byte items
    for (let k = 0; k < LEDGER_COUNT; k++) {
      const o = rec + LEDGER_OFF + set * LEDGER_SET_STRIDE + k * LEDGER_ENTRY;
      if (o + LEDGER_ENTRY > slot.length) break;
      const itemRef = slot[o + 9];
      const fixed = (slot[o + 0xa] & 1) === 1;
      let itemStored: number | null = null;
      if (fixed && itemRef < 7) {
        const v = u16(slot, packedSet + itemRef * 5);
        itemStored = v === 0xffff ? null : v;
      }
      entries.push({
        set,
        slot: k,
        slotOffset: o,
        moneyTaken: u32(slot, o),
        unitsSold: u16(slot, o + 6),
        stock: slot[o + 8],
        itemRef,
        fixed,
        itemStored,
      });
    }
  }
  const counters: number[] = [];
  for (let k = 0; k < 6; k++) counters.push(u32(slot, rec + 0x2b8 + 4 * k));
  return { entries, lifetimeTotal: u32(slot, rec + 0x2cc), counters };
}

// --- Player's shop (0x17DA2) ---------------------------------------------

export const SHOP_BASE = 0x17da2;
const SHELF_STRIDE = 0x16;

export interface ShopShelf {
  index: number;
  slotOffset: number;
  itemStored: number;
  discountPct: number;
  slot: number;
  price1: number;
  price2: number;
}

export interface PlayerShop {
  shelves: ShopShelf[];
  /** +0x160: 16 item refs. */
  displayItems: number[];
  featuredItem: number;
  /** +0x1B5, 0..2 after thresholds 2 / 5 in the raw byte. */
  rankRaw: number;
}

function s16(v: number): number {
  return v & 0x8000 ? v - 0x10000 : v;
}

export function parsePlayerShop(slot: Uint8Array): PlayerShop {
  const shelves: ShopShelf[] = [];
  for (let i = 0; i < 16; i++) {
    const o = SHOP_BASE + i * SHELF_STRIDE;
    shelves.push({
      index: i,
      slotOffset: o,
      itemStored: u16(slot, o),
      discountPct: slot[o + 0xc],
      slot: slot[o + 0xd],
      price1: s16(u16(slot, o + 0x10)),
      price2: s16(u16(slot, o + 0x12)),
    });
  }
  const displayItems: number[] = [];
  for (let i = 0; i < 16; i++) displayItems.push(u16(slot, SHOP_BASE + 0x160 + i * 5));
  return {
    shelves,
    displayItems,
    featuredItem: u16(slot, SHOP_BASE + 0x1b0),
    rankRaw: slot[SHOP_BASE + 0x1b5],
  };
}

// --- Custom-named items (0x1AECA, 8 × 0x5E) ------------------------------

export const CUSTOM_ITEMS_BASE = 0x1aeca;

export interface CustomItem {
  index: number;
  slotOffset: number;
  name: string;
  itemStored: number;
}

export function parseCustomItems(slot: Uint8Array): CustomItem[] {
  const out: CustomItem[] = [];
  for (let i = 0; i < 8; i++) {
    const o = CUSTOM_ITEMS_BASE + i * 0x5e;
    out.push({ index: i, slotOffset: o, name: utf16(slot, o, 44), itemStored: u16(slot, o + 0x58) });
  }
  return out;
}

// --- World object storage ---------------------------------------------------

export const OUTDOOR_GRID_BASE = 0x4ac;
export const OUTDOOR_GRID_CELLS = 7680; // 6 areas × 16 rows × 80 cols
export const OBJECT_LISTS_BASE = 0x9ab0;
export const OBJECT_LIST_SIZE = 0x124; // 32 × 9 + 4
export const OBJECT_LIST_COUNT = 43;

/** Owner of each placed-object list (translation repo note A §4). */
export const OBJECT_LIST_OWNERS: Record<number, string> = {
  0: 'Town buildings',
  1: 'Wardrobe shop stock',
  3: "Player's garden",
  4: 'Room (desk / table / sofa set)',
  5: "Player's room",
  6: 'Bathroom',
  7: 'Room (unexpanded)',
  8: 'Room (unexpanded)',
  9: 'NPC house 1', 10: 'NPC house 2', 11: 'NPC house 3', 12: 'NPC house 4', 13: 'NPC house 5',
  14: 'NPC house 6', 15: 'NPC house 7', 16: 'NPC house 8', 17: 'NPC house 9', 18: 'NPC house 10',
  19: 'NPC house 11',
  20: 'Wallpaper shop stock',
  21: 'Instrument shop stock',
  22: 'Elixir shop stock',
  23: 'Furniture shop stock',
  24: 'Clothes shop stock',
  25: 'Garden shop stock',
  26: 'Wig shop stock',
  27: 'Reserved (init 0xFF)',
  28: 'Convenience store',
  32: 'Market wagon 1', 33: 'Market wagon 2', 34: 'Market wagon 3', 35: 'Market wagon 4',
  36: 'Market wagon 5', 37: 'Market wagon 6', 38: 'Market wagon 7',
};

export interface ObjectListSummary {
  index: number;
  slotOffset: number;
  owner: string;
  used: number;
  /** stored_values of the first few occupied records. */
  sample: number[];
}

export interface WorldObjects {
  outdoorCellsUsed: number;
  /** stored_value → count across the outdoor grid. */
  outdoorCounts: Map<number, number>;
  lists: ObjectListSummary[];
}

export function parseWorldObjects(slot: Uint8Array): WorldObjects {
  const outdoorCounts = new Map<number, number>();
  let used = 0;
  for (let i = 0; i < OUTDOOR_GRID_CELLS; i++) {
    const o = OUTDOOR_GRID_BASE + i * 5;
    const v = u16(slot, o);
    if (v === 0 || v === 0xffff) continue;
    used++;
    outdoorCounts.set(v, (outdoorCounts.get(v) ?? 0) + 1);
  }
  const lists: ObjectListSummary[] = [];
  for (let n = 0; n < OBJECT_LIST_COUNT; n++) {
    const base = OBJECT_LISTS_BASE + n * OBJECT_LIST_SIZE;
    let count = 0;
    const sample: number[] = [];
    for (let k = 0; k < 32; k++) {
      const v = u16(slot, base + k * 9);
      if (v === 0 || v >= 0xfffe) continue;
      count++;
      if (sample.length < 6) sample.push(v);
    }
    lists.push({ index: n, slotOffset: base, owner: OBJECT_LIST_OWNERS[n] ?? 'Unused', used: count, sample });
  }
  return { outdoorCellsUsed: used, outdoorCounts, lists };
}
