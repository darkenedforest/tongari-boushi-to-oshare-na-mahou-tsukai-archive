// In-browser parser for the Tongari Boushi NDS ROM. Reads the user-supplied
// .nds file as a Uint8Array, walks the FAT/FNT, locates RESO containers
// across every translated surface, and extracts each entry's UTF-16-LE
// wire-format JP text.
//
// This is intentionally read-only — the file never leaves the browser.
//
// Ports (from main repo):
//   src/archive/fnt.py            — FAT/FNT walker
//   src/archive/reso.py           — RESO container header + entry table
//   src/translator/wire_format.py — opcode tokenizer (TERMINATOR / CMD_OPEN / ARG_SEP / CMD_CLOSE)
//   src/translator/opcode_registry.py — tag-name mapping (see opcodeRegistry.ts)
//
// Scope (step-326): every translated `.ofs` container in the FAT — covers
// `message/*` (story scripts, NPC dialog, personality variant chat,
// bulletins, letters, lookups), `onemsg/*`, and `2d/inputmagic/msg.ofs`.
// All are RESO v1.21 variant-1, stored uncompressed in the FAT — no
// LZ11/BLZ decompression needed. Out-of-scope (have no JP↔EN entry
// alignment in the DB): npc/, item/, recipe/, overlay binaries, ARM9
// strings. Those surfaces have separate fix-manifest streams.

import { BODY_MARKER_OPCODES, formatTag } from './opcodeRegistry';
import type {
  ExtractedFileJP,
  FatEntry,
  FntMap,
  NdsHeader,
  ResoEntry,
  ResoHeader,
  Textblock,
  Token,
} from './types';

// ---------------------------------------------------------------------------
// NDS ROM header
// ---------------------------------------------------------------------------

export function parseNdsHeader(rom: Uint8Array): NdsHeader {
  if (rom.length < 0x180) {
    throw new Error(
      `File is only ${rom.length.toLocaleString()} bytes — that's not a Nintendo DS ROM.`,
    );
  }
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  // Game title is 12 ASCII chars at +0x00, null-padded.
  const titleBytes = rom.subarray(0, 12);
  const titleEnd = titleBytes.indexOf(0);
  const game_title = new TextDecoder('ascii').decode(
    titleEnd >= 0 ? titleBytes.subarray(0, titleEnd) : titleBytes,
  );
  const game_code = new TextDecoder('ascii').decode(rom.subarray(0x0c, 0x10));
  const fat_offset = view.getUint32(0x48, true);
  const fat_size = view.getUint32(0x4c, true);
  const fnt_offset = view.getUint32(0x40, true);
  const fnt_size = view.getUint32(0x44, true);

  // Quick sanity check: the FAT and FNT need to fit inside the ROM we
  // were handed. Catches truncated downloads / wrong file types early.
  if (fat_offset + fat_size > rom.length || fnt_offset + fnt_size > rom.length) {
    throw new Error(
      "This file looks truncated — its NDS header points past the end of the file.",
    );
  }

  return {
    game_title,
    game_code,
    rom_size: rom.length,
    fat_offset,
    fat_size,
    fnt_offset,
    fnt_size,
  };
}

// ---------------------------------------------------------------------------
// FAT (file_id -> [start, end] offsets in ROM)
// ---------------------------------------------------------------------------

export function readFatEntry(rom: Uint8Array, header: NdsHeader, file_id: number): FatEntry {
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const entry_off = header.fat_offset + file_id * 8;
  if (entry_off + 8 > header.fat_offset + header.fat_size) {
    throw new Error(`File ID ${file_id} is past the end of the FAT.`);
  }
  const start = view.getUint32(entry_off, true);
  const end = view.getUint32(entry_off + 4, true);
  return { file_id, start, end, size: end - start };
}

// ---------------------------------------------------------------------------
// FNT (file_id -> path)
// ---------------------------------------------------------------------------

