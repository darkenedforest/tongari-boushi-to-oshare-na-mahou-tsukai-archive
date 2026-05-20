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
  /** Category id (matches one of EnCategory.id). Older lookups built before
   *  step-326 won't have this field; the viewer falls back to "other". */
  category?: string;
  max_entry_id: number;
  entries: Record<string, Record<string, EnEntry>>;
}

interface EnCategory {
  id: string;
  label: string;
  file_count: number;
  entry_count: number;
}

interface EnLookup {
  generated_at: string;
  source_db_mtime: string;
  scope: string;
  counts: { files: number; entries: number; categories?: number };
  /** New in step-326. Older payloads don't have this — the viewer builds a
   *  synthetic single "all" category in that case. */
  categories?: EnCategory[];
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

interface TreeGroup {
  id: string;
  label: string;
  files: ViewerFile[];
}

function FileTree({
  groups,
  totalFileCount,
  selected,
  onSelectFile,
  onSelectBlock,
  expanded,
  setExpanded,
  expandedCategories,
  setExpandedCategories,
  query,
  fields,
}: {
  groups: TreeGroup[];
  totalFileCount: number;
  selected: { file: string; blockId: string };
  onSelectFile: (file: ViewerFile) => void;
  onSelectBlock: (file: ViewerFile, b: ViewerBlock) => void;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  expandedCategories: Set<string>;
  setExpandedCategories: (s: Set<string>) => void;
  query: string;
  fields: { en: boolean; jp: boolean };
}) {
  const matcher = useMemo(() => buildMatcher(query), [query]);
  const opcodeMode = queryIsOpcode(query);
  const isMatch = (b: ViewerBlock) =>
    matcher ? blockMatches(b, matcher, fields, opcodeMode) : false;

  const filteringActive = matcher !== null;
  const shownFileCount = groups.reduce((n, g) => n + g.files.length, 0);

  return (
    <nav className="tree" aria-label="Dialog files">
      <div className="tree-head">
        <span className="tree-head-files">
          Dialog Files
          {filteringActive && (
            <span className="tree-head-filter">
              {' '}
              · {shownFileCount} of {totalFileCount}
            </span>
          )}
        </span>
        <span className="tree-head-blocks">Textblocks</span>
      </div>
      {groups.length === 0 && (
        <div className="tree-empty">
          {filteringActive
            ? 'No files match this search.'
            : 'No files loaded yet — wait for the lookup to finish loading.'}
        </div>
      )}
      {groups.map((group) => {
        const catOpen = expandedCategories.has(group.id) || filteringActive;
        return (
          <details
            key={group.id}
            className="tree-category"
            open={catOpen}
            onToggle={(e) => {
              const target = e.currentTarget;
              const next = new Set(expandedCategories);
              if (target.open) next.add(group.id);
              else next.delete(group.id);
              setExpandedCategories(next);
            }}
          >
            <summary className="tree-category-summary">
              <span className="tree-category-label">{group.label}</span>
              <span className="tree-category-count">{group.files.length}</span>
            </summary>
            <ol className="tree-list">
              {group.files.map((file) => {
                const isOpen = expanded.has(file.file_path) || filteringActive;
                const isSel = selected.file === file.file_path;
                const fileMatches = filteringActive && file.blocks.some(isMatch);
                return (
                  <li
                    key={file.file_path}
                    className={`tree-file ${isSel ? 'is-selected' : ''} ${
                      fileMatches ? 'is-match' : ''
                    }`}
                  >
                    <button
                      className="tree-file-btn"
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
                      <span className="tree-file-name">
                        {file.file_path.split('/').pop()}
                      </span>
                      <span className="tree-file-label">{file.label}</span>
                    </button>
                    {isOpen && (
                      <ol className="tree-blocks">
                        {file.blocks.map((b) => {
                          // When filtering, hide blocks that don't match.
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
              })}
            </ol>
          </details>
        );
      })}
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

function GamePreview({ block }: { block: ViewerBlock | null }) {
  const text = block
    ? plainSearchable(block.en)
        .split(/\s+/)
        .filter(Boolean)
        .join(' ')
        .slice(0, 120)
    : '';
  return (
    <aside className="preview">
      <header className="preview-head">In-Game Preview</header>
      <div className="preview-screen" role="img" aria-label="DS screen preview">
        <div className="preview-scene">
          <div className="preview-horizon" />
          <div className="preview-tree preview-tree-l" />
          <div className="preview-tree preview-tree-r" />
          <div className="preview-cloud preview-cloud-1" />
          <div className="preview-cloud preview-cloud-2" />
          <div className="preview-char">
            <div className="preview-hat" />
            <div className="preview-body" />
          </div>
          <div className="preview-stars">
            <span>✦</span>
            <span>✧</span>
            <span>⋆</span>
          </div>
        </div>
        <div className="preview-bubble">
          <div className="preview-bubble-tail" />
          <p>{text || <span className="preview-bubble-ph">[ English text appears here ]</span>}</p>
        </div>
      </div>
      <p className="preview-cap">
        Placeholder DS screen — text reflects the selected Textblock's English line.
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
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
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
        // Pre-select the first file's first block so the page isn't empty.
        const first = data.files[0];
        if (first && first.entries) {
          const firstEntryId = Object.keys(first.entries).sort((a, b) => Number(a) - Number(b))[0];
          if (firstEntryId !== undefined) {
            const firstSub = Object.keys(first.entries[firstEntryId])[0];
            setSelected({ file: first.file_path, blockId: `${firstEntryId}.${firstSub}` });
            setExpanded(new Set([first.file_path]));
            // Expand the first file's category by default so the user
            // sees the same auto-selected file in the tree.
            const cat = first.category ?? 'other';
            setExpandedCategories(new Set([cat]));
          }
        }
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

  // Build category groups. When a search query is active we FILTER (not
  // just highlight) to files that contain at least one matching block.
  const groups = useMemo<TreeGroup[]>(() => {
    if (!lookup) return [];
    // Category registry — order + label come from the lookup if present,
    // otherwise fall back to a single "all" group.
    const cats: { id: string; label: string }[] =
      lookup.categories?.map((c) => ({ id: c.id, label: c.label })) ?? [
        { id: 'all', label: 'All files' },
      ];
    const idLabel = new Map(cats.map((c) => [c.id, c.label]));
    // Make sure "other" / unknown categories still surface
    const buckets = new Map<string, ViewerFile[]>();
    for (const c of cats) buckets.set(c.id, []);
    for (const f of viewerFiles) {
      // ViewerFile doesn't carry category — look it up from the lookup.
      const enFile = lookup.files.find((x) => x.file_path === f.file_path);
      const cid = enFile?.category ?? (lookup.categories ? 'other' : 'all');
      if (!buckets.has(cid)) buckets.set(cid, []);
      // Apply the search filter at the file level.
      if (matcher) {
        const hit = f.blocks.some((b) =>
          blockMatches(b, matcher, effectiveFields, opcodeMode),
        );
        if (!hit) continue;
      }
      buckets.get(cid)!.push(f);
    }
    const out: TreeGroup[] = [];
    for (const c of cats) {
      const files = buckets.get(c.id) ?? [];
      if (files.length === 0) continue;
      out.push({
        id: c.id,
        label: idLabel.get(c.id) ?? c.id,
        files,
      });
    }
    // Any "other" bucket not in the cats list
    for (const [cid, files] of buckets) {
      if (idLabel.has(cid)) continue;
      if (files.length === 0) continue;
      out.push({ id: cid, label: cid, files });
    }
    return out;
  }, [lookup, viewerFiles, matcher, effectiveFields, opcodeMode]);

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
    const firstBlock = file.blocks.find((b) => b.en || b.jp) ?? file.blocks[0];
    if (firstBlock) {
      setSelected({ file: file.file_path, blockId: firstBlock.id });
    }
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
            groups={groups}
            totalFileCount={viewerFiles.length}
            selected={selected ?? { file: '', blockId: '' }}
            onSelectFile={onSelectFile}
            onSelectBlock={onSelectBlock}
            expanded={expanded}
            setExpanded={setExpanded}
            expandedCategories={expandedCategories}
            setExpandedCategories={setExpandedCategories}
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
        </main>

        <div className="preview-col">
          <GamePreview block={currentBlock} />
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
      .viewer .tree-category {
        margin: 0;
        border-bottom: 1px dotted var(--rule-soft);
      }
      .viewer .tree-category:last-of-type { border-bottom: none; }
      .viewer .tree-category-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 14px 8px;
        cursor: pointer;
        list-style: none;
        font-family: var(--serif-local);
        font-style: italic;
        font-size: 14px;
        color: var(--plum-deep);
        background: linear-gradient(180deg, var(--card-deep), var(--card));
        user-select: none;
      }
      .viewer .tree-category-summary::-webkit-details-marker { display: none; }
      .viewer .tree-category-summary::before {
        content: '▸';
        display: inline-block;
        margin-right: 6px;
        font-size: 10px;
        color: var(--ink-mute);
        transition: transform 0.12s;
      }
      .viewer .tree-category[open] > .tree-category-summary::before {
        transform: rotate(90deg);
      }
      .viewer .tree-category-summary:hover {
        background: var(--plum-soft);
      }
      .viewer .tree-category-label { flex: 1; }
      .viewer .tree-category-count {
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
      .viewer .tree-list { list-style: none; margin: 0; padding: 6px 6px 14px; }
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

      /* Game preview */
      .viewer .preview-col {
        display: flex;
        flex-direction: column;
        gap: 12px;
        position: sticky;
        top: 12px;
      }
      .viewer .preview {
        background: var(--card);
        border: 1px solid var(--rule);
        border-radius: var(--r-lg);
        overflow: hidden;
        box-shadow: var(--shadow-card-local);
      }
      .viewer .preview-head {
        padding: 10px 16px;
        font-family: var(--serif-local);
        font-style: italic;
        font-size: 16px;
        color: var(--plum-deep);
        background: linear-gradient(180deg, #fff6e4, #fffaef);
        border-bottom: 1px dashed var(--rule);
      }
      .viewer .preview-screen {
        aspect-ratio: 4 / 3;
        position: relative;
        background: linear-gradient(180deg, oklch(0.92 0.08 230), oklch(0.96 0.05 80) 70%);
        overflow: hidden;
      }
      .viewer .preview-scene { position: absolute; inset: 0; }
      .viewer .preview-horizon {
        position: absolute; left: 0; right: 0; bottom: 38%; height: 12%;
        background: linear-gradient(180deg, oklch(0.85 0.10 145), oklch(0.78 0.12 145));
        border-top-left-radius: 50% 30%;
        border-top-right-radius: 50% 30%;
      }
      .viewer .preview-tree {
        position: absolute;
        bottom: 38%;
        width: 38px; height: 50px;
        background: oklch(0.55 0.13 150);
        border-radius: 50% 50% 30% 30% / 60% 60% 30% 30%;
      }
      .viewer .preview-tree::after {
        content: ''; position: absolute;
        bottom: -8px; left: 50%; transform: translateX(-50%);
        width: 6px; height: 12px;
        background: oklch(0.42 0.08 50);
      }
      .viewer .preview-tree-l { left: 14%; }
      .viewer .preview-tree-r { right: 16%; width: 30px; height: 42px; }
      .viewer .preview-cloud {
        position: absolute;
        background: rgba(255, 255, 255, 0.7);
        border-radius: 100px;
        height: 14px;
        filter: blur(0.3px);
      }
      .viewer .preview-cloud-1 { top: 18%; left: 12%; width: 70px; }
      .viewer .preview-cloud-2 { top: 28%; right: 14%; width: 50px; }
      .viewer .preview-char {
        position: absolute;
        left: 50%; bottom: 36%;
        transform: translateX(-50%);
        width: 30px;
      }
      .viewer .preview-hat {
        width: 0; height: 0;
        margin: 0 auto;
        border-left: 14px solid transparent;
        border-right: 14px solid transparent;
        border-bottom: 22px solid oklch(0.42 0.13 305);
        filter: drop-shadow(0 2px 0 oklch(0.32 0.13 305));
      }
      .viewer .preview-body {
        width: 24px; height: 26px;
        margin: -3px auto 0;
        background: oklch(0.80 0.10 30);
        border-radius: 12px 12px 8px 8px;
        box-shadow: inset 0 -4px 0 oklch(0.70 0.12 30);
      }
      .viewer .preview-stars {
        position: absolute;
        top: 8%; left: 0; right: 0;
        display: flex; justify-content: space-around;
        color: oklch(0.92 0.12 90);
        font-size: 16px;
        text-shadow: 0 1px 2px rgba(0,0,0,0.1);
      }
      .viewer .preview-stars span:nth-child(2) { font-size: 12px; opacity: 0.8; }
      .viewer .preview-stars span:nth-child(3) { font-size: 14px; opacity: 0.9; }
      .viewer .preview-bubble {
        position: absolute;
        left: 8%; right: 8%; bottom: 6%;
        background: rgba(255, 255, 255, 0.96);
        border: 2px solid var(--plum-deep);
        border-radius: 12px;
        padding: 10px 14px;
        min-height: 60px;
        font-family: var(--mono-local);
        font-size: 13px;
        color: var(--ink);
        line-height: 1.4;
      }
      .viewer .preview-bubble p { margin: 0; }
      .viewer .preview-bubble-tail {
        position: absolute;
        top: -10px; left: 22px;
        width: 14px; height: 10px;
        background: rgba(255, 255, 255, 0.96);
        border-left: 2px solid var(--plum-deep);
        border-top: 2px solid var(--plum-deep);
        transform: skewX(-15deg);
        border-top-left-radius: 4px;
      }
      .viewer .preview-bubble-ph { color: var(--ink-mute); font-style: italic; }
      .viewer .preview-cap {
        padding: 10px 16px 12px;
        margin: 0;
        font-size: 12px;
        color: var(--ink-mute);
        font-style: italic;
        text-align: center;
      }

      /* Responsive */
      @media (max-width: 1180px) {
        .viewer .layout { grid-template-columns: 260px minmax(0, 1fr); }
        .viewer .preview-col {
          grid-column: 1 / -1;
          position: static;
          max-width: 500px;
          margin: 6px auto 0;
          width: 100%;
        }
        .viewer .preview-screen { aspect-ratio: 16 / 7; }
        .viewer .preview-bubble { bottom: 8%; }
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
      }
    `}</style>
  );
}
