// Translation Viewer — researchers supply their own copy of the Tongari
// Boushi NDS ROM, the page parses it client-side, and we align extracted
// Japanese text against the published English translation.
//
// The ROM never leaves the browser. The English side comes from a public
// JSON lookup exported by
// `src/translator/_export_en_lookup_for_rom_viewer.py` in the main repo.
//
// Design source: web-translation-viewer/project/index.html (Claude Design
// handoff bundle, May 20). The CSS rules here are a direct port of that
// prototype's stylesheet. The "tree-block" / "Dialog Block Parts" labels
// in the design map to the project's permanent terminology:
//
//     Block          = Textblock (one (entry_id, sub_entry_id) record)
//     Block Parts    = Phrases within a Textblock split on § (page break)
//
// `▼` is a Row (line break) inside a single Phrase, NOT a Phrase
// boundary — Rows stay inside their Phrase and render as line breaks.
//
// We keep the design's class names so the CSS round-trips cleanly, but
// the user-facing copy uses Textblock / Phrase / Row.

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExtractedFileJP,
  NdsHeader,
  RomExtraction,
  Textblock,
  WorkerOutbound,
} from '../lib/rom/types';
import { supabase, supabaseConfigured } from '../lib/supabase';

// ---------------------------------------------------------------------------
// EN lookup types (shape mirrors _export_en_lookup_for_rom_viewer.py)
// ---------------------------------------------------------------------------

interface EnEntry {
  en: string;
  max_total_chars: number | null;
  max_line_chars: number | null;
  max_lines: number | null;
}

interface EnFile {
  file_path: string;
  label: string;
  /** Category id from the public lookup. Retained as a harmless data
   *  field — the viewer no longer surfaces it. The file tree is a pure
   *  directory tree of file paths now (step-328). */
  category?: string;
  max_entry_id: number;
  entries: Record<string, Record<string, EnEntry>>;
}

interface EnLookup {
  generated_at: string;
  source_db_mtime: string;
  scope: string;
  counts: { files: number; entries: number; categories?: number };
  /** Retained on the lookup payload but no longer consumed by the UI
   *  (step-328 — Tyler asked for Dialog Paths only). */
  categories?: unknown;
  files: EnFile[];
}

interface Props {
  /** Where to fetch the EN lookup JSON. Passed from the Astro page so the
   *  GitHub Pages base path is resolved at build time. */
  lookupUrl: string;
  /** Decoration sprite base (e.g. `${base}/decorations/`) for the empty-state
   *  illustration and footer ornaments. */
  decorationBase: string;
}

// ---------------------------------------------------------------------------
// Rendering helpers — match the design's renderLine() prototype
// ---------------------------------------------------------------------------

interface RenderedToken {
  kind: 'text' | 'hex' | 'tag' | 'ruby';
  value?: string;
  base?: string;
  rt?: string;
}

/** Tokenise the wire-format string the way the design does:
 *  - `<i>HEX</i>` -> grey hex chip
 *  - `[TAG_NAME]` -> rose pill
 *  - `{kanji|reading}` -> <ruby> for furigana
 *  - everything else -> plain text */
function tokeniseLine(line: string): RenderedToken[] {
  const tokens: RenderedToken[] = [];
  const re = /<i>([^<]*)<\/i>|\[([A-Z0-9_:]+)\]|\{([^|}]+)\|([^}]+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) tokens.push({ kind: 'text', value: line.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ kind: 'hex', value: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: 'tag', value: m[2] });
    else tokens.push({ kind: 'ruby', base: m[3], rt: m[4] });
    last = m.index + m[0].length;
  }
  if (last < line.length) tokens.push({ kind: 'text', value: line.slice(last) });
  return tokens;
}

function RenderedTokens({ tokens }: { tokens: RenderedToken[] }) {
  return (
    <>
      {tokens.map((t, i) => {
        if (t.kind === 'text') return <span key={i}>{t.value}</span>;
        if (t.kind === 'hex') {
          return (
            <span key={i} className="code-hex">
              &lt;i&gt;{t.value}&lt;/i&gt;
            </span>
          );
        }
        if (t.kind === 'tag') return <span key={i} className="code-tag">[{t.value}]</span>;
        if (t.kind === 'ruby') {
          return (
            <ruby key={i}>
              {t.base}
              <rt>{t.rt}</rt>
            </ruby>
          );
        }
        return null;
      })}
    </>
  );
}

/** Render a wire-format string as preformatted JSX. Splits on `▼` and `§`
 *  the same way the project's TranslationBrowser does, so a multi-line
 *  Textblock displays the line / page breaks correctly. */
function RenderedWire({ text }: { text: string }) {
  if (!text) return null;
  // First split on §, then on ▼, then on \n (some JP strings carry literal
  // newlines too). We render § as a soft page divider and ▼ / \n as breaks.
  const pages = text.split('§');
  return (
    <>
      {pages.map((page, pi) => {
        // Inside a page, ▼ and \n are both line breaks.
        const rawLines = page.replace(/\r\n/g, '\n').split(/▼|\n/);
        return (
          <span key={pi} className="rendered-page">
            {pi > 0 && <span className="rendered-pagebreak" aria-hidden="true" />}
            {rawLines.map((line, li) => (
              <span key={li} className="rendered-line">
                {li > 0 && <br />}
                <RenderedTokens tokens={tokeniseLine(line)} />
              </span>
            ))}
          </span>
        );
      })}
    </>
  );
}

/** Strip wire markers down to "plain prose" for substring search against
 *  natural-language text only. Use this for the un-tagged JP / EN body. */
function plainSearchable(text: string): string {
  if (!text) return '';
  return text
    .replace(/<i>[^<]*<\/i>/g, '')
    .replace(/\[[A-Z0-9_:]+\]/g, '')
    .replace(/\{([^|}]+)\|[^}]+\}/g, '$1')
    .replace(/§/g, ' ')
    .replace(/▼/g, ' ')
    .toLowerCase();
}

/** Searchable surface that KEEPS the opcode tokens visible so queries like
 *  `[PLAYER_NAME]`, `[NPC_DAT:1]`, `[COLOR:*]` (with the wildcard helper
 *  below) can match against the rendered wire markers. Furigana ruby is
 *  reduced to its base kanji to match the natural-reading text. */
function taggedSearchable(text: string): string {
  if (!text) return '';
  return text
    .replace(/<i>[^<]*<\/i>/g, '')
    .replace(/\{([^|}]+)\|[^}]+\}/g, '$1')
    .replace(/§/g, ' ')
    .replace(/▼/g, ' ')
    .toLowerCase();
}

/** Build a search matcher from the user's query string.
 *
 *  - If the query contains `*` or `?`, it's a wildcard pattern:
 *      `*`  -> `.*` (any chars, including empty)
 *      `?`  -> `.`  (exactly one char)
 *    Other regex specials are escaped so a pattern like `[NPC_DAT:*]`
 *    is matched literally (square brackets and colon) with `*` standing
 *    in for the arg. The match is case-insensitive and substring-based —
 *    we DON'T anchor with `^...$`, so users get find-anywhere semantics
 *    and can still prefix/suffix `*` themselves if they want.
 *
 *  - Otherwise the query is a plain case-insensitive substring match.
 *
 *  The returned matcher takes the haystack (already lower-cased — pass
 *  output from `plainSearchable` / `taggedSearchable`) and returns a
 *  boolean. */
function buildMatcher(query: string): ((haystack: string) => boolean) | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const hasWildcard = q.includes('*') || q.includes('?');
  if (!hasWildcard) {
    return (h: string) => h.includes(q);
  }
  // Escape regex specials EXCEPT * and ?, then map our globs.
  // Order matters: do the escape first, then swap the literal escaped
  // chars for our regex equivalents.
  let re = q.replace(/[\\^$.+()|{}\[\]]/g, (m) => '\\' + m);
  re = re.replace(/\*/g, '.*').replace(/\?/g, '.');
  try {
    const compiled = new RegExp(re, 'i');
    return (h: string) => compiled.test(h);
  } catch {
    // Bad regex — fall back to plain substring against the original query
    // so the search UI doesn't lock up while the user is mid-typing.
    return (h: string) => h.includes(q);
  }
}

/** Does this query target opcode tokens (i.e. contains a `[`)?
 *  Used to pick which haystack to search against. */
function queryIsOpcode(query: string): boolean {
  return query.includes('[');
}

// ---------------------------------------------------------------------------
// File-level model — joins EN lookup + extracted ROM JP into one row set
// per file_path. We compute this once when either side changes.
// ---------------------------------------------------------------------------

interface ViewerBlock {
  /** "${entry_id}.${sub_entry_id}" — the join key. */
  id: string;
  entry_id: number;
  sub_entry_id: number;
  en: string;
  jp: string;
  max_total_chars: number | null;
}

interface ViewerFile {
  file_path: string;
  label: string;
  blocks: ViewerBlock[];
}

function buildViewerFiles(
  enLookup: EnLookup | null,
  extraction: RomExtraction | null,
): ViewerFile[] {
  if (!enLookup) return [];

  const files: ViewerFile[] = [];
  for (const f of enLookup.files) {
    const extractedFile: ExtractedFileJP | undefined = extraction?.by_path.get(f.file_path);
    const blocks: ViewerBlock[] = [];
    // Walk the union of EN entry ids and the extracted ROM entry ids so
    // we can show empty slots (entries with no EN row but a JP body, and
    // vice versa).
    const idSet = new Set<string>();
    for (const eid of Object.keys(f.entries)) {
      for (const sid of Object.keys(f.entries[eid])) {
        idSet.add(`${eid}.${sid}`);
      }
    }
    if (extractedFile) {
      for (const key of extractedFile.textblocks.keys()) idSet.add(key);
      // Also add empty slots for every RESO entry index so the tree shows
      // the full container shape, matching the design's "empty block 00/01/02"
      // sample data.
      for (let i = 0; i < extractedFile.reso_entry_count; i++) {
        idSet.add(`${i}.0`);
      }
    }
    for (const id of idSet) {
      const [eidStr, sidStr] = id.split('.');
      const eid = Number(eidStr);
      const sid = Number(sidStr);
      const enEntry: EnEntry | undefined = f.entries[eidStr]?.[sidStr];
      const jpTextblock: Textblock | undefined = extractedFile?.textblocks.get(id);
      blocks.push({
        id,
        entry_id: eid,
        sub_entry_id: sid,
        en: enEntry?.en ?? '',
        jp: jpTextblock?.jp_wire ?? '',
        max_total_chars: enEntry?.max_total_chars ?? null,
      });
    }
    blocks.sort((a, b) =>
      a.entry_id === b.entry_id ? a.sub_entry_id - b.sub_entry_id : a.entry_id - b.entry_id,
    );
    files.push({ file_path: f.file_path, label: f.label, blocks });
  }
  return files;
}