export function parseFnt(rom: Uint8Array, header: NdsHeader): FntMap {
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const fnt_base = header.fnt_offset;

  // Root entry tells us how many directories the FNT contains.
  const total_dirs = view.getUint16(fnt_base + 6, true);

  // Per-directory main-table entries: 8 bytes each, indexed by dir-index.
  interface MainEntry {
    sub_off: number;
    first_id: number;
    parent: number;
  }
  const main: MainEntry[] = [];
  for (let d = 0; d < total_dirs; d++) {
    const off = fnt_base + d * 8;
    main.push({
      sub_off: view.getUint32(off, true),
      first_id: view.getUint16(off + 4, true),
      parent: view.getUint16(off + 6, true),
    });
  }

  const dir_id_to_index = new Map<number, number>();
  for (let d = 0; d < total_dirs; d++) dir_id_to_index.set(0xf000 + d, d);

  const files = new Map<number, { name: string; parent: number }>();
  const dir_name_parent = new Map<number, { name: string; parent: number }>();

  const decoder = new TextDecoder('ascii');

  for (let d = 0; d < total_dirs; d++) {
    let i = fnt_base + main[d].sub_off;
    let cur_file_id = main[d].first_id;
    // Defensive ceiling — never walk past the FNT region.
    const fnt_end = fnt_base + header.fnt_size;
    while (i < fnt_end) {
      const t = rom[i];
      i += 1;
      if (t === 0) break;
      if (t < 0x80) {
        // File entry, length-prefixed name.
        const name = decoder.decode(rom.subarray(i, i + t));
        i += t;
        files.set(cur_file_id, { name, parent: d });
        cur_file_id += 1;
      } else {
        const nl = t - 0x80;
        const name = decoder.decode(rom.subarray(i, i + nl));
        i += nl;
        const sub_dir_id = view.getUint16(i, true);
        i += 2;
        const dir_idx = dir_id_to_index.get(sub_dir_id);
        if (dir_idx !== undefined) dir_name_parent.set(dir_idx, { name, parent: d });
      }
    }
  }

  function dirPath(d: number): string {
    const parts: string[] = [];
    let cur = d;
    let safety = 0;
    while (cur !== 0 && safety < 128) {
      const np = dir_name_parent.get(cur);
      if (!np) break;
      parts.push(np.name);
      cur = np.parent;
      safety += 1;
    }
    return parts.reverse().join('/');
  }

  const result: FntMap = new Map();
  for (const [fid, info] of files) {
    const dp = dirPath(info.parent);
    result.set(fid, dp ? `${dp}/${info.name}` : info.name);
  }
  return result;
}

// ---------------------------------------------------------------------------
// RESO container parser (Variant 0 is the one msg98 uses)
// ---------------------------------------------------------------------------

const RESO_MAGIC = 'RESO';

