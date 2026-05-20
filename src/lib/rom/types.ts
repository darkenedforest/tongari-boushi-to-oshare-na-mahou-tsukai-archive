// Types for the browser-side NDS ROM parser used by the Translation Viewer
// page. All parsing happens in-memory on a Uint8Array — nothing is uploaded.
//
// The parser is intentionally read-only and scoped to the surfaces the viewer
// renders. Initial scope: msg98 family (bulletins + letters).

export interface NdsHeader {
  game_title: string;          // 12 chars, ASCII
  game_code: string;           // 4 chars (we expect "YTRJ" for Tongari Boushi (J))
  rom_size: number;            // total length we got from the user
  fat_offset: number;
  fat_size: number;
  fnt_offset: number;
  fnt_size: number;
}

/** Map from file ID (FAT index) -> ROM-relative path, e.g.
 *  1653 -> "message/msg98/00/msg98000.ofs". */
export type FntMap = Map<number, string>;

/** Map from ROM-relative path -> file ID. */
export type PathToIdMap = Map<string, number>;

export interface FatEntry {
  file_id: number;
  start: number;
  end: number;
  size: number;
}

export interface ResoHeader {
  magic: string;               // "RESO" (always — we reject otherwise)
  file_count: number;
  version: string;             // e.g. "1.21" (trimmed)
  variant: number;             // 0 = type-tagged (16-byte entries), 1 = simple (8-byte)
}

export interface ResoEntry {
  index: number;
  type_tag: string;            // empty for variant-1
  length: number;
  data_offset: number;         // offset within the container, NOT the ROM
  unk: number;                 // 0 for variant-1
}

/** A single token extracted from a dialog entry payload. */
export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'cmd'; opcode: number; tag: string; raw_hex: string; args: number[] };

/** A "Textblock" (the project's permanent term — never call this a screen or
 *  sub-entry) is one (entry_id, sub_entry_id) record from a single RESO entry.
 *  For msg98 files there's only ever one Textblock per entry (sub_entry_id=0).
 *  We keep the structure flexible so later phases can expose speaker-split
 *  Textblocks too. */
export interface Textblock {
  entry_id: number;
  sub_entry_id: number;
  /** Wire-format JP text with `▼` line breaks, `§` page breaks, and
   *  `[TAG_NAME]` / `<i>HEXHEX</i>` markers for opcodes. Matches the same
   *  display format the desktop translation tool uses. */
  jp_wire: string;
  /** Plain-text JP, stripped of every marker — search-friendly. */
  jp_plain: string;
}

/** One file's worth of extracted JP, keyed by entry_id + sub_entry_id. The
 *  shape mirrors the EN lookup so we can join on (entry_id, sub_entry_id). */
export interface ExtractedFileJP {
  file_path: string;
  file_id: number;
  /** Total RESO entries the file declares (file_count from the header), so
   *  we can show empty slots in the UI even when the EN side has no row. */
  reso_entry_count: number;
  /** Map<`${entry_id}.${sub_entry_id}`, Textblock>. We avoid nested objects
   *  for cheap lookup. */
  textblocks: Map<string, Textblock>;
}

/** Top-level result of a successful ROM extraction for the configured scope. */
export interface RomExtraction {
  header: NdsHeader;
  /** One entry per file in scope. */
  files: ExtractedFileJP[];
  /** Per-file_path -> ExtractedFileJP, for fast lookup in the viewer. */
  by_path: Map<string, ExtractedFileJP>;
  generated_at: number;
}

export interface RomParseProgress {
  phase: 'reading' | 'header' | 'fnt' | 'fat' | 'extract' | 'done';
  files_done?: number;
  files_total?: number;
  message?: string;
}

export type WorkerInbound =
  | { type: 'parse'; buffer: ArrayBuffer; expected_paths: string[] };

export type WorkerOutbound =
  | { type: 'progress'; progress: RomParseProgress }
  | {
      type: 'done';
      header: NdsHeader;
      // We serialize the Maps as plain arrays for postMessage. The main
      // thread re-hydrates them.
      files: Array<{
        file_path: string;
        file_id: number;
        reso_entry_count: number;
        textblocks: Array<[string, Textblock]>;
      }>;
    }
  | { type: 'error'; message: string };