/** Split a Textblock into Phrases — one row per `§` page break.
 *
 *  `§` is the page-break marker (engine A-button advance, end of one
 *  textbox / start of the next). `▼` and embedded `\n` are line breaks
 *  WITHIN a single textbox (Rows inside the Phrase), so they MUST NOT
 *  split here — they stay in the Phrase's text and the renderer turns
 *  them into visible line breaks.
 *
 *  This is the design's "Dialog Block Parts" table. */
function splitPhrases(jp: string, en: string): { jp: string; en: string }[] {
  const splitOne = (text: string): string[] => {
    if (!text) return [];
    // Split ONLY on § (page break). ▼ / \n are Rows inside a Phrase and
    // are preserved in the output so the renderer can show them as line
    // breaks within the row.
    return text
      .split('§')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };
  const jpParts = splitOne(jp);
  const enParts = splitOne(en);
  const n = Math.max(jpParts.length, enParts.length);
  const out: { jp: string; en: string }[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ jp: jpParts[i] ?? '', en: enParts[i] ?? '' });
  }
  return out;
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Suggest-edit submission (step-338).
//
// Hits the same Supabase `edit_suggestions` table that TranslationBrowser
// writes to — same columns (kind, ref, original_en, proposed_en, reason,
// submitter), so Tyler reviews everything from one moderation queue.
//
// One difference from TranslationBrowser: the viewer knows about Phrase
// pages (split on §) and submits a suggestion scoped to a single phrase.
// The `ref` field encodes the path-based locator the viewer has natively
// (file_path, entry_id, sub_entry_id, phrase_index) under an
// `entries_path:` prefix so the admin tooling can distinguish it from the
// existing `entries:<file_id>:...` refs the Browser produces. Tyler can
// resolve the path-based ref back to a DB row at review time.
// ---------------------------------------------------------------------------

// Round-trip helpers (copied from TranslationBrowser) so the textarea
// presents real newlines / blank-line page breaks while the DB keeps the
// in-game `▼` / `§` markers the rebuild pipeline needs.
function wireToEdit(s: string): string {
  return s.replace(/§/g, '\n\n').replace(/▼/g, '\n');
}
function editToWire(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n\n/g, '§').replace(/\n/g, '▼');
}

const SUGGEST_MAX_REASON = 500;
const SUGGEST_MAX_AUTHOR = 40;