export function parseResoHeader(buf: Uint8Array): ResoHeader {
  if (buf.length < 16) throw new Error('RESO header is too short.');
  const magic = new TextDecoder('ascii').decode(buf.subarray(0, 4));
  if (magic !== RESO_MAGIC) {
    throw new Error(
      `Not a RESO container (magic was "${magic}"). The viewer only knows how to parse RESO files.`,
    );
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const file_count = view.getUint32(0x04, true);
  const version_raw = buf.subarray(0x08, 0x0c);
  const last = version_raw.indexOf(0);
  const version = new TextDecoder('ascii').decode(
    last >= 0 ? version_raw.subarray(0, last) : version_raw,
  );
  const variant = view.getUint32(0x0c, true);
  return { magic, file_count, version, variant };
}

export function parseResoEntries(buf: Uint8Array): ResoEntry[] {
  const header = parseResoHeader(buf);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries: ResoEntry[] = [];
  if (header.variant === 0) {
    const stride = 0x10;
    for (let i = 0; i < header.file_count; i++) {
      const off = 0x10 + i * stride;
      const unk = view.getUint32(off, true);
      const type_tag_raw = buf.subarray(off + 4, off + 8);
      // Trim trailing NULs.
      let typeEnd = type_tag_raw.length;
      while (typeEnd > 0 && type_tag_raw[typeEnd - 1] === 0) typeEnd -= 1;
      const type_tag = new TextDecoder('ascii').decode(type_tag_raw.subarray(0, typeEnd));
      const length = view.getUint32(off + 8, true);
      const data_offset = view.getUint32(off + 0x0c, true);
      entries.push({ index: i, type_tag, length, data_offset, unk });
    }
  } else if (header.variant === 1) {
    const stride = 0x08;
    for (let i = 0; i < header.file_count; i++) {
      const off = 0x10 + i * stride;
      const length = view.getUint32(off, true);
      const data_offset = view.getUint32(off + 4, true);
      entries.push({ index: i, type_tag: '', length, data_offset, unk: 0 });
    }
  } else {
    throw new Error(`Unknown RESO variant: ${header.variant}`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Wire-format token parser (CMD + UTF-16-LE text)
// ---------------------------------------------------------------------------

const CMD_OPEN = 0x0024;
const ARG_SEP = 0x0027;
const CMD_CLOSE = 0x003b;
const TERMINATOR = 0x000c;
const NULL_WORD = 0x0000;

/** Parse one entry payload into a flat token stream. Stops at the first
 *  0x000C terminator. Mirrors `parse_entry` in wire_format.py. */
export function parseEntry(payload: Uint8Array): Token[] {
  if (payload.length < 2) return [];
  const wordCount = Math.floor(payload.length / 2);
  // Build a u16 view once. payload may not be 2-byte aligned to its parent
  // ArrayBuffer, so copy to a fresh aligned buffer.
  const aligned = new Uint8Array(wordCount * 2);
  aligned.set(payload.subarray(0, wordCount * 2));
  const words = new Uint16Array(aligned.buffer);

  const out: Token[] = [];
  let textBuf: number[] = [];

  const flush = () => {
    if (textBuf.length > 0) {
      out.push({ kind: 'text', text: String.fromCharCode(...textBuf) });
      textBuf = [];
    }
  };

  let i = 0;
  while (i < wordCount) {
    const w = words[i];
    if (w === TERMINATOR) {
      flush();
      return out;
    }
    if (w === CMD_OPEN) {
      flush();
      const cmd_start_byte = i * 2;
      i += 1;
      if (i >= wordCount) return out;
      const opcode = words[i] & 0x7fff;
      i += 1;
      const args: number[] = [];
      while (i < wordCount && words[i] === ARG_SEP) {
        i += 1;
        if (i >= wordCount) break;
        args.push(words[i] & 0x7fff);
        i += 1;
      }
      if (i < wordCount && words[i] === CMD_CLOSE) {
        i += 1;
        // Extended-data words capture: run of 0x8000–0x81FF terminated by 0x0000.
        // These are opcode arguments the engine reads as raw bytes, not text.
        let look = i;
        while (look < wordCount && words[look] >= 0x8000 && words[look] <= 0x81ff) {
          look += 1;
        }
        if (look > i && look < wordCount && words[look] === NULL_WORD) {
          // skip — they're stored but we don't need them for display
          i = look;
        }
      }
      const cmd_end_byte = i * 2;
      // raw_hex (lower-case, no spaces) for the inline <i>hex</i> display.
      const slice = payload.subarray(cmd_start_byte, cmd_end_byte);
      let hex = '';
      for (let b = 0; b < slice.length; b++) {
        hex += slice[b].toString(16).padStart(2, '0');
      }
      out.push({
        kind: 'cmd',
        opcode,
        tag: formatTag(opcode, args),
        raw_hex: hex,
        args,
      });
      continue;
    }
    // Plain UTF-16-LE codepoint.
    textBuf.push(w);
    i += 1;
  }
  flush();
  return out;
}

/** Build the wire-format display string the way the desktop tool shows it:
 *
 *   - Inline opcodes that have a known tag render as `[TAG_NAME]` /
 *     `[TAG_NAME:1:2]`.
 *   - Inline opcodes the registry doesn't know about render as
 *     `<i>HEXHEX</i>` (the raw-bytes chip the design specs).
 *   - Embedded 0x0000 inside text tokens becomes a `§` page-break marker
 *     to match the wire_format.render_for_translator convention.
 *   - Embedded NULs that survive after that step are dropped.
 *
 * Both `[TAG]` and `<i>HEX</i>` are recognised by the design's
 * `renderLine` tokenizer, so the rendered string drops straight into the
 * viewer's mono panel.
 *
 * The "known opcode" set is the project's catalogue — anything not in it
 * gets the raw-hex chip even though parseEntry has stored a fallback tag,
 * because for unknown opcodes the design's preference is to show the
 * literal bytes the engine will run. We honour that. */
import { OPCODE_TAG_NAMES } from './opcodeRegistry';

// Ruby/furigana markup convention from the main repo's wire_format.py:
// the kanji-reading pair is encoded as `{kanji|reading}` in the decoded
// text stream, and the translator-facing render replaces it with just the
// kanji (the reading is display-only ruby text that doesn't round-trip
// into EN). We mirror that here so the parser's jp_wire matches the
// project's DB representation byte-for-byte.
const FURIGANA_RE = /\{([^|}]+)\|([^}]+)\}/g;
function stripFurigana(text: string): string {
  return text.replace(FURIGANA_RE, (_m, kanji) => kanji);
}

export function renderWire(tokens: Token[]): string {
  const parts: string[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'text') {
      // 0x0000 inside text = § phrase boundary (engine A-button advance).
      // Match the project's text-substitution convention.
      let t = '';
      for (let i = 0; i < tok.text.length; i++) {
        const c = tok.text.charCodeAt(i);
        if (c === 0) t += '§';
        else t += tok.text[i];
      }
      t = stripFurigana(t);
      parts.push(t);
    } else {
      if (OPCODE_TAG_NAMES[tok.opcode] !== undefined) {
        parts.push(tok.tag);
      } else {
        parts.push(`<i>${tok.raw_hex.toUpperCase()}</i>`);
      }
    }
  }
  return parts.join('');
}

/** Plain-text version of an entry, stripped of every marker. */
export function renderPlain(tokens: Token[]): string {
  const parts: string[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'text') {
      // Strip NULs entirely for the plain version.
      let t = '';
      for (let i = 0; i < tok.text.length; i++) {
        const c = tok.text.charCodeAt(i);
        if (c !== 0) t += tok.text[i];
      }
      parts.push(stripFurigana(t));
    }
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Entry → sub-entry split (mirrors src/translator/wire_format.py +
//                         src/translator/extract_entries.py in the main repo)
// ---------------------------------------------------------------------------
//
// In the wire format, a single RESO entry frequently contains MULTIPLE
// dialog screens — each screen starts with an inline SPEAKER (0x18) CMD
// followed by TEXTBOX (0x17) / EXPRESSION (0x16) state setup, then the
// actual body text, optionally a trailing state cluster, and finally
// either the entry terminator or the next SPEAKER cluster.
//
// The local translation tool's extract_entries.py splits each entry into
// one "sub-entry" per screen — the DB primary key is
// (file_id, entry_id, sub_entry_id) — so the EN lookup table is keyed the
// same way. The browser parser must mirror that exact convention or the
// viewer can't join its parsed JP against the lookup's EN: it sees one
// concatenated JP block at sub_entry_id=0 while the EN side has 5
// separately-keyed entries (40.0, 40.1, 40.2, 40.3, 40.4), and rows
// 40.1–40.4 render "— untranslated —" because the parser never produced
// JP at those keys.
//
// Convention ported verbatim from the Python:
//   1. split_preamble peels off leading non-body CMDs and trailing non-body
//      CMDs. Body content "starts" at the first TextToken with non-whitespace
//      content OR at the first CmdToken whose opcode is in BODY_MARKER_OPCODES
//      (which is every catalogued opcode EXCEPT 0x16/0x17/0x18/0x37 — those
//      are PREAMBLE_PRIMARY structural state).
//   2. split_into_screens scans the body for inline SPEAKER (0x18) at
//      position > 0; every such SPEAKER begins a new screen.
//   3. screen_preamble_split peels a fresh preamble off screens 2..N (the
//      first screen reuses the entry-level preamble from step 1).
//   4. Each screen whose rendered body text is non-empty becomes a sub-entry.

function splitPreamble(tokens: Token[]): { leading: Token[]; body: Token[]; trailing: Token[] } {
  // First body-relevant token index.
  let firstBody = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === 'text') {
      // Treat NULs and spaces as not-yet-body, matching the Python
      // .strip("\x00 ") test.
      let hasContent = false;
      for (let k = 0; k < tok.text.length; k++) {
        const c = tok.text.charCodeAt(k);
        if (c !== 0 && c !== 0x20) { hasContent = true; break; }
      }
      if (hasContent) { firstBody = i; break; }
      continue;
    }
    if (BODY_MARKER_OPCODES.has(tok.opcode)) { firstBody = i; break; }
  }

  // Last body-relevant token index (scan backward).
  let lastBody = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    if (tok.kind === 'text') {
      let hasContent = false;
      for (let k = 0; k < tok.text.length; k++) {
        const c = tok.text.charCodeAt(k);
        if (c !== 0 && c !== 0x20) { hasContent = true; break; }
      }
      if (hasContent) { lastBody = i; break; }
      continue;
    }
    if (BODY_MARKER_OPCODES.has(tok.opcode)) { lastBody = i; break; }
  }

  if (firstBody > lastBody) {
    // No body content at all — every CmdToken is leading.
    const leadingOnly: Token[] = [];
    for (const t of tokens) if (t.kind === 'cmd') leadingOnly.push(t);
    return { leading: leadingOnly, body: [], trailing: [] };
  }

  const leading: Token[] = [];
  for (let i = 0; i < firstBody; i++) {
    const t = tokens[i];
    if (t.kind === 'cmd') leading.push(t);
  }
  const body = tokens.slice(firstBody, lastBody + 1);
  const trailing: Token[] = [];
  for (let i = lastBody + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'cmd') trailing.push(t);
  }
  return { leading, body, trailing };
}

