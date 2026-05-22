// Lazy-fetched ID -> EN name lookup tables for the save-file inspector.
//
// The source JSON is generated in the translation repo by
//   src/translator/_export_savefile_lookups.py
// and committed to this repo at `public/data/savefile_lookups.json`.
// It contains:
//   - items             : ROM item_id   -> EN name   (3322 entries)
//   - ucc               : ROM slot_index -> EN craft name (168 entries)
//   - npcs              : ROM npc_id    -> EN name   (252 entries)
//   - plants            : plant_id      -> EN name   (0 entries — pending)
//   - inventory_cat_sub : packed cat:sub -> ROM item_id (confirmed) +
//                         packed cat:sub -> N-saves-seen-in (observed)
//
// We do a single fetch on first use and cache the parsed object in memory
// for the lifetime of the page. Network failure falls back to empty
// tables so the inspector still renders (it just shows raw IDs).

export interface InventoryCatSubLookup {
  /** (cat, sub) -> ROM item_id, only verified pairs. */
  confirmed: Record<string, number>;
  /** (cat, sub) -> count of saves the pair appears in (corpus statistic). */
  observed: Record<string, number>;
}

/** Step-237 inventory-bitmap descriptor. See parser.ts for the
 *  ARM9-disassembly trace that pins this region. */
export interface InventoryBitmapLookup {
  /** Slot-relative byte offset of the bitmap's first byte. */
  slot_rel_offset: number;
  /** Bitmap length in bytes (always 22). */
  byte_length: number;
  /** Number of meaningful bits (always 173 = 140 cat-0 + 33 cat-1). */
  bit_count: number;
  /** Per-category metadata mirroring the ARM9 tables. */
  categories: Array<{
    id: number;
    item_id_base: number;
    count: number;
    bit_index_base: number;
  }>;
  /** Reverse lookup: ROM item_id -> bit_index within the bitmap. */
  item_id_to_bit: Record<string, number>;
}

export interface SavefileLookups {
  items: Record<string, string>;
  ucc: Record<string, string>;
  npcs: Record<string, string>;
  plants: Record<string, string>;
  counts: {
    items: number;
    ucc: number;
    npcs: number;
    plants: number;
    cat_sub_pairs_confirmed?: number;
    cat_sub_pairs_observed?: number;
    inventory_bitmap_items?: number;
  };
  inventory_cat_sub: InventoryCatSubLookup;
  inventory_bitmap: InventoryBitmapLookup | null;
  generated_at: string;
  /** True if the JSON loaded successfully; false on fetch / parse error. */
  ok: boolean;
}

const EMPTY: SavefileLookups = {
  items: {},
  ucc: {},
  npcs: {},
  plants: {},
  counts: { items: 0, ucc: 0, npcs: 0, plants: 0 },
  inventory_cat_sub: { confirmed: {}, observed: {} },
  inventory_bitmap: null,
  generated_at: '',
  ok: false,
};

let cached: SavefileLookups | null = null;
let inflight: Promise<SavefileLookups> | null = null;

/** Default URL for the lookups JSON. The Astro site is served under a
 *  base path (see `astro.config.mjs`); using a bare `/data/...` URL
 *  resolves to the site root, which 404s on GitHub Pages. Prepend
 *  `import.meta.env.BASE_URL` so the request goes to the correct
 *  subdirectory. step-249 fix — before this change, the inventory-bitmap
 *  rows in the inspector showed `(item_id N — name unavailable)` for
 *  every item because the lookups payload never loaded. */
function defaultLookupsUrl(): string {
  let base = (import.meta.env.BASE_URL ?? '/').toString();
  if (!base.endsWith('/')) base += '/';
  return `${base}data/savefile_lookups.json`;
}

