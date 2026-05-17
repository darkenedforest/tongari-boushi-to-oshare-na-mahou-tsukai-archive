// Lazy-fetched ID -> EN name lookup tables for the save-file inspector.
//
// The source JSON is generated in the translation repo by
//   src/translator/_export_savefile_lookups.py
// and committed to this repo at `public/data/savefile_lookups.json`.
// It contains:
//   - items   : ROM item_id   -> EN name   (3322 entries)
//   - ucc     : ROM slot_index -> EN craft name (168 entries)
//   - npcs    : ROM npc_id    -> EN name   (252 entries)
//   - plants  : plant_id      -> EN name   (0 entries today — mapping pending)
//
// We do a single fetch on first use and cache the parsed object in memory
// for the lifetime of the page. Network failure falls back to empty
// tables so the inspector still renders (it just shows raw IDs).

export interface SavefileLookups {
  items: Record<string, string>;
  ucc: Record<string, string>;
  npcs: Record<string, string>;
  plants: Record<string, string>;
  counts: { items: number; ucc: number; npcs: number; plants: number };
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
  generated_at: '',
  ok: false,
};

let cached: SavefileLookups | null = null;
let inflight: Promise<SavefileLookups> | null = null;

export async function loadSavefileLookups(
  url = '/data/savefile_lookups.json',
): Promise<SavefileLookups> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
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
// The active inventory stores each slot as a packed u16 where the top
// byte is a category and the low byte is a sub-index within that
// category. The ROM holds a per-category dispatch table that maps
// (category, sub_index) to an item_id, but we have not yet exported that
// mapping for browser use.
//
// What IS confirmed today:
//   - (category=2, sub_index=6) -> item_id 1887 (Transmitter), via
//     differential save analysis on step-176 / step-177.
//
// Until the full table ships, we expose this single entry plus a clear
// "Unknown item (cat=N, sub=M)" framing for everything else. We do NOT
// guess — names only show when the mapping is confirmed.
// ---------------------------------------------------------------------------

const CONFIRMED_CAT_SUB_TO_ITEM_ID: Record<string, number> = {
  '2:6': 1887, // Transmitter
};

export function resolveInventoryItem(
  lookups: SavefileLookups,
  category: number,
  subIndex: number,
): { itemId: number | null; name: string | null } {
  const key = `${category}:${subIndex}`;
  const itemId = CONFIRMED_CAT_SUB_TO_ITEM_ID[key];
  if (itemId === undefined) {
    return { itemId: null, name: null };
  }
  return { itemId, name: lookupItemName(lookups, itemId) };
}