/** Split a body token list on inline SPEAKER (0x18) boundaries.
 *  Mirrors wire_format.split_into_screens. */
function splitIntoScreens(body: Token[]): Token[][] {
  if (body.length === 0) return [body];
  const boundaries: number[] = [0];
  for (let i = 1; i < body.length; i++) {
    const tok = body[i];
    if (tok.kind === 'cmd' && tok.opcode === 0x18) boundaries.push(i);
  }
  if (boundaries.length === 1) return [body];
  const screens: Token[][] = [];
  for (let j = 0; j < boundaries.length; j++) {
    const start = boundaries[j];
    const end = j + 1 < boundaries.length ? boundaries[j + 1] : body.length;
    screens.push(body.slice(start, end));
  }
  return screens;
}

/** For sub-entries 2..N, peel off the leading state-CMD preamble (the
 *  SPEAKER + TEXTBOX + EXPR cluster) and return (preamble, body). Stops
 *  at the first TextToken OR the first BODY_MARKER opcode. */
function screenPreambleSplit(screen: Token[]): { preamble: Token[]; body: Token[] } {
  const preamble: Token[] = [];
  let i = 0;
  while (i < screen.length) {
    const tok = screen[i];
    if (tok.kind === 'cmd' && !BODY_MARKER_OPCODES.has(tok.opcode)) {
      preamble.push(tok);
      i += 1;
      continue;
    }
    break;
  }
  return { preamble, body: screen.slice(i) };
}