export async function loadSavefileLookups(
  url?: string,
): Promise<SavefileLookups> {
  if (cached) return cached;
  if (inflight) return inflight;
  const resolvedUrl = url ?? defaultLookupsUrl();
  inflight = (async () => {
    try {
      const res = await fetch(resolvedUrl, { cache: 'force-cache' });
      if (!res.ok) {
        cached = EMPTY;
        return cached;
      }
      const data = await res.json();
      cached = {
        items: data.items ?? {},
        ucc: data.ucc ?? {},
        npcs: data.npcs ?? {},
        plants: data.plants ?? {},
        counts: data.counts ?? { items: 0, ucc: 0, npcs: 0, plants: 0 },
        inventory_cat_sub: {
          confirmed: data.inventory_cat_sub?.confirmed ?? {},
          observed: data.inventory_cat_sub?.observed ?? {},
        },
        inventory_bitmap: data.inventory_bitmap ?? null,
        generated_at: data.generated_at ?? '',
        ok: true,
      };
      return cached;
    } catch {
      cached = EMPTY;
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// ---------------------------------------------------------------------------
// Per-table accessors used by the inspector.
// ---------------------------------------------------------------------------

/** Look up an EN item name by `item_id`. Returns null when the lookup
 *  table is empty (not yet loaded) or the ID isn't mapped. */
export function lookupItemName(
  lookups: SavefileLookups,
  itemId: number,
): string | null {
  const k = String(itemId);
  return lookups.items[k] ?? null;
}

/** Look up an EN UCC (game-craft) name by slot index. */
export function lookupUccName(
  lookups: SavefileLookups,
  slotIndex: number,
): string | null {
  return lookups.ucc[String(slotIndex)] ?? null;
}

/** Look up an EN NPC name by `npc_id`. */
export function lookupNpcName(
  lookups: SavefileLookups,
  npcId: number,
): string | null {
  return lookups.npcs[String(npcId)] ?? null;
}

/** Look up a plant name by `plant_id` — currently always null because the
 *  source table is empty (no confirmed plant_id -> name mapping yet). */
export function lookupPlantName(
  lookups: SavefileLookups,
  plantId: number,
): string | null {
  return lookups.plants[String(plantId)] ?? null;
}

// ---------------------------------------------------------------------------
// Inventory cat/sub_index -> item_id mapping.
//
// step-232 withdrew the single previously-shipped mapping
// `(2:6) -> 1887 (Transmitter)`. The full evidence is in the translation
// repo at `notes/save_analysis/_blockers.md` (step-232 entry). Short
// version: the (cat<<8)|sub framework itself is unsupported by ARM9
// disassembly — there is no accessor at body+0x4300..0x4480, and the
// "confirmed" Transmitter pair was an artifact of misreading a u16 LE
// item ID as a packed (cat, sub) tuple. The save that supposedly
// contained a Transmitter does not contain the bytes 0x5F 0x07 anywhere.
//
// `inventory_cat_sub.confirmed` therefore ships EMPTY today. A real
// mapping requires either ARM9 disassembly of the actual inventory
// routine (still unidentified) or a controlled before/after differential
// save corpus that shows a single item appearing.
//
// `inventory_cat_sub.observed` still ships the corpus statistic so the
// inspector can tell the user "this byte pattern recurs at the
// predecessor's inventory offsets in N saves" — useful even though we
// know the (cat, sub) decoding itself is suspect. Treat the counts as a
// byte-pattern recurrence stat, not as actual inventory pairs.
// ---------------------------------------------------------------------------

export interface InventoryResolution {
  /** Confirmed ROM item ID, when (cat, sub) is in the confirmed table. */
  itemId: number | null;
  /** Confirmed EN item name, when itemId is known AND items table has it. */
  name: string | null;
  /** Count of saves in our corpus where this (cat, sub) appeared. */
  seenInSaves: number;
}

export function resolveInventoryItem(
  lookups: SavefileLookups,
  category: number,
  subIndex: number,
): InventoryResolution {
  const key = `${category}:${subIndex}`;
  const itemId = lookups.inventory_cat_sub.confirmed[key];
  const seenInSaves = lookups.inventory_cat_sub.observed[key] ?? 0;
  if (itemId === undefined) {
    return { itemId: null, name: null, seenInSaves };
  }
  return { itemId, name: lookupItemName(lookups, itemId), seenInSaves };
}

// ---------------------------------------------------------------------------
// Inventory-bag encoding: iid ↔ stored_value bijection (translation-repo
// step-260). The on-disk 6-byte inventory records at body 0x1D9B6 store a
// u16 LE `stored_value` which is the game's internal item-ID, NOT the
// itemname.ofs positional iid. The mapping is loaded once from
// /data/inventory_encoding.json and cached. All 3346 items map both ways.
// ---------------------------------------------------------------------------

export interface InventoryEncoding {
  /** iid (0..3345) → stored_value (u16). Always 3346 entries when ok=true. */
  iidToStored: Record<number, number>;
  /** stored_value (u16) → iid (0..3345). Reverse of iidToStored. */
  storedToIid: Record<number, number>;
  /** True if the JSON loaded and parsed; false on fetch/parse error. */
  ok: boolean;
}

const EMPTY_ENCODING: InventoryEncoding = {
  iidToStored: {},
  storedToIid: {},
  ok: false,
};

let encodingCached: InventoryEncoding | null = null;
let encodingInflight: Promise<InventoryEncoding> | null = null;

function defaultInventoryEncodingUrl(): string {
  let base = (import.meta.env.BASE_URL ?? '/').toString();
  if (!base.endsWith('/')) base += '/';
  return `${base}data/inventory_encoding.json`;
}

export async function loadInventoryEncoding(
  url?: string,
): Promise<InventoryEncoding> {
  if (encodingCached) return encodingCached;
  if (encodingInflight) return encodingInflight;
  const resolvedUrl = url ?? defaultInventoryEncodingUrl();
  encodingInflight = (async () => {
    try {
      const res = await fetch(resolvedUrl, { cache: 'force-cache' });
      if (!res.ok) {
        encodingCached = EMPTY_ENCODING;
        return encodingCached;
      }
      const data = await res.json();
      const raw = data?.mapping_iid_to_stored ?? {};
      const iidToStored: Record<number, number> = {};
      const storedToIid: Record<number, number> = {};
      for (const [k, v] of Object.entries(raw)) {
        const iid = Number(k);
        const stored = Number(v);
        if (!Number.isFinite(iid) || !Number.isFinite(stored)) continue;
        iidToStored[iid] = stored;
        storedToIid[stored] = iid;
      }
      encodingCached = {
        iidToStored,
        storedToIid,
        ok: Object.keys(iidToStored).length > 0,
      };
      return encodingCached;
    } catch {
      encodingCached = EMPTY_ENCODING;
      return encodingCached;
    } finally {
      encodingInflight = null;
    }
  })();
  return encodingInflight;
}

/** Reverse-lookup: 6-byte record's stored_value → iid (positional itemname.ofs
 *  index). Returns null when the encoding hasn't loaded or the value isn't in
 *  the bijection (would indicate a corrupt save). */
export function lookupIidFromStored(
  encoding: InventoryEncoding,
  storedValue: number,
): number | null {
  const iid = encoding.storedToIid[storedValue];
  return iid === undefined ? null : iid;
}

/** Forward-lookup: iid → stored_value to write back into the 6-byte record. */
export function lookupStoredFromIid(
  encoding: InventoryEncoding,
  iid: number,
): number | null {
  const stored = encoding.iidToStored[iid];
  return stored === undefined ? null : stored;
}
