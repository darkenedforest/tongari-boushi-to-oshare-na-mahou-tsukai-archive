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
  };
  inventory_cat_sub: InventoryCatSubLookup;
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
        inventory_cat_sub: {
          confirmed: data.inventory_cat_sub?.confirmed ?? {},
          observed: data.inventory_cat_sub?.observed ?? {},
        },
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