/** True iff the rendered body has any visible content (matching the
 *  Python `text_for_ai.strip("\x00 \n")` non-empty test). */
function hasBodyContent(rendered: string): boolean {
  for (let i = 0; i < rendered.length; i++) {
    const c = rendered.charCodeAt(i);
    if (c !== 0 && c !== 0x20 && c !== 0x0a) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// High-level extractor for the viewer's scope
// ---------------------------------------------------------------------------

export interface ExtractParams {
  /** Paths the EN lookup mentions. The parser only extracts these. */
  expected_paths: string[];
  onProgress?: (done: number, total: number) => void;
}

export function extractRomFiles(rom: Uint8Array, params: ExtractParams): {
  header: NdsHeader;
  files: ExtractedFileJP[];
} {
  const header = parseNdsHeader(rom);
  const fnt = parseFnt(rom, header);
  const pathToId = new Map<string, number>();
  for (const [fid, path] of fnt) pathToId.set(path, fid);

  const files: ExtractedFileJP[] = [];
  const total = params.expected_paths.length;
  let done = 0;

  for (const path of params.expected_paths) {
    const fid = pathToId.get(path);
    if (fid === undefined) {
      // File-id miss usually means it's a different game (or a different
      // revision). Skip rather than fail the whole extract so we can show
      // the user a useful partial result.
      done += 1;
      params.onProgress?.(done, total);
      continue;
    }
    let extracted: ExtractedFileJP | null = null;
    try {
      const fatEntry = readFatEntry(rom, header, fid);
      if (fatEntry.size <= 0 || fatEntry.end > rom.length) {
        done += 1;
        params.onProgress?.(done, total);
        continue;
      }
      const container = rom.subarray(fatEntry.start, fatEntry.end);
      // Quick magic-check before we trust the header parser.
      if (container.length < 4 || container[0] !== 0x52 || container[1] !== 0x45 ||
          container[2] !== 0x53 || container[3] !== 0x4f) {
        done += 1;
        params.onProgress?.(done, total);
        continue;
      }
      const resoEntries = parseResoEntries(container);
      const textblocks = new Map<string, Textblock>();
      for (const e of resoEntries) {
        if (e.length === 0) continue;
        const payload = container.subarray(e.data_offset, e.data_offset + e.length);
        const tokens = parseEntry(payload);

        // Split the entry into one Textblock per inline-SPEAKER screen,
        // matching the DB's (entry_id, sub_entry_id) primary key. The
        // helpers above are direct ports of wire_format.split_preamble /
        // split_into_screens / screen_preamble_split. See the comment
        // block above splitPreamble for the full convention rationale.
        const { body: entryBody } = splitPreamble(tokens);
        const screens = splitIntoScreens(entryBody);

        let subId = 0;
        let emittedAny = false;
        for (let s = 0; s < screens.length; s++) {
          const screen = screens[s];
          // First screen reuses the entry-level preamble (which we don't
          // need to render — we only render the screen body). Later
          // screens get a fresh preamble peeled off.
          const screenBody = s === 0 ? screen : screenPreambleSplit(screen).body;

          const jp_wire = renderWire(screenBody);
          const jp_plain = renderPlain(screenBody);
          // Empty-body screens are silently dropped (matching the Python's
          // `if not text_for_ai.strip(strip_set): continue`), and we DO NOT
          // burn a sub-entry id on them — sub_entry_id is the index of the
          // emitted screen, not the index of the source-screen slot.
          if (!hasBodyContent(jp_plain) && !hasBodyContent(jp_wire)) continue;

          const tb: Textblock = {
            entry_id: e.index,
            sub_entry_id: subId,
            jp_wire,
            jp_plain,
          };
          textblocks.set(`${e.index}.${subId}`, tb);
          subId += 1;
          emittedAny = true;
        }

        // Defensive fallback: if every screen was empty (shouldn't happen
        // for any RESO entry with non-zero length, but guard anyway), emit
        // the whole entry at sub_entry_id=0 so the viewer still has a row
        // to render rather than dropping the entry entirely.
        if (!emittedAny) {
          const jp_wire = renderWire(tokens);
          const jp_plain = renderPlain(tokens);
          if (jp_wire.length > 0 || jp_plain.length > 0) {
            textblocks.set(`${e.index}.0`, {
              entry_id: e.index,
              sub_entry_id: 0,
              jp_wire,
              jp_plain,
            });
          }
        }
      }
      extracted = {
        file_path: path,
        file_id: fid,
        reso_entry_count: resoEntries.length,
        textblocks,
      };
    } catch (err) {
      // Surface as console warning so the developer console shows the
      // problem path, but don't fail the entire extract.
      // eslint-disable-next-line no-console
      console.warn(`[rom-parser] ${path}: ${(err as Error).message}`);
    }
    if (extracted) files.push(extracted);
    done += 1;
    params.onProgress?.(done, total);
  }

  return { header, files };
}