function buildPhraseRef(
  file_path: string,
  entry_id: number,
  sub_entry_id: number,
  phrase_index: number,
): string {
  return `entries_path:${file_path}:${entry_id}:${sub_entry_id}:${phrase_index}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface RomInfo {
  name: string;
  size: number;
  header?: NdsHeader;
}

function RomBar({
  rom,
  onLoad,
  onUnload,
  parsing,
  progressLabel,
  errorMessage,
}: {
  rom: RomInfo | null;
  onLoad: (file: File) => void;
  onUnload: () => void;
  parsing: boolean;
  progressLabel: string | null;
  errorMessage: string | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`rombar ${rom ? 'is-loaded' : 'is-empty'} ${errorMessage ? 'has-error' : ''}`}>
      <div className="rombar-status">
        <span className="rombar-icon" aria-hidden="true">
          {parsing ? '…' : rom ? '✓' : '▯'}
        </span>
        {parsing ? (
          <span>
            <strong>Parsing ROM…</strong>{' '}
            <span className="rombar-explain">
              {progressLabel || 'Reading file in your browser — nothing uploads.'}
            </span>
          </span>
        ) : rom ? (
          <span>
            <strong>ROM associated:</strong>{' '}
            <span className="rombar-fname">{rom.name}</span>{' '}
            <span className="rombar-size">({fmtBytes(rom.size)})</span>
            {rom.header?.game_code && (
              <span className="rombar-gamecode"> · game code {rom.header.game_code}</span>
            )}
          </span>
        ) : (
          <span>
            <strong>No ROM loaded.</strong>{' '}
            <span className="rombar-explain">
              English is hosted here; the Japanese text is read from your own ROM and never
              uploaded.
            </span>
          </span>
        )}
      </div>
      <div className="rombar-actions">
        <input
          ref={fileRef}
          type="file"
          accept=".nds,application/octet-stream"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLoad(f);
            e.target.value = '';
          }}
        />
        {rom && !parsing && (
          <button className="btn btn-ghost" onClick={onUnload}>
            Unload
          </button>
        )}
        <button
          className="btn btn-primary"
          onClick={() => fileRef.current?.click()}
          disabled={parsing}
        >
          {parsing ? 'Parsing…' : rom ? 'Replace ROM…' : 'Load ROM…'}
        </button>
      </div>
      {errorMessage && (
        <div className="rombar-error" role="alert">
          {errorMessage}
        </div>
      )}
    </div>
  );
}

function LockedJp() {
  return (
    <div className="locked">
      <span className="locked-icon" aria-hidden="true">
        ▯
      </span>
      <span className="locked-text">Japanese hidden — load your ROM to view this text.</span>
    </div>
  );
}

/** Test whether a single ViewerBlock matches the active search.
 *
 *  When the query contains `[` we treat it as an opcode-targeted query and
 *  match against the wire-format text (which still has the `[TAG]` tokens
 *  visible). Otherwise we match against the natural-prose haystack. */
function blockMatches(
  b: ViewerBlock,
  matcher: (h: string) => boolean,
  fields: { en: boolean; jp: boolean },
  opcodeMode: boolean,
): boolean {
  const en = opcodeMode ? taggedSearchable(b.en) : plainSearchable(b.en);
  const jp = opcodeMode ? taggedSearchable(b.jp) : plainSearchable(b.jp);
  if (fields.en && matcher(en)) return true;
  if (fields.jp && matcher(jp)) return true;
  return false;
}

// Directory-tree node. Each node is either an internal directory (with
// children keyed by path segment) or a leaf file. We build this from
// the flat list of file paths so the tree mirrors the actual ROM layout
// — no invented category labels. Sort order is lexical: directories
// before files at the same level, both alphabetical.
interface TreeDir {
  kind: 'dir';
  /** Single path segment, e.g. "message" or "msg21" or "00". */
  name: string;
  /** Full path from root to this dir, e.g. "message/msg21/00". Used as a
   *  stable key for the expandedDirs Set. */
  path: string;
  children: TreeNode[];
}
interface TreeFile {
  kind: 'file';
  name: string;
  file: ViewerFile;
}
type TreeNode = TreeDir | TreeFile;

/** Build a directory tree from a flat list of ViewerFile records.
 *  When `matcher` is non-null, only files with at least one matching
 *  block are included (and their ancestor directories). */
function buildDirTree(
  files: ViewerFile[],
  matcher: ((s: string) => boolean) | null,
  fields: { en: boolean; jp: boolean },
  opcodeMode: boolean,
): TreeDir {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [] };
  for (const f of files) {
    if (matcher) {
      const hit = f.blocks.some((b) => blockMatches(b, matcher, fields, opcodeMode));
      if (!hit) continue;
    }
    const segs = f.file_path.split('/');
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const childPath = segs.slice(0, i + 1).join('/');
      let child = cur.children.find(
        (n): n is TreeDir => n.kind === 'dir' && n.name === seg,
      );
      if (!child) {
        child = { kind: 'dir', name: seg, path: childPath, children: [] };
        cur.children.push(child);
      }
      cur = child;
    }
    cur.children.push({ kind: 'file', name: segs[segs.length - 1], file: f });
  }
  // Sort every dir's children: directories first, then files, both
  // alphabetical by name.
  const sortDir = (d: TreeDir) => {
    d.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of d.children) if (c.kind === 'dir') sortDir(c);
  };
  sortDir(root);
  return root;
}

/** Count the leaf files under a directory subtree. */
function countFiles(node: TreeNode): number {
  if (node.kind === 'file') return 1;
  let n = 0;
  for (const c of node.children) n += countFiles(c);
  return n;
}

function TreeFileRow({
  file,
  depth,
  selected,
  expanded,
  setExpanded,
  onSelectFile,
  onSelectBlock,
  isMatch,
  filteringActive,
}: {
  file: ViewerFile;
  depth: number;
  selected: { file: string; blockId: string };
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  onSelectFile: (file: ViewerFile) => void;
  onSelectBlock: (file: ViewerFile, b: ViewerBlock) => void;
  isMatch: (b: ViewerBlock) => boolean;
  filteringActive: boolean;
}) {
  const isOpen = expanded.has(file.file_path) || filteringActive;
  const isSel = selected.file === file.file_path;
  const fileMatches = filteringActive && file.blocks.some(isMatch);
  return (
    <li
      className={`tree-file ${isSel ? 'is-selected' : ''} ${
        fileMatches ? 'is-match' : ''
      }`}
    >
      <button
        className="tree-file-btn"
        style={{ paddingLeft: `${10 + depth * 12}px` }}
        onClick={() => {
          const next = new Set(expanded);
          if (next.has(file.file_path)) next.delete(file.file_path);
          else next.add(file.file_path);
          setExpanded(next);
          onSelectFile(file);
        }}
        aria-expanded={isOpen}
      >
        <span className="tree-disc" aria-hidden="true">
          {isOpen ? '▾' : '▸'}
        </span>
        <span className="tree-file-name">{file.file_path.split('/').pop()}</span>
        <span className="tree-file-label">{file.label}</span>
      </button>
      {isOpen && (
        <ol className="tree-blocks">
          {file.blocks.map((b) => {
            if (filteringActive && !isMatch(b)) return null;
            const empty = !b.en && !b.jp;
            const match = isMatch(b);
            const isCur = isSel && selected.blockId === b.id;
            const preview = plainSearchable(b.en).slice(0, 28);
            return (
              <li key={b.id}>
                <button
                  className={`tree-block ${isCur ? 'is-current' : ''} ${
                    empty ? 'is-empty' : ''
                  } ${match ? 'is-match' : ''}`}
                  onClick={() => onSelectBlock(file, b)}
                >
                  <span className="tree-block-id">
                    {b.sub_entry_id > 0
                      ? `${String(b.entry_id).padStart(2, '0')}.${b.sub_entry_id}`
                      : String(b.entry_id).padStart(2, '0')}
                  </span>
                  {preview && (
                    <span className="tree-block-preview">{preview}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}

function TreeDirRow({
  dir,
  depth,
  selected,
  expanded,
  setExpanded,
  expandedDirs,
  setExpandedDirs,
  onSelectFile,
  onSelectBlock,
  isMatch,
  filteringActive,
}: {
  dir: TreeDir;
  depth: number;
  selected: { file: string; blockId: string };
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  expandedDirs: Set<string>;
  setExpandedDirs: (s: Set<string>) => void;
  onSelectFile: (file: ViewerFile) => void;
  onSelectBlock: (file: ViewerFile, b: ViewerBlock) => void;
  isMatch: (b: ViewerBlock) => boolean;
  filteringActive: boolean;
}) {
  const open = expandedDirs.has(dir.path) || filteringActive;
  return (
    <details
      className="tree-dir"
      open={open}
      onToggle={(e) => {
        const target = e.currentTarget;
        const next = new Set(expandedDirs);
        if (target.open) next.add(dir.path);
        else next.delete(dir.path);
        setExpandedDirs(next);
      }}
    >
      <summary className="tree-dir-summary" style={{ paddingLeft: `${10 + depth * 12}px` }}>
        <span className="tree-dir-name">{dir.name}/</span>
        <span className="tree-dir-count">{countFiles(dir)}</span>
      </summary>
      <ol className="tree-list">
        {dir.children.map((child) =>
          child.kind === 'dir' ? (
            <TreeDirRow
              key={child.path}
              dir={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              setExpanded={setExpanded}
              expandedDirs={expandedDirs}
              setExpandedDirs={setExpandedDirs}
              onSelectFile={onSelectFile}
              onSelectBlock={onSelectBlock}
              isMatch={isMatch}
              filteringActive={filteringActive}
            />
          ) : (
            <TreeFileRow
              key={child.file.file_path}
              file={child.file}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              setExpanded={setExpanded}
              onSelectFile={onSelectFile}
              onSelectBlock={onSelectBlock}
              isMatch={isMatch}
              filteringActive={filteringActive}
            />
          ),
        )}
      </ol>
    </details>
  );
}

function FileTree({
  tree,
  shownFileCount,
  totalFileCount,
  selected,
  onSelectFile,
  onSelectBlock,
  expanded,
  setExpanded,
  expandedDirs,
  setExpandedDirs,
  query,
  fields,
}: {
  tree: TreeDir;
  shownFileCount: number;
  totalFileCount: number;
  selected: { file: string; blockId: string };
  onSelectFile: (file: ViewerFile) => void;
  onSelectBlock: (file: ViewerFile, b: ViewerBlock) => void;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  expandedDirs: Set<string>;
  setExpandedDirs: (s: Set<string>) => void;
  query: string;
  fields: { en: boolean; jp: boolean };
}) {
  const matcher = useMemo(() => buildMatcher(query), [query]);
  const opcodeMode = queryIsOpcode(query);
  const isMatch = (b: ViewerBlock) =>
    matcher ? blockMatches(b, matcher, fields, opcodeMode) : false;
  const filteringActive = matcher !== null;

  return (
    <nav className="tree" aria-label="Dialog Paths">
      <div className="tree-head">
        <span className="tree-head-files">
          Dialog Paths
          {filteringActive && (
            <span className="tree-head-filter">
              {' '}
              · {shownFileCount} of {totalFileCount}
            </span>
          )}
        </span>
        <span className="tree-head-blocks">Slots</span>
      </div>
      {tree.children.length === 0 && (
        <div className="tree-empty">
          {filteringActive
            ? 'No files match this search.'
            : 'No files loaded yet — wait for the lookup to finish loading.'}
        </div>
      )}
      <ol className="tree-list tree-list-root">
        {tree.children.map((child) =>
          child.kind === 'dir' ? (
            <TreeDirRow
              key={child.path}
              dir={child}
              depth={0}
              selected={selected}
              expanded={expanded}
              setExpanded={setExpanded}
              expandedDirs={expandedDirs}
              setExpandedDirs={setExpandedDirs}
              onSelectFile={onSelectFile}
              onSelectBlock={onSelectBlock}
              isMatch={isMatch}
              filteringActive={filteringActive}
            />
          ) : (
            <TreeFileRow
              key={child.file.file_path}
              file={child.file}
              depth={0}
              selected={selected}
              expanded={expanded}
              setExpanded={setExpanded}
              onSelectFile={onSelectFile}
              onSelectBlock={onSelectBlock}
              isMatch={isMatch}
              filteringActive={filteringActive}
            />
          ),
        )}
      </ol>
    </nav>
  );
}

function DialogPanels({
  block,
  romLoaded,
  selectedPhraseIndex,
  onSelectPhrase,
}: {
  block: ViewerBlock | null;
  romLoaded: boolean;
  selectedPhraseIndex: number;
  onSelectPhrase: (i: number) => void;
}) {
  if (!block) {
    return (
      <div className="empty-state">
        <p>Pick a file on the left, then a Textblock, to read the translation.</p>
      </div>
    );
  }
  const phrases = splitPhrases(block.jp, block.en);
  // Clamp selection to a valid Phrase. If the entry has no Phrases at
  // all (empty), fall back to the whole block's text so the panels still
  // show *something* useful.
  const hasPhrases = phrases.length > 0;
  const safeIndex = hasPhrases
    ? Math.min(Math.max(selectedPhraseIndex, 0), phrases.length - 1)
    : 0;
  const shownJp = hasPhrases ? phrases[safeIndex].jp : block.jp;
  const shownEn = hasPhrases ? phrases[safeIndex].en : block.en;
  return (
    <>
      <div className="pair">
        <section className="pair-col">
          <header className="pair-head">
            <span>Japanese</span>
            {hasPhrases && (
              <span className="pair-page" aria-hidden="true">
                Page {safeIndex + 1} of {phrases.length}
              </span>
            )}
            {!romLoaded && (
              <span className="pair-lock" aria-hidden="true">
                ROM required
              </span>
            )}
          </header>
          <div className="pair-body mono">
            {!romLoaded ? (
              <LockedJp />
            ) : shownJp ? (
              <RenderedWire text={shownJp} />
            ) : (
              <em className="muted">— empty —</em>
            )}
          </div>
        </section>
        <section className="pair-col">
          <header className="pair-head">
            <span>English</span>
            {block.max_total_chars != null && (
              <span className="pair-budget">Max {block.max_total_chars} chars</span>
            )}
          </header>
          <div className="pair-body mono">
            {shownEn ? <RenderedWire text={shownEn} /> : <em className="muted">— empty —</em>}
          </div>
        </section>
      </div>

      <section className="parts">
        <header className="parts-head">
          <span>Textblock Pages (click to view)</span>
          <span className="parts-count">
            {phrases.length} {phrases.length === 1 ? 'page' : 'pages'}
          </span>
        </header>
        {phrases.length === 0 && <div className="parts-empty">No pages in this Textblock.</div>}
        {phrases.map((p, i) => {
          const isSelected = i === safeIndex;
          return (
            <button
              key={i}
              type="button"
              className={`part-row ${isSelected ? 'is-selected' : ''}`}
              onClick={() => onSelectPhrase(i)}
              aria-pressed={isSelected}
              aria-label={`Show page ${i + 1} of ${phrases.length}`}
            >
              <span className="part-index" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="part-cell mono">
                {!romLoaded ? (
                  <LockedJp />
                ) : p.jp ? (
                  <RenderedWire text={p.jp} />
                ) : (
                  <em className="muted">— empty —</em>
                )}
              </div>
              <div className="part-cell mono">
                {p.en ? <RenderedWire text={p.en} /> : <em className="muted">— untranslated —</em>}
              </div>
            </button>
          );
        })}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Suggest-edit form (step-338) — per-phrase Supabase submission, modeled
// directly on TranslationBrowser's EditForm. Same `edit_suggestions` table,
// same column shape, so the moderation queue Tyler already uses picks up
// viewer submissions alongside browser submissions.
// ---------------------------------------------------------------------------

function SuggestEditCard({
  filePath,
  block,
  phraseIndex,
  phraseCount,
  jp,
  currentEn,
  maxChars,
}: {
  filePath: string;
  block: ViewerBlock;
  phraseIndex: number;
  phraseCount: number;
  jp: string;
  currentEn: string;
  maxChars: number | null;
}) {
  // Identity of the phrase the form is bound to. We RESET the form whenever
  // the user navigates to a different phrase / file / textblock so the
  // textarea always reflects the currently-selected target — anything else
  // would invite Tyler to type a suggestion for phrase 2 and accidentally
  // submit it against phrase 3 after navigating.
  const identity = `${filePath}::${block.id}::${phraseIndex}`;
  const [proposed, setProposed] = useState(() => wireToEdit(currentEn));
  const [reason, setReason] = useState('');
  const [submitter, setSubmitter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  // When the bound phrase changes, reset the form to that phrase's EN.
  // We track the previous identity in a ref so we don't clobber the user's
  // typing on the first render of a new phrase.
  const lastIdentity = useRef(identity);
  useEffect(() => {
    if (lastIdentity.current !== identity) {
      setProposed(wireToEdit(currentEn));
      setReason('');
      setSubmitter('');
      setErr(null);
      setFlash(false);
      lastIdentity.current = identity;
    }
  }, [identity, currentEn]);

  const proposedWire = editToWire(proposed);
  const proposedLen = [...proposedWire].length;
  const currentLen = [...currentEn].length;
  const over = maxChars != null && proposedLen > maxChars;
  const disabled = !supabaseConfigured;
  const disabledReason = supabaseConfigured
    ? ''
    : "Suggestions are disabled — the site owner hasn't connected the submissions backend yet.";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!proposed.trim()) {
      setErr('Suggestion is required.');
      return;
    }
    if (proposedWire.trim() === currentEn.trim()) {
      setErr('Suggestion is identical to the current text.');
      return;
    }
    if (disabled || !supabaseConfigured || !supabase) {
      setErr(disabledReason || "Backend isn't configured.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        kind: 'dialog',
        ref: buildPhraseRef(filePath, block.entry_id, block.sub_entry_id, phraseIndex),
        original_en: currentEn,
        proposed_en: proposedWire,
        reason: reason.trim() ? reason.trim().slice(0, SUGGEST_MAX_REASON) : null,
        submitter: submitter.trim() ? submitter.trim().slice(0, SUGGEST_MAX_AUTHOR) : null,
      };
      const { error } = await supabase.from('edit_suggestions').insert(payload);
      if (error) throw error;
      // Reset editable fields but keep the form open so the user can
      // refine and submit again — matches TranslationBrowser's UX.
      setProposed(wireToEdit(currentEn));
      setReason('');
      setSubmitter('');
      setFlash(true);
      window.setTimeout(() => setFlash(false), 3000);
    } catch (ex: any) {
      setErr(ex?.message || String(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="suggest">
      <header className="suggest-head">
        <span className="suggest-head-title">
          Suggest an edit
          <span className="suggest-head-scope">
            · Page {phraseIndex + 1} of {phraseCount}
          </span>
        </span>
        {maxChars != null && <span className="suggest-budget">Max {maxChars} chars</span>}
      </header>
      {!supabaseConfigured && (
        <div className="suggest-banner">
          <strong>Suggestions are disabled.</strong> The site owner hasn't
          connected the submissions backend yet.
        </div>
      )}
      <div className="suggest-context">
        <div className="suggest-context-row">
          <span className="suggest-label">JP</span>
          <div className="suggest-context-text mono">
            {jp ? <RenderedWire text={jp} /> : <em className="muted">— empty —</em>}
          </div>
        </div>
        <div className="suggest-context-row">
          <span className="suggest-label">Current EN</span>
          <div className="suggest-context-text mono">
            {currentEn ? (
              <RenderedWire text={currentEn} />
            ) : (
              <em className="muted">— no current English —</em>
            )}
          </div>
        </div>
      </div>
      <form className="suggest-form" onSubmit={submit}>
        <label className="suggest-field">
          <span className="suggest-field-label">
            Suggested EN
            <span className={`suggest-count ${over ? 'over' : ''}`}>
              {proposedLen}
              {maxChars != null && <> / {maxChars}</>} chars
              {currentLen > 0 && (
                <span className="suggest-count-hint"> (current: {currentLen})</span>
              )}
            </span>
          </span>
          <textarea
            className="suggest-input mono"
            value={proposed}
            onChange={(e) => setProposed(e.target.value)}
            rows={Math.min(8, Math.max(3, Math.ceil(proposed.length / 64)))}
            maxLength={4000}
            disabled={busy}
            placeholder="Type a proposed English translation for this phrase…"
          />
          {over && maxChars != null && (
            <span className="suggest-warn">
              This exceeds the in-game budget of {maxChars} chars — it may not fit.
            </span>
          )}
        </label>
        <label className="suggest-field">
          <span className="suggest-field-label">Why this change? (optional)</span>
          <textarea
            className="suggest-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={SUGGEST_MAX_REASON}
            placeholder="Typo, awkward phrasing, official localization, etc."
            disabled={busy}
          />
        </label>
        <label className="suggest-field">
          <span className="suggest-field-label">Your name (optional)</span>
          <input
            type="text"
            className="suggest-input"
            value={submitter}
            onChange={(e) => setSubmitter(e.target.value)}
            maxLength={SUGGEST_MAX_AUTHOR}
            placeholder="Anonymous"
            disabled={busy}
          />
        </label>
        {err && <div className="suggest-error">{err}</div>}
        {flash && (
          <div className="suggest-posted">
            ✓ Submitted — thanks! You can refine the suggestion above and submit again, or
            navigate to another phrase.
          </div>
        )}
        <div className="suggest-actions">
          <button
            type="submit"
            className="btn btn-primary suggest-submit"
            disabled={busy || disabled}
            title={disabled ? disabledReason : undefined}
          >
            {busy ? 'Submitting…' : 'Submit suggestion'}
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Proposed-changes panel (step-340) — lists every edit_suggestions row
// submitted against the currently-selected entry so researchers can see
// what other readers have proposed without flipping over to the admin
// queue.
//
// Scope (first cut, per Tyler's brief): we fetch only `entries_path:` refs
// matching this entry. Older submissions from /translation/ use the
// `entries:<file_id>:...` form which the viewer can't resolve without a
// path -> file_id map; that gap is acknowledged in a small footnote.
// ---------------------------------------------------------------------------

interface EditSuggestionRow {
  id: number;
  kind: string | null;
  ref: string;
  original_en: string | null;
  proposed_en: string;
  reason: string | null;
  submitter: string | null;
  status: string | null;
  created_at: string;
}

function parsePhraseIndexFromRef(ref: string): number | null {
  // Refs we care about are `entries_path:<file_path>:<entry_id>:<sub_entry_id>:<phrase_index>`.
  // file_path may contain ':' on Windows-y inputs in theory, but the
  // submitter writes the project's POSIX-style ROM paths which don't —
  // so the phrase index is reliably the trailing segment after the last
  // ':'. Defensive: return null when it doesn't parse as a number.
  const tail = ref.split(':').pop();
  if (!tail) return null;
  const n = Number(tail);
  return Number.isFinite(n) ? n : null;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const now = Date.now();
  const diffMs = now - then.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day} days ago`;
  // Fall back to a short month-day stamp; include the year if it's not
  // the current year so suggestions from 2024 don't read like "May 21".
  const sameYear = then.getFullYear() === new Date().getFullYear();
  return then.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

function ProposedChangesPanel({
  filePath,
  block,
}: {
  filePath: string;
  block: ViewerBlock | null;
}) {
  const [rows, setRows] = useState<EditSuggestionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // We fan-fetch by (file_path, entry_id, sub_entry_id) and ignore the
  // trailing phrase index so all phrases of the current Textblock are
  // grouped together. The DB stores the ref as a single string column,
  // so we use a PostgREST `like` filter to match the prefix.
  const refPrefix = block
    ? `entries_path:${filePath}:${block.entry_id}:${block.sub_entry_id}:`
    : '';

  useEffect(() => {
    let aborted = false;
    if (!block || !filePath) {
      setRows([]);
      setErr(null);
      return;
    }
    if (!supabaseConfigured || !supabase) {
      setRows([]);
      setErr(null);
      return;
    }
    setLoading(true);
    setErr(null);
    // `like` requires `*` as the wildcard in PostgREST (the supabase-js
    // client passes the literal value through to the URL).
    supabase
      .from('edit_suggestions')
      .select(
        'id,kind,ref,original_en,proposed_en,reason,submitter,status,created_at',
      )
      .like('ref', `${refPrefix}*`)
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (aborted) return;
        if (error) {
          setErr(error.message);
          setRows([]);
        } else {
          setRows((data ?? []) as EditSuggestionRow[]);
        }
        setLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, [refPrefix, reloadToken]);

  const hasBlock = !!block;
  const disabledBackend = !supabaseConfigured;

  return (
    <aside className="proposed">
      <header className="proposed-head">
        <span className="proposed-head-title">Proposed changes</span>
        <button
          type="button"
          className="proposed-refresh"
          onClick={() => setReloadToken((t) => t + 1)}
          disabled={!hasBlock || loading || disabledBackend}
          title={
            disabledBackend
              ? "Suggestions backend isn't configured."
              : 'Refresh the list'
          }
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>
      <div className="proposed-body">
        {!hasBlock && (
          <p className="proposed-empty">Select an entry to see suggestions.</p>
        )}
        {hasBlock && disabledBackend && (
          <p className="proposed-empty">
            Suggestions are disabled — the site owner hasn't connected the
            submissions backend yet.
          </p>
        )}
        {hasBlock && !disabledBackend && err && (
          <p className="proposed-error">Couldn't load suggestions: {err}</p>
        )}
        {hasBlock && !disabledBackend && !err && rows.length === 0 && !loading && (
          <p className="proposed-empty">
            No suggestions submitted for this entry yet.
          </p>
        )}
        {hasBlock && !disabledBackend && rows.length > 0 && (
          <ul className="proposed-list">
            {rows.map((row) => {
              const phraseIdx = parsePhraseIndexFromRef(row.ref);
              const status = (row.status || 'pending').toLowerCase();
              return (
                <li key={row.id} className="proposed-item">
                  <div className="proposed-item-head">
                    <span className="proposed-phrase">
                      {phraseIdx == null
                        ? 'Phrase ?'
                        : `Phrase ${phraseIdx + 1}`}
                    </span>
                    <span
                      className={`proposed-status proposed-status-${status}`}
                    >
                      {status}
                    </span>
                  </div>
                  <div className="proposed-text mono">{row.proposed_en}</div>
                  {row.reason && (
                    <div className="proposed-reason">
                      <span className="proposed-reason-label">Reason:</span>{' '}
                      {row.reason}
                    </div>
                  )}
                  <div className="proposed-meta">
                    <span className="proposed-submitter">
                      {row.submitter && row.submitter.trim()
                        ? row.submitter
                        : '(anonymous)'}
                    </span>
                    <span className="proposed-sep">·</span>
                    <span
                      className="proposed-date"
                      title={new Date(row.created_at).toLocaleString()}
                    >
                      {formatRelativeTime(row.created_at)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="proposed-foot">
        Older submissions from <code>/translation/</code> use a different
        ref shape and aren't included here yet.
      </p>
    </aside>
  );
}

function SearchBar({
  query,
  setQuery,
  fields,
  setFields,
  matchCount,
  totalBlocks,
  totalFiles,
  romLoaded,
}: {
  query: string;
  setQuery: (q: string) => void;
  fields: { en: boolean; jp: boolean };
  setFields: (f: { en: boolean; jp: boolean }) => void;
  matchCount: number;
  totalBlocks: number;
  totalFiles: number;
  romLoaded: boolean;
}) {
  return (
    <div className="searchbar">
      <div className="searchbar-input-wrap">
        <span className="searchbar-icon" aria-hidden="true">
          ✦
        </span>
        <input
          type="search"
          className="searchbar-input"
          placeholder="Search JP, EN, or [opcode] tokens. Use * for wildcards."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {(query.includes('*') || query.includes('?')) && (
          <span className="searchbar-mode" title="Wildcard mode active">
            wildcard
          </span>
        )}
        {query.includes('[') && (
          <span className="searchbar-mode" title="Searching opcode tokens">
            opcode
          </span>
        )}
        {query && (
          <button
            className="searchbar-clear"
            onClick={() => setQuery('')}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>
      <fieldset className="searchbar-fields">
        <legend className="sr">Search in</legend>
        <label className={fields.en ? 'is-on' : ''}>
          <input
            type="checkbox"
            checked={fields.en}
            onChange={(e) => setFields({ ...fields, en: e.target.checked })}
          />
          <span>English</span>
        </label>
        <label
          className={`${fields.jp ? 'is-on' : ''} ${!romLoaded ? 'is-disabled' : ''}`}
          title={!romLoaded ? 'Load a ROM to search Japanese' : undefined}
        >
          <input
            type="checkbox"
            checked={fields.jp}
            disabled={!romLoaded}
            onChange={(e) => setFields({ ...fields, jp: e.target.checked })}
          />
          <span>Japanese</span>
        </label>
      </fieldset>
      <div className="searchbar-meta">
        {query ? (
          <span>
            <strong>{matchCount}</strong> {matchCount === 1 ? 'match' : 'matches'}
          </span>
        ) : (
          <span>
            <strong>{totalBlocks.toLocaleString()}</strong> Textblocks across{' '}
            <strong>{totalFiles}</strong> files
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function TranslationViewer({ lookupUrl, decorationBase }: Props) {
  const [lookup, setLookup] = useState<EnLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [rom, setRom] = useState<RomInfo | null>(null);
  const [extraction, setExtraction] = useState<RomExtraction | null>(null);
  const [parsing, setParsing] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [fields, setFields] = useState({ en: true, jp: true });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set(),
  );
  const [selected, setSelected] = useState<{ file: string; blockId: string } | null>(null);
  const [selectedPhraseIndex, setSelectedPhraseIndex] = useState(0);
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);

  const workerRef = useRef<Worker | null>(null);

  // Load EN lookup once on mount.
  useEffect(() => {
    let aborted = false;
    fetch(lookupUrl, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: EnLookup) => {
        if (aborted) return;
        setLookup(data);
        // Nothing is pre-selected. The user picks what they want to view.
      })
      .catch((err) => {
        if (aborted) return;
        setLookupError((err as Error).message || String(err));
      });
    return () => {
      aborted = true;
    };
  }, [lookupUrl]);

  // Cleanup worker on unmount.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  function unloadRom() {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRom(null);
    setExtraction(null);
    setParseError(null);
    setProgressLabel(null);
    setParsing(false);
  }

  function loadRom(file: File) {
    if (!lookup) return;
    setParseError(null);
    setExtraction(null);
    setRom({ name: file.name, size: file.size });
    setParsing(true);
    setProgressLabel('Reading file…');

    file
      .arrayBuffer()
      .then((buf) => {
        // (Re-)spawn the worker on every load so a previous failure doesn't
        // leak state between attempts.
        workerRef.current?.terminate();
        const worker = new Worker(
          new URL('../lib/rom/rom-worker.ts', import.meta.url),
          { type: 'module' },
        );
        workerRef.current = worker;
        worker.addEventListener('message', (event: MessageEvent<WorkerOutbound>) => {
          const msg = event.data;
          if (msg.type === 'progress') {
            const p = msg.progress;
            if (p.phase === 'extract' && p.files_done != null && p.files_total != null) {
              setProgressLabel(`Extracting (${p.files_done} / ${p.files_total} files)`);
            } else if (p.message) {
              setProgressLabel(p.message);
            }
          } else if (msg.type === 'done') {
            const by_path = new Map<string, ExtractedFileJP>();
            const files: ExtractedFileJP[] = msg.files.map((f) => {
              const tbs = new Map<string, Textblock>(f.textblocks);
              const efj: ExtractedFileJP = {
                file_path: f.file_path,
                file_id: f.file_id,
                reso_entry_count: f.reso_entry_count,
                textblocks: tbs,
              };
              by_path.set(f.file_path, efj);
              return efj;
            });
            setRom((cur) => (cur ? { ...cur, header: msg.header } : cur));
            setExtraction({
              header: msg.header,
              files,
              by_path,
              generated_at: Date.now(),
            });
            setParsing(false);
            setProgressLabel(null);
          } else if (msg.type === 'error') {
            setParseError(msg.message);
            setParsing(false);
            setProgressLabel(null);
          }
        });
        worker.addEventListener('error', (event) => {
          setParseError(event.message || 'Worker failed without a message.');
          setParsing(false);
          setProgressLabel(null);
        });
        const expected_paths = lookup.files.map((f) => f.file_path);
        worker.postMessage(
          { type: 'parse', buffer: buf, expected_paths },
          // Transfer the buffer so we don't keep a 256 MB copy alive on the
          // main thread.
          [buf],
        );
      })
      .catch((err) => {
        setParseError((err as Error).message || String(err));
        setParsing(false);
      });
  }

  // ---- Derived viewer state ----
  const viewerFiles = useMemo(() => buildViewerFiles(lookup, extraction), [lookup, extraction]);
  const totalBlocks = useMemo(
    () => viewerFiles.reduce((n, f) => n + f.blocks.filter((b) => b.en || b.jp).length, 0),
    [viewerFiles],
  );
  const effectiveFields = useMemo(
    () => ({ en: fields.en, jp: fields.jp && !!extraction }),
    [fields, extraction],
  );

  const matcher = useMemo(() => buildMatcher(query), [query]);
  const opcodeMode = useMemo(() => queryIsOpcode(query), [query]);
  const matchCount = useMemo(() => {
    if (!matcher) return 0;
    let n = 0;
    for (const f of viewerFiles) {
      for (const b of f.blocks) {
        if (blockMatches(b, matcher, effectiveFields, opcodeMode)) n += 1;
      }
    }
    return n;
  }, [matcher, opcodeMode, viewerFiles, effectiveFields]);

  // Build a directory tree from the file paths. When a search query is
  // active we FILTER to files that contain at least one matching block —
  // the rest of the tree (parent dirs) is rebuilt around just those.
  const tree = useMemo(
    () => buildDirTree(viewerFiles, matcher, effectiveFields, opcodeMode),
    [viewerFiles, matcher, effectiveFields, opcodeMode],
  );
  const shownFileCount = useMemo(() => countFiles(tree), [tree]);

  const currentBlock = useMemo<ViewerBlock | null>(() => {
    if (!selected) return null;
    const file = viewerFiles.find((f) => f.file_path === selected.file);
    if (!file) return null;
    return file.blocks.find((b) => b.id === selected.blockId) ?? null;
  }, [selected, viewerFiles]);

  // Reset to Page 1 whenever the user navigates to a different Textblock.
  // We key on the join of file + block id so switching back to the same
  // entry doesn't churn the index (and re-trigger the effect needlessly).
  useEffect(() => {
    setSelectedPhraseIndex(0);
  }, [selected?.file, selected?.blockId]);

  function onSelectFile(file: ViewerFile) {
    // Always update the selection even when the file has no blocks — that
    // way clicking an empty file deselects whatever else was highlighted,
    // instead of silently leaving the previous file purple.
    const firstBlock = file.blocks.find((b) => b.en || b.jp) ?? file.blocks[0];
    setSelected({ file: file.file_path, blockId: firstBlock?.id ?? '' });
  }
  function onSelectBlock(file: ViewerFile, b: ViewerBlock) {
    setSelected({ file: file.file_path, blockId: b.id });
    setMobileTreeOpen(false);
  }

  // ---- Render ----
  if (lookupError) {
    return (
      <div className="viewer">
        <div className="rombar has-error">
          <div className="rombar-status">
            <strong>Couldn't load the translation lookup.</strong> {lookupError}
          </div>
        </div>
        <ViewerStyle decorationBase={decorationBase} />
      </div>
    );
  }
  if (!lookup) {
    return (
      <div className="viewer">
        <p className="muted">Loading translation lookup…</p>
        <ViewerStyle decorationBase={decorationBase} />
      </div>
    );
  }

  const selectedFileName = selected?.file.split('/').pop() ?? '';
  const selectedBlockLabel = selected
    ? `Textblock ${selected.blockId.split('.')[0].padStart(2, '0')}`
    : 'no selection';

  return (
    <div className="viewer">
      <RomBar
        rom={rom}
        onLoad={loadRom}
        onUnload={unloadRom}
        parsing={parsing}
        progressLabel={progressLabel}
        errorMessage={parseError}
      />
      <SearchBar
        query={query}
        setQuery={setQuery}
        fields={fields}
        setFields={setFields}
        matchCount={matchCount}
        totalBlocks={totalBlocks}
        totalFiles={lookup.counts.files}
        romLoaded={!!extraction}
      />

      <button
        className="mobile-tree-toggle"
        onClick={() => setMobileTreeOpen((v) => !v)}
        aria-expanded={mobileTreeOpen}
      >
        {mobileTreeOpen ? '✕ Close file list' : '☰ Browse files'}
        <span className="mobile-tree-current">
          {selectedFileName} · {selectedBlockLabel}
        </span>
      </button>

      <div className="layout">
        <div className={`tree-col ${mobileTreeOpen ? 'is-open' : ''}`}>
          <FileTree
            tree={tree}
            shownFileCount={shownFileCount}
            totalFileCount={viewerFiles.length}
            selected={selected ?? { file: '', blockId: '' }}
            onSelectFile={onSelectFile}
            onSelectBlock={onSelectBlock}
            expanded={expanded}
            setExpanded={setExpanded}
            expandedDirs={expandedDirs}
            setExpandedDirs={setExpandedDirs}
            query={query}
            fields={fields}
          />
        </div>

        <main className="main-col">
          <div className="crumbs-inner">
            <span className="crumbs-file">{selectedFileName || '—'}</span>
            <span className="crumbs-sep">›</span>
            <span className="crumbs-block">{selectedBlockLabel}</span>
            {currentBlock && (currentBlock.en || currentBlock.jp) && (() => {
              const total = splitPhrases(currentBlock.jp, currentBlock.en).length;
              if (total === 0) return null;
              const cur = Math.min(Math.max(selectedPhraseIndex, 0), total - 1) + 1;
              return (
                <span className="crumbs-pill">
                  Page {cur} of {total}
                </span>
              );
            })()}
          </div>
          <DialogPanels
            block={currentBlock}
            romLoaded={!!extraction}
            selectedPhraseIndex={selectedPhraseIndex}
            onSelectPhrase={setSelectedPhraseIndex}
          />
          {currentBlock && (currentBlock.en || currentBlock.jp) && (() => {
            const phrases = splitPhrases(currentBlock.jp, currentBlock.en);
            const hasPhrases = phrases.length > 0;
            const safeIndex = hasPhrases
              ? Math.min(Math.max(selectedPhraseIndex, 0), phrases.length - 1)
              : 0;
            const phraseJp = hasPhrases ? phrases[safeIndex].jp : currentBlock.jp;
            const phraseEn = hasPhrases ? phrases[safeIndex].en : currentBlock.en;
            // The lookup's `max_total_chars` is a per-Textblock cap (sum of
            // all phrases), so we don't surface it per-phrase here — it
            // would mislead the count. Per-phrase caps live in the future
            // surface-specific lookup; null is the honest default.
            return (
              <SuggestEditCard
                filePath={selected?.file ?? ''}
                block={currentBlock}
                phraseIndex={safeIndex}
                phraseCount={Math.max(phrases.length, 1)}
                jp={phraseJp}
                currentEn={phraseEn}
                maxChars={null}
              />
            );
          })()}
        </main>

        <div className="preview-col">
          <ProposedChangesPanel
            filePath={selected?.file ?? ''}
            block={currentBlock}
          />
        </div>
      </div>

      <ViewerStyle decorationBase={decorationBase} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSS — ported almost verbatim from the design's index.html. The variable
// names match the design so the prototype's tweaks stay easy to follow.
// We rely on the site's existing `.container` wrapper for the outer width.
// ---------------------------------------------------------------------------

function ViewerStyle({ decorationBase: _decorationBase }: { decorationBase: string }) {
  return (
    <style>{`
      .viewer {
        /* Local design variables — only used by the viewer block so we
           don't pollute the rest of the site's pastel theme. */
        --paper:        #fbf5e9;
        --paper-edge:   #f1e7d0;
        --card:         #fffaef;
        --card-deep:    #f6ecd6;
        --ink:          #2c1f3d;
        --ink-soft:     #5d4d72;
        --ink-mute:     #8b7c9d;
        --rule:         #e6d8be;
        --rule-soft:    #efe4ca;
        --plum:         oklch(0.42 0.13 305);
        --plum-deep:    oklch(0.30 0.13 305);
        --plum-soft:    oklch(0.92 0.04 305);
        --rose:         oklch(0.66 0.13 10);
        --rose-soft:    oklch(0.94 0.04 10);
        --honey:        oklch(0.78 0.13 78);
        --mint:         oklch(0.74 0.10 165);
        --mint-soft:    oklch(0.94 0.04 165);

        --serif-local: 'Cormorant Garamond', 'Iowan Old Style', Georgia, serif;
        --sans-local:  var(--font-body);
        --mono-local:  'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;

        --r-sm: 6px;
        --r-md: 10px;
        --r-lg: 16px;
        --shadow-soft-local: 0 1px 2px rgba(60, 40, 80, 0.06), 0 8px 24px -12px rgba(60, 40, 80, 0.18);
        --shadow-card-local: 0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(60, 40, 80, 0.08), 0 6px 18px -10px rgba(60, 40, 80, 0.2);

        color: var(--ink);
        font-family: var(--sans-local);
      }
      .viewer .sr {
        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0,0,0,0); border: 0;
      }

      /* ROM bar */
      .viewer .rombar {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
        padding: 12px 16px;
        border-radius: var(--r-lg);
        border: 1px solid var(--rule);
        background: var(--card);
        box-shadow: var(--shadow-card-local);
        margin-bottom: 14px;
        position: relative;
        overflow: hidden;
      }
      .viewer .rombar::before {
        content: '';
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: 4px;
      }
      .viewer .rombar.is-empty { background: linear-gradient(180deg, #fff8e8, #fffaef); }
      .viewer .rombar.is-empty::before { background: var(--honey); }
      .viewer .rombar.is-loaded::before { background: var(--mint); }
      .viewer .rombar.has-error::before { background: var(--rose); }
      .viewer .rombar-status {
        display: flex; align-items: center; gap: 12px;
        flex: 1; min-width: 280px;
        font-size: 14px; color: var(--ink-soft); line-height: 1.4;
      }
      .viewer .rombar-status strong { color: var(--ink); font-weight: 700; }
      .viewer .rombar-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; border-radius: 50%;
        font-size: 15px; font-weight: 700; flex-shrink: 0;
      }
      .viewer .rombar.is-empty .rombar-icon {
        background: oklch(0.96 0.05 78);
        color: oklch(0.50 0.13 78);
        border: 1px dashed oklch(0.78 0.13 78);
      }
      .viewer .rombar.is-loaded .rombar-icon {
        background: var(--mint-soft);
        color: oklch(0.42 0.10 165);
        border: 1px solid var(--mint);
      }
      .viewer .rombar-fname { font-family: var(--mono-local); font-size: 13px; color: var(--plum-deep); font-weight: 600; }
      .viewer .rombar-size, .viewer .rombar-gamecode { color: var(--ink-mute); font-size: 13px; }
      .viewer .rombar-explain { color: var(--ink-mute); font-size: 13px; font-style: italic; }
      .viewer .rombar-actions { display: flex; gap: 8px; align-items: center; }
      .viewer .rombar-error {
        width: 100%;
        margin-top: 6px;
        padding: 8px 12px;
        border-radius: var(--r-md);
        background: oklch(0.94 0.05 25);
        color: oklch(0.40 0.13 25);
        font-size: 13px;
        border: 1px solid oklch(0.78 0.13 25);
      }

      /* Buttons */
      .viewer .btn {
        font-family: var(--sans-local);
        font-weight: 700;
        font-size: 14px;
        padding: 9px 16px;
        border-radius: 999px;
        border: 1px solid transparent;
        cursor: pointer;
        transition: background 0.12s, color 0.12s, border-color 0.12s, transform 0.06s;
        white-space: nowrap;
      }
      .viewer .btn:active { transform: translateY(1px); }
      .viewer .btn:disabled { opacity: 0.6; cursor: not-allowed; }
      .viewer .btn-primary {
        background: var(--plum);
        color: white;
        box-shadow: 0 1px 0 var(--plum-deep), 0 4px 12px -4px oklch(0.42 0.13 305 / 0.5);
      }
      .viewer .btn-primary:hover:not(:disabled) { background: var(--plum-deep); color: white; }
      .viewer .btn-ghost {
        background: transparent;
        color: var(--ink-soft);
        border-color: var(--rule);
      }
      .viewer .btn-ghost:hover { background: var(--paper); color: var(--ink); border-color: var(--ink-mute); }

      /* Locked / pair-lock */
      .viewer .locked {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 14px;
        background: repeating-linear-gradient(135deg, oklch(0.97 0.02 78) 0 10px, oklch(0.95 0.03 78) 10px 20px);
        border: 1px dashed oklch(0.78 0.13 78);
        border-radius: 10px;
        font-family: var(--sans-local);
        font-size: 13px;
        color: oklch(0.42 0.10 78);
      }
      .viewer .locked-icon { font-size: 16px; color: oklch(0.50 0.13 78); }
      .viewer .locked-text { font-weight: 600; }
      .viewer .pair-lock,
      .viewer .pair-budget {
        font-family: var(--sans-local);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 2px 8px;
        border-radius: 999px;
      }
      .viewer .pair-lock {
        color: oklch(0.50 0.13 78);
        background: oklch(0.96 0.05 78);
        border: 1px solid oklch(0.78 0.13 78);
      }
      .viewer .pair-budget {
        color: oklch(0.42 0.10 165);
        background: var(--mint-soft);
        border: 1px solid var(--mint);
      }
      .viewer .pair-page {
        font-family: var(--sans-local);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 2px 8px;
        border-radius: 999px;
        color: var(--plum-deep);
        background: var(--plum-soft);
        border: 1px solid var(--plum);
      }

      /* Search bar */
      .viewer .searchbar {
        display: grid;
        grid-template-columns: 1fr auto auto;
        gap: 14px;
        align-items: center;
        background: var(--card);
        border: 1px solid var(--rule);
        border-radius: var(--r-lg);
        padding: 12px 14px;
        box-shadow: var(--shadow-card-local);
        margin-bottom: 18px;
      }
      .viewer .searchbar-input-wrap {
        position: relative;
        display: flex;
        align-items: center;
      }
      .viewer .searchbar-icon {
        position: absolute;
        left: 14px;
        color: var(--honey);
        font-size: 18px;
        pointer-events: none;
      }
      .viewer .searchbar-input {
        width: 100%;
        font-family: var(--sans-local);
        font-size: 16px;
        color: var(--ink);
        background: #fffdf7;
        border: 1px solid var(--rule);
        border-radius: 10px;
        padding: 11px 38px;
        outline: none;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .viewer .searchbar-input::placeholder { color: var(--ink-mute); }
      .viewer .searchbar-input:focus {
        border-color: var(--plum);
        box-shadow: 0 0 0 3px oklch(0.92 0.04 305);
      }
      .viewer .searchbar-clear {
        position: absolute;
        right: 10px;
        width: 22px; height: 22px;
        border: none;
        border-radius: 50%;
        background: var(--ink-mute);
        color: white;
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }
      .viewer .searchbar-clear:hover { background: var(--ink-soft); }
      .viewer .searchbar-mode {
        position: absolute;
        right: 40px;
        font-family: var(--mono-local);
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--plum-deep);
        background: var(--plum-soft);
        border: 1px solid var(--plum);
        border-radius: 999px;
        padding: 1px 8px;
      }
      .viewer .searchbar-mode + .searchbar-mode { right: 96px; }
      .viewer .searchbar-fields {
        display: flex; gap: 6px; border: none; padding: 0; margin: 0;
      }
      .viewer .searchbar-fields label {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 7px 12px;
        border-radius: 999px;
        border: 1px solid var(--rule);
        background: #fffdf7;
        font-size: 13px;
        font-weight: 600;
        color: var(--ink-soft);
        cursor: pointer;
        user-select: none;
        transition: all 0.12s;
      }
      .viewer .searchbar-fields label:hover { border-color: var(--plum); color: var(--plum-deep); }
      .viewer .searchbar-fields label.is-on {
        background: var(--plum-soft);
        border-color: var(--plum);
        color: var(--plum-deep);
      }
      .viewer .searchbar-fields label.is-disabled {
        opacity: 0.5;
        cursor: not-allowed;
        background: var(--paper-edge);
      }
      .viewer .searchbar-fields label.is-disabled:hover {
        border-color: var(--rule);
        color: var(--ink-soft);
      }
      .viewer .searchbar-fields input { accent-color: var(--plum); margin: 0; }
      .viewer .searchbar-meta {
        font-size: 13px;
        color: var(--ink-mute);
        white-space: nowrap;
        padding-right: 6px;
      }
      .viewer .searchbar-meta strong { color: var(--plum-deep); font-weight: 700; }

      /* Mobile tree toggle */
      .viewer .mobile-tree-toggle {
        display: none;
        width: 100%;
        margin-bottom: 12px;
        padding: 12px 14px;
        font-family: var(--sans-local);
        font-weight: 700;
        font-size: 14px;
        color: var(--plum-deep);
        background: var(--card);
        border: 1px solid var(--rule);
        border-radius: var(--r-md);
        cursor: pointer;
        text-align: left;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .viewer .mobile-tree-current {
        font-family: var(--mono-local);
        font-size: 12px;
        font-weight: 500;
        color: var(--ink-mute);
      }

      /* 3-col layout */
      .viewer .layout {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr) 340px;
        gap: 18px;
        align-items: start;
      }

      /* Tree */
      .viewer .tree-col {
        position: sticky;
        top: 12px;
        max-height: calc(100vh - 32px);
        overflow: auto;
        background: var(--card);
        border: 1px solid var(--rule);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-card-local);
      }
      .viewer .tree-head {
        position: sticky; top: 0;
        display: grid;
        grid-template-columns: 1fr 90px;
        padding: 12px 14px 8px;
        font-family: var(--serif-local);
        font-style: italic;
        font-size: 16px;
        color: var(--plum-deep);
        background: linear-gradient(180deg, var(--card) 60%, transparent);
        border-bottom: 1px dashed var(--rule);
        z-index: 1;
      }
      .viewer .tree-head-blocks { text-align: right; }
      .viewer .tree-head-filter {
        font-family: var(--mono-local);
        font-style: normal;
        font-size: 11.5px;
        color: var(--ink-mute);
      }
      .viewer .tree-empty {
        padding: 18px 14px;
        font-size: 13px;
        font-style: italic;
        color: var(--ink-mute);
        text-align: center;
      }
      .viewer .tree-dir {
        margin: 0;
      }
      .viewer .tree-dir-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 10px 6px 10px;
        cursor: pointer;
        list-style: none;
        font-family: var(--mono-local);
        font-size: 12.5px;
        color: var(--plum-deep);
        user-select: none;
      }
      .viewer .tree-dir-summary::-webkit-details-marker { display: none; }
      .viewer .tree-dir-summary::before {
        content: '▸';
        display: inline-block;
        margin-right: 6px;
        font-size: 10px;
        color: var(--ink-mute);
        transition: transform 0.12s;
      }
      .viewer .tree-dir[open] > .tree-dir-summary::before {
        transform: rotate(90deg);
      }
      .viewer .tree-dir-summary:hover {
        background: var(--plum-soft);
      }
      .viewer .tree-dir-name { flex: 1; font-weight: 600; }
      .viewer .tree-dir-count {
        font-family: var(--mono-local);
        font-style: normal;
        font-size: 11px;
        font-weight: 600;
        color: var(--ink-soft);
        background: var(--paper);
        border: 1px solid var(--rule);
        padding: 1px 8px;
        border-radius: 999px;
      }
      .viewer .tree-list { list-style: none; margin: 0; padding: 0; }
      .viewer .tree-list-root { padding: 6px 6px 14px; }
      .viewer .tree-file-btn {
        width: 100%;
        display: grid;
        grid-template-columns: 16px 1fr;
        align-items: baseline;
        gap: 6px;
        padding: 7px 10px;
        border: none;
        background: transparent;
        color: var(--ink-soft);
        font-family: var(--mono-local);
        font-size: 13px;
        font-weight: 500;
        text-align: left;
        cursor: pointer;
        border-radius: var(--r-sm);
        transition: background 0.1s, color 0.1s;
      }
      .viewer .tree-file-btn:hover { background: var(--plum-soft); color: var(--plum-deep); }
      .viewer .tree-disc { color: var(--ink-mute); font-size: 11px; }
      .viewer .tree-file-name { font-weight: 600; }
      .viewer .tree-file-label {
        grid-column: 2;
        display: block;
        margin-top: 1px;
        font-family: var(--sans-local);
        font-size: 11.5px;
        font-style: italic;
        color: var(--ink-mute);
      }
      .viewer .tree-file.is-selected > .tree-file-btn {
        background: var(--plum-soft);
        color: var(--plum-deep);
      }
      .viewer .tree-file.is-match > .tree-file-btn {
        box-shadow: inset 2px 0 0 var(--mint);
      }
      .viewer .tree-blocks {
        list-style: none;
        margin: 2px 0 8px 22px;
        padding: 2px 0 2px 8px;
        border-left: 1px dotted var(--rule);
      }
      .viewer .tree-block {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        border: none;
        background: transparent;
        font-family: var(--mono-local);
        font-size: 12px;
        color: var(--ink-soft);
        text-align: left;
        cursor: pointer;
        border-radius: var(--r-sm);
      }
      .viewer .tree-block:hover { background: var(--rose-soft); color: var(--ink); }
      .viewer .tree-block-id { font-weight: 700; min-width: 22px; color: var(--plum); }
      .viewer .tree-block-preview {
        font-family: var(--sans-local);
        font-size: 11.5px;
        color: var(--ink-mute);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .viewer .tree-block.is-current {
        background: var(--plum);
        color: white;
      }
      .viewer .tree-block.is-current .tree-block-id { color: white; }
      .viewer .tree-block.is-current .tree-block-preview { color: oklch(0.92 0.05 305); }
      .viewer .tree-block.is-empty .tree-block-id { color: var(--ink-mute); }
      .viewer .tree-block.is-empty:not(.is-current) { opacity: 0.55; }
      .viewer .tree-block.is-match:not(.is-current) {
        background: var(--mint-soft);
        color: var(--ink);
        box-shadow: inset 2px 0 0 var(--mint);
      }

      /* Main column */
      .viewer .main-col {
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-width: 0;
      }
      .viewer .crumbs-inner {
        display: flex; align-items: center; gap: 8px;
        padding: 0 4px 2px;
        font-size: 13px;
        color: var(--ink-mute);
      }
      .viewer .crumbs-file { font-family: var(--mono-local); font-weight: 600; color: var(--plum-deep); }
      .viewer .crumbs-sep { color: var(--rule); }
      .viewer .crumbs-block { font-family: var(--mono-local); color: var(--ink-soft); }
      .viewer .crumbs-pill {
        margin-left: auto;
        font-size: 12px;
        background: var(--card);
        border: 1px solid var(--rule);
        color: var(--ink-soft);
        border-radius: 999px;
        padding: 2px 10px;
      }

      /* JP / EN paired panels */
      .viewer .pair {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
      }
      .viewer .pair-col {
        background: var(--card);
        border: 1px solid var(--rule);
        border-radius: var(--r-lg);
        overflow: hidden;
        box-shadow: var(--shadow-card-local);
        min-height: 240px;
        display: flex;
        flex-direction: column;
      }
      .viewer .pair-head {
        padding: 10px 16px;
        font-family: var(--serif-local);
        font-style: italic;
        font-size: 16px;
        color: var(--plum-deep);
        background: linear-gradient(180deg, #fff6e4, #fffaef);
        border-bottom: 1px dashed var(--rule);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .viewer .pair-body {
        padding: 16px 18px;
        flex: 1;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .viewer .mono { font-family: var(--mono-local); font-size: 13.5px; line-height: 1.85; }
      .viewer .mono .rendered-line { display: inline; min-height: 1.6em; }
      .viewer .mono .rendered-page { display: block; }
      .viewer .mono .rendered-pagebreak {
        display: block;
        margin: 8px 0;
        height: 1px;
        background: linear-gradient(to right, transparent, var(--rule-soft), transparent);
      }
      .viewer .mono ruby rt {
        font-size: 0.55em;
        color: var(--plum);
        font-weight: 600;
        font-family: var(--sans-local);
      }
      .viewer .code-hex {
        display: inline;
        font-size: 11.5px;
        color: var(--ink-mute);
        background: oklch(0.96 0.01 305);
        padding: 1px 4px;
        border-radius: 4px;
        margin-right: 2px;
      }
      .viewer .code-tag {
        font-size: 11.5px;
        color: var(--rose);
        background: var(--rose-soft);
        padding: 1px 6px;
        border-radius: 4px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      .viewer .muted { color: var(--ink-mute); font-style: italic; }

      /* Phrases */
      .viewer .parts {
        background: var(--card);
        border: 1px solid var(--rule);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-card-local);
        overflow: hidden;
      }
      .viewer .parts-head {
        padding: 10px 16px;
        font-family: var(--serif-local);
        font-style: italic;
        font-size: 16px;
        color: var(--plum-deep);
        background: linear-gradient(180deg, #fff6e4, #fffaef);
        border-bottom: 1px dashed var(--rule);
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .viewer .parts-count {
        font-family: var(--sans-local);
        font-style: normal;
        font-size: 12px;
        color: var(--ink-mute);
        background: var(--paper);
        border: 1px solid var(--rule);
        padding: 2px 10px;
        border-radius: 999px;
      }
      .viewer .parts-empty { padding: 22px; text-align: center; color: var(--ink-mute); font-style: italic; }
      .viewer .part-row {
        display: grid;
        grid-template-columns: 36px 1fr 1fr;
        gap: 1px;
        width: 100%;
        background: var(--rule-soft);
        border: none;
        border-top: 1px solid var(--rule-soft);
        padding: 0;
        text-align: left;
        cursor: pointer;
        font: inherit;
        color: inherit;
        transition: background 0.1s, box-shadow 0.1s;
      }
      .viewer .part-row:first-of-type { border-top: none; }
      .viewer .part-row:hover .part-cell,
      .viewer .part-row:focus-visible .part-cell {
        background: var(--plum-soft);
      }
      .viewer .part-row:focus-visible {
        outline: 2px solid var(--plum);
        outline-offset: -2px;
      }
      .viewer .part-row.is-selected {
        background: var(--plum);
      }
      .viewer .part-row.is-selected .part-cell {
        background: var(--plum-soft);
        box-shadow: inset 3px 0 0 var(--plum);
      }
      .viewer .part-row.is-selected .part-index {
        background: var(--plum);
        color: white;
      }
      .viewer .part-index {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 12px 0;
        background: var(--paper-edge);
        color: var(--plum-deep);
        font-family: var(--mono-local);
        font-size: 12px;
        font-weight: 700;
      }
      .viewer .part-cell {
        background: var(--card);
        padding: 12px 16px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .viewer .part-cell:last-child { background: #fffdf7; }

      .viewer .empty-state {
        background: var(--card);
        border: 1px dashed var(--rule);
        border-radius: var(--r-lg);
        padding: 60px 30px;
        text-align: center;
        color: var(--ink-mute);
      }
      .viewer .empty-state p { margin: 0; font-size: 15px; }

      /* Right-column container (kept the legacy .preview-col class so
         the layout grid rules don't have to be rewritten — it now wraps
         the Proposed-changes panel instead of the old in-game preview). */
      .viewer .preview-col {
        display: flex;
        flex-direction: column;
        gap: 12px;
        position: sticky;
        top: 12px;
      }

      /* Proposed-changes panel (step-340) — lists edit_suggestions for
         the currently-selected entry. Styled to sit between the existing
         pair card and suggest-edit form using the same paper/card tokens. */
      .viewer .proposed {
        background: var(--card);
        border: 1px solid var(--rule);
        border-radius: var(--r-lg);
        overflow: hidden;
        box-shadow: var(--shadow-card-local);
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .viewer .proposed-head {
        padding: 10px 16px;
        font-family: var(--serif-local);
        font-style: italic;
        font-size: 16px;
        color: var(--plum-deep);
        background: linear-gradient(180deg, #fff6e4, #fffaef);
        border-bottom: 1px dashed var(--rule);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .viewer .proposed-head-title { font-style: italic; }
      .viewer .proposed-refresh {
        font-family: var(--sans-local);
        font-style: normal;
        font-size: 12px;
        font-weight: 600;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--rule);
        background: #fffaef;
        color: var(--plum-deep);
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .viewer .proposed-refresh:hover:not(:disabled) {
        background: var(--plum-soft);
        border-color: var(--plum);
      }
      .viewer .proposed-refresh:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .viewer .proposed-body {
        padding: 12px 14px;
        flex: 1 1 auto;
        min-height: 0;
        max-height: min(70vh, 720px);
        overflow-y: auto;
      }
      .viewer .proposed-empty,
      .viewer .proposed-error {
        margin: 0;
        padding: 12px 4px;
        font-size: 13px;
        color: var(--ink-mute);
        text-align: center;
        font-style: italic;
      }
      .viewer .proposed-error { color: oklch(0.50 0.18 25); }
      .viewer .proposed-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .viewer .proposed-item {
        background: #fffdf7;
        border: 1px solid var(--rule-soft);
        border-radius: var(--r-md);
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .viewer .proposed-item-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .viewer .proposed-phrase {
        font-family: var(--mono-local);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--plum-deep);
      }
      .viewer .proposed-status {
        font-family: var(--sans-local);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid transparent;
        background: var(--card-deep);
        color: var(--ink-soft);
      }
      .viewer .proposed-status-pending {
        background: oklch(0.95 0.05 78);
        border-color: oklch(0.82 0.12 78);
        color: oklch(0.40 0.10 60);
      }
      .viewer .proposed-status-accepted {
        background: var(--mint-soft);
        border-color: var(--mint);
        color: oklch(0.36 0.10 165);
      }
      .viewer .proposed-status-rejected {
        background: oklch(0.96 0.05 25);
        border-color: oklch(0.78 0.13 25);
        color: oklch(0.40 0.15 25);
      }
      .viewer .proposed-status-duplicate {
        background: oklch(0.94 0.04 260);
        border-color: oklch(0.76 0.10 260);
        color: oklch(0.36 0.10 260);
      }
      .viewer .proposed-status-needs_info {
        background: var(--plum-soft);
        border-color: var(--plum);
        color: var(--plum-deep);
      }
      .viewer .proposed-text {
        background: var(--paper);
        border: 1px solid var(--rule-soft);
        border-radius: var(--r-sm);
        padding: 8px 10px;
        font-size: 13px;
        line-height: 1.45;
        color: var(--ink);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .viewer .proposed-reason {
        font-size: 12px;
        color: var(--ink-soft);
        line-height: 1.4;
      }
      .viewer .proposed-reason-label {
        font-weight: 700;
        color: var(--ink);
      }
      .viewer .proposed-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--ink-mute);
      }
      .viewer .proposed-submitter { font-weight: 600; }
      .viewer .proposed-sep { opacity: 0.6; }
      .viewer .proposed-foot {
        margin: 0;
        padding: 8px 14px 10px;
        border-top: 1px dashed var(--rule);
        font-size: 11px;
        color: var(--ink-mute);
        font-style: italic;
        text-align: center;
      }
      .viewer .proposed-foot code {
        font-family: var(--mono-local);
        font-size: 10.5px;
        background: var(--paper-edge);
        padding: 1px 5px;
        border-radius: 4px;
        color: var(--ink-soft);
      }

      /* Suggest-edit card (step-338) — per-phrase submission to the
         same edit_suggestions table that powers /translation/. Styled
         to match the existing pair / parts / preview cards. */
      .viewer .suggest {
        background: var(--card);
        border: 1px solid var(--rule);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-card-local);
        overflow: hidden;
      }
      .viewer .suggest-head {
        padding: 10px 16px;
        font-family: var(--serif-local);
        font-style: italic;
        font-size: 16px;
        color: var(--plum-deep);
        background: linear-gradient(180deg, #fff6e4, #fffaef);
        border-bottom: 1px dashed var(--rule);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .viewer .suggest-head-title { display: inline-flex; gap: 8px; align-items: baseline; }
      .viewer .suggest-head-scope {
        font-family: var(--sans-local);
        font-style: normal;
        font-size: 12px;
        color: var(--ink-mute);
      }
      .viewer .suggest-budget {
        font-family: var(--sans-local);
        font-style: normal;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 2px 8px;
        border-radius: 999px;
        color: oklch(0.42 0.10 165);
        background: var(--mint-soft);
        border: 1px solid var(--mint);
      }
      .viewer .suggest-banner {
        margin: 12px 16px 0;
        padding: 9px 12px;
        background: oklch(0.96 0.05 78);
        border: 1px solid oklch(0.78 0.13 78);
        border-radius: var(--r-md);
        color: oklch(0.42 0.10 78);
        font-size: 13px;
      }
      .viewer .suggest-banner strong { color: oklch(0.40 0.13 78); }
      .viewer .suggest-context {
        padding: 12px 16px 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .viewer .suggest-context-row {
        display: grid;
        grid-template-columns: 90px 1fr;
        gap: 12px;
        align-items: baseline;
      }
      .viewer .suggest-label {
        font-family: var(--serif-local);
        font-style: italic;
        font-size: 13px;
        color: var(--plum-deep);
        text-align: right;
        padding-top: 2px;
      }
      .viewer .suggest-context-text {
        background: #fffdf7;
        border: 1px solid var(--rule-soft);
        border-radius: var(--r-sm);
        padding: 8px 12px;
        font-size: 13.5px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        min-height: 24px;
      }
      .viewer .suggest-form {
        padding: 12px 16px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .viewer .suggest-field { display: flex; flex-direction: column; gap: 4px; }
      .viewer .suggest-field-label {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
        font-family: var(--sans-local);
        font-weight: 600;
        color: var(--plum-deep);
        font-size: 13px;
      }
      .viewer .suggest-count {
        font-family: var(--mono-local);
        font-weight: 600;
        color: var(--ink-mute);
        font-size: 12px;
      }
      .viewer .suggest-count.over { color: var(--rose); }
      .viewer .suggest-count-hint { color: var(--ink-mute); font-weight: 500; }
      .viewer .suggest-input {
        font-family: var(--sans-local);
        font-size: 14px;
        line-height: 1.55;
        color: var(--ink);
        background: #fffdf7;
        border: 1px solid var(--rule);
        border-radius: var(--r-md);
        padding: 9px 12px;
        outline: none;
        resize: vertical;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .viewer .suggest-input.mono {
        font-family: var(--mono-local);
        font-size: 13.5px;
      }
      .viewer .suggest-input:focus {
        border-color: var(--plum);
        box-shadow: 0 0 0 3px oklch(0.92 0.04 305);
      }
      .viewer .suggest-input:disabled { opacity: 0.6; cursor: not-allowed; }
      .viewer .suggest-warn {
        color: oklch(0.50 0.13 35);
        font-size: 12px;
        font-style: italic;
      }
      .viewer .suggest-error {
        color: var(--rose);
        background: var(--rose-soft);
        padding: 8px 12px;
        border-radius: var(--r-md);
        border: 1px solid oklch(0.78 0.13 10);
        font-size: 13px;
      }
      .viewer .suggest-posted {
        color: oklch(0.40 0.12 145);
        background: oklch(0.94 0.06 145);
        padding: 8px 12px;
        border-radius: var(--r-md);
        border: 1px solid oklch(0.74 0.10 145);
        font-size: 13px;
        font-weight: 600;
      }
      .viewer .suggest-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .viewer .suggest-submit { padding: 9px 18px; }

      /* Responsive */
      @media (max-width: 1180px) {
        .viewer .layout { grid-template-columns: 260px minmax(0, 1fr); }
        .viewer .preview-col {
          grid-column: 1 / -1;
          position: static;
          max-width: 720px;
          margin: 6px auto 0;
          width: 100%;
        }
        .viewer .proposed-body { max-height: 480px; }
      }
      @media (max-width: 820px) {
        .viewer .searchbar { grid-template-columns: 1fr; }
        .viewer .searchbar-meta { order: -1; padding-right: 0; }
        .viewer .layout { grid-template-columns: 1fr; }
        .viewer .tree-col {
          display: none;
          position: static;
          max-height: 50vh;
        }
        .viewer .tree-col.is-open { display: block; }
        .viewer .mobile-tree-toggle { display: flex; }
        .viewer .pair { grid-template-columns: 1fr; }
        .viewer .pair-col { min-height: 160px; }
        .viewer .part-row { grid-template-columns: 36px 1fr; }
        .viewer .part-cell:last-child { grid-column: 2; border-top: 1px dashed var(--rule); }
        .viewer .suggest-context-row { grid-template-columns: 1fr; gap: 4px; }
        .viewer .suggest-label { text-align: left; }
      }
    `}</style>
  );
}
