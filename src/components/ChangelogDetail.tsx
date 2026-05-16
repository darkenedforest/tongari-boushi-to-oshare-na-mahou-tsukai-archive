import { useEffect, useMemo, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────
// Types — mirror the shape of src/data/changelog_<version>.json
// (or public/data/changelog_v<version>.json for lazy-loaded variants)
// ─────────────────────────────────────────────────────────────────────

interface MsgEntry {
  rowid: number;
  file: string;
  entryId: string;
  before: string;
  after: string;
  context?: string;
}

interface ItemNameEntry {
  rowid: number;
  itemId: number;
  before: string;
  after: string;
}

interface SongEntry {
  entryId: number;
  jp: string;
  before: string;
  after: string;
}

interface OverlayRow {
  offset: string;
  slotBytes: number;
  jp: string;
  before: string;
  after: string;
  notes?: string;
}

interface OverlayGroup {
  id: string;
  label: string;
  note: string;
  rows: OverlayRow[];
}

interface ChangelogData {
  version: string;
  date: string;
  headline?: string;
  summary?: string;
  previousVersionLabel?: string;
  msgFileEdits?: {
    description: string;
    entries: MsgEntry[];
    entryIdNote?: string;
  };
  itemNameEdits?: {
    description: string;
    entries: ItemNameEntry[];
  };
  songRetranslations?: {
    file: string;
    description: string;
    entries: SongEntry[];
  };
  overlayEdits?: {
    description: string;
    compressedFlagFix?: {
      title: string;
      description: string;
      affectedOverlays: number[];
    };
    groups: OverlayGroup[];
  };
  otherChanges?: { title: string; body: string }[];
}

interface Props {
  // Caller may either provide pre-loaded data (for tiny releases that fit
  // inline at build time) or a URL to fetch on mount (for big releases
  // like v2.0 that hold tens of thousands of rows).
  data?: ChangelogData;
  dataUrl?: string;
  beforeLabel?: string;
  afterLabel?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function escapeForDisplay(s: string): string {
  // Convert literal § into a visible · escape so it doesn't get eaten by
  // browser whitespace collapse, and surface line breaks coded as ▼ etc.
  // We don't transform — just render the raw string, browser handles it.
  return s;
}

function matches(haystack: string, q: string): boolean {
  if (!q) return true;
  return haystack.toLowerCase().includes(q.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────
// Generic searchable table primitive
// ─────────────────────────────────────────────────────────────────────

interface Column<T> {
  key: string;
  label: string;
  width?: string;
  className?: string;
  // Render the cell content for a row
  render: (row: T) => React.ReactNode;
  // String used for searching + sorting on this column
  text: (row: T) => string;
  // If true this column participates in the global search box
  searchable?: boolean;
  // If false the column header isn't clickable for sort
  sortable?: boolean;
}

function SearchableTable<T>({
  caption,
  columns,
  rows,
  initialSort,
  emptyText = 'No matching rows.',
  pageSize = 200,
}: {
  caption?: React.ReactNode;
  columns: Column<T>[];
  rows: T[];
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  emptyText?: string;
  // Render at most this many rows before showing a "show N more" button.
  // Keeps the page snappy on huge tables (v2.0 has 76k+ rows). The
  // user can either narrow with the filter or click to render more.
  pageSize?: number;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(
    initialSort ?? null,
  );
  const [visible, setVisible] = useState<number>(pageSize);

  const filtered = useMemo(() => {
    const q = query.trim();
    let r = rows;
    if (q) {
      r = r.filter((row) =>
        columns.some((c) => (c.searchable !== false) && matches(c.text(row), q)),
      );
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        const dir = sort.dir === 'asc' ? 1 : -1;
        r = [...r].sort((a, b) => {
          const av = col.text(a);
          const bv = col.text(b);
          // numeric-aware: if both parse as numbers (incl. hex like 0x...),
          // sort numerically; otherwise string compare.
          const an = parseMaybeNumber(av);
          const bn = parseMaybeNumber(bv);
          if (an !== null && bn !== null) {
            return (an - bn) * dir;
          }
          return av.localeCompare(bv) * dir;
        });
      }
    }
    return r;
  }, [rows, columns, query, sort]);

  // Reset the visible window when the filter changes — otherwise typing
  // a query that produces 30 hits would still gate them behind a "show
  // more" button if the user had previously expanded the window.
  useEffect(() => {
    setVisible(pageSize);
  }, [query, pageSize]);

  const pageRows = filtered.slice(0, visible);
  const remaining = Math.max(0, filtered.length - pageRows.length);

  function toggleSort(key: string) {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: 'asc' };
      if (cur.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  }

  return (
    <div className="cl-table-wrap">
      {caption && <div className="cl-table-caption">{caption}</div>}
      <div className="cl-search-row">
        <input
          type="search"
          className="cl-search"
          placeholder="Filter rows…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter rows in this table"
        />
        <span className="cl-count">
          {pageRows.length === filtered.length
            ? `${filtered.length} / ${rows.length} row${rows.length === 1 ? '' : 's'}`
            : `showing ${pageRows.length} of ${filtered.length} (${rows.length} total)`}
        </span>
      </div>
      <div className="cl-scroll">
        <table className="cl-table">
          <thead>
            <tr>
              {columns.map((c) => {
                const sortable = c.sortable !== false;
                const active = sort?.key === c.key;
                const arrow = active ? (sort!.dir === 'asc' ? '▲' : '▼') : '';
                return (
                  <th
                    key={c.key}
                    style={c.width ? { width: c.width } : undefined}
                    className={c.className}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className={`cl-sort-btn${active ? ' active' : ''}`}
                        onClick={() => toggleSort(c.key)}
                      >
                        {c.label} <span aria-hidden="true">{arrow || '⇅'}</span>
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="cl-empty">{emptyText}</td>
              </tr>
            ) : (
              pageRows.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.className}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {remaining > 0 && (
        <div className="cl-page-more">
          <button
            type="button"
            className="cl-more-btn"
            onClick={() => setVisible((v) => v + pageSize)}
          >
            Show {Math.min(remaining, pageSize).toLocaleString()} more
            <span aria-hidden="true"> ↓</span>
          </button>
          <span className="cl-more-hint">
            ({remaining.toLocaleString()} remaining — or narrow with the filter above)
          </span>
        </div>
      )}
    </div>
  );
}

function parseMaybeNumber(s: string): number | null {
  if (!s) return null;
  const t = s.trim();
  if (/^-?0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Section: msg file edits
// ─────────────────────────────────────────────────────────────────────

function MsgSection({
  data,
  beforeLabel,
  afterLabel,
}: {
  data: NonNullable<ChangelogData['msgFileEdits']>;
  beforeLabel: string;
  afterLabel: string;
}) {
  const cols: Column<MsgEntry>[] = [
    {
      key: 'file',
      label: 'File path',
      width: '24%',
      render: (r) => <code className="cl-mono">{r.file}</code>,
      text: (r) => r.file,
    },
    {
      key: 'entryId',
      label: 'Entry ID',
      width: '8%',
      render: (r) => <code className="cl-mono">{r.entryId}</code>,
      text: (r) => r.entryId,
    },
    {
      key: 'rowid',
      label: '#',
      width: '8%',
      render: (r) => <span className="cl-muted">{r.rowid}</span>,
      text: (r) => String(r.rowid),
    },
    {
      key: 'before',
      label: `Before (${beforeLabel})`,
      render: (r) => (
        <div className="cl-cell-text cl-before">
          <pre>{escapeForDisplay(r.before)}</pre>
          {r.context && <span className="cl-context">{r.context}</span>}
        </div>
      ),
      text: (r) => r.before,
    },
    {
      key: 'after',
      label: `After (${afterLabel})`,
      render: (r) => (
        <div className="cl-cell-text cl-after">
          <pre>{escapeForDisplay(r.after)}</pre>
        </div>
      ),
      text: (r) => r.after,
    },
  ];

  return (
    <SearchableTable<MsgEntry>
      caption={
        <p className="cl-desc">{data.description}</p>
      }
      columns={cols}
      rows={data.entries}
      initialSort={{ key: 'rowid', dir: 'asc' }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Section: item name edits (new for v2.0..v2.3 — itemname.ofs)
// ─────────────────────────────────────────────────────────────────────

function ItemNameSection({
  data,
  beforeLabel,
  afterLabel,
}: {
  data: NonNullable<ChangelogData['itemNameEdits']>;
  beforeLabel: string;
  afterLabel: string;
}) {
  const cols: Column<ItemNameEntry>[] = [
    {
      key: 'itemId',
      label: 'Item ID',
      width: '10%',
      render: (r) => <code className="cl-mono">{r.itemId}</code>,
      text: (r) => String(r.itemId),
    },
    {
      key: 'before',
      label: `Before (${beforeLabel})`,
      render: (r) => <span className="cl-before-inline">{r.before || '(empty)'}</span>,
      text: (r) => r.before,
    },
    {
      key: 'after',
      label: `After (${afterLabel})`,
      render: (r) => <span className="cl-after-inline">{r.after || '(empty)'}</span>,
      text: (r) => r.after,
    },
  ];

  return (
    <SearchableTable<ItemNameEntry>
      caption={<p className="cl-desc">{data.description}</p>}
      columns={cols}
      rows={data.entries}
      initialSort={{ key: 'itemId', dir: 'asc' }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Section: song retranslations
// ─────────────────────────────────────────────────────────────────────

function SongSection({
  data,
  beforeLabel,
  afterLabel,
}: {
  data: NonNullable<ChangelogData['songRetranslations']>;
  beforeLabel: string;
  afterLabel: string;
}) {
  const cols: Column<SongEntry>[] = [
    {
      key: 'entryId',
      label: '#',
      width: '6%',
      render: (r) => <code className="cl-mono">{r.entryId}</code>,
      text: (r) => String(r.entryId),
    },
    {
      key: 'jp',
      label: 'JP',
      width: '22%',
      render: (r) => <span className="cl-jp">{r.jp}</span>,
      text: (r) => r.jp,
    },
    {
      key: 'before',
      label: `Before (${beforeLabel})`,
      render: (r) => <span className="cl-before-inline">{r.before}</span>,
      text: (r) => r.before,
    },
    {
      key: 'after',
      label: `After (${afterLabel})`,
      render: (r) => <span className="cl-after-inline">{r.after}</span>,
      text: (r) => r.after,
    },
  ];

  return (
    <SearchableTable<SongEntry>
      caption={
        <>
          <p className="cl-desc">{data.description}</p>
          <p className="cl-source">
            Source file: <code className="cl-mono">{data.file}</code>
          </p>
        </>
      }
      columns={cols}
      rows={data.entries}
      initialSort={{ key: 'entryId', dir: 'asc' }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Section: overlay / ARM9 edits
// ─────────────────────────────────────────────────────────────────────

function OverlayGroupCard({
  group,
  beforeLabel,
  afterLabel,
}: {
  group: OverlayGroup;
  beforeLabel: string;
  afterLabel: string;
}) {
  const cols: Column<OverlayRow>[] = [
    {
      key: 'offset',
      label: 'Offset',
      width: '12%',
      render: (r) => <code className="cl-mono">{r.offset}</code>,
      text: (r) => r.offset,
    },
    {
      key: 'slotBytes',
      label: 'Slot',
      width: '8%',
      render: (r) => <span className="cl-muted">{r.slotBytes} B</span>,
      text: (r) => String(r.slotBytes),
    },
    {
      key: 'jp',
      label: 'JP',
      width: '16%',
      render: (r) => <span className="cl-jp">{r.jp}</span>,
      text: (r) => r.jp,
    },
    {
      key: 'before',
      label: `Before (${beforeLabel})`,
      width: '16%',
      render: (r) => <span className="cl-before-inline">{r.before}</span>,
      text: (r) => r.before,
    },
    {
      key: 'after',
      label: `After (${afterLabel})`,
      width: '16%',
      render: (r) => <span className="cl-after-inline">{r.after}</span>,
      text: (r) => r.after,
    },
    {
      key: 'notes',
      label: 'Notes',
      render: (r) => <span className="cl-notes">{r.notes ?? ''}</span>,
      text: (r) => r.notes ?? '',
    },
  ];

  return (
    <details className="cl-overlay-group" open>
      <summary>
        <span className="cl-group-label">{group.label}</span>
        <span className="cl-group-count">{group.rows.length} row{group.rows.length === 1 ? '' : 's'}</span>
      </summary>
      <p className="cl-overlay-note">{group.note}</p>
      <SearchableTable<OverlayRow>
        columns={cols}
        rows={group.rows}
        initialSort={{ key: 'offset', dir: 'asc' }}
      />
    </details>
  );
}

function OverlaySection({
  data,
  beforeLabel,
  afterLabel,
}: {
  data: NonNullable<ChangelogData['overlayEdits']>;
  beforeLabel: string;
  afterLabel: string;
}) {
  return (
    <>
      <p className="cl-desc">{data.description}</p>
      {data.compressedFlagFix && (
        <div className="cl-callout">
          <h3>{data.compressedFlagFix.title}</h3>
          <p>{data.compressedFlagFix.description}</p>
          <p className="cl-affected">
            <strong>Affected overlays:</strong>{' '}
            {data.compressedFlagFix.affectedOverlays.map((id, i) => (
              <span key={id}>
                <code className="cl-mono">ov{id}</code>
                {i < data.compressedFlagFix!.affectedOverlays.length - 1 ? ', ' : ''}
              </span>
            ))}
          </p>
        </div>
      )}
      <div className="cl-overlay-groups">
        {data.groups.map((g) => (
          <OverlayGroupCard
            key={g.id}
            group={g}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
          />
        ))}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Section: other (byte-level / pipeline) changes
// ─────────────────────────────────────────────────────────────────────

function OtherSection({ items }: { items: ChangelogData['otherChanges'] }) {
  return (
    <div className="cl-other-list">
      {items.map((it, i) => (
        <article key={i} className="cl-other-item">
          <h3>{it.title}</h3>
          <p>{it.body}</p>
        </article>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Top-level
// ─────────────────────────────────────────────────────────────────────

function Detail({
  data,
  beforeLabel,
  afterLabel,
}: {
  data: ChangelogData;
  beforeLabel: string;
  afterLabel: string;
}) {
  // Compute per-section row counts up front. A section with zero rows is
  // hidden completely — no TOC entry, no header, no description, no empty
  // table. The overlay section is an exception: it can also justify
  // rendering on the strength of a compressedFlagFix callout alone.
  const msgCount = data.msgFileEdits?.entries.length ?? 0;
  const itemCount = data.itemNameEdits?.entries.length ?? 0;
  const songCount = data.songRetranslations?.entries.length ?? 0;
  const overlayRowCount =
    data.overlayEdits?.groups.reduce((n, g) => n + g.rows.length, 0) ?? 0;
  const hasOverlayCallout = !!data.overlayEdits?.compressedFlagFix;
  const otherCount = data.otherChanges?.length ?? 0;

  const showMsg = !!data.msgFileEdits && msgCount > 0;
  const showItems = !!data.itemNameEdits && itemCount > 0;
  const showSongs = !!data.songRetranslations && songCount > 0;
  const showOverlays =
    !!data.overlayEdits && (overlayRowCount > 0 || hasOverlayCallout);
  const showOther = !!data.otherChanges && otherCount > 0;

  // Build the TOC dynamically — only non-empty sections appear in the
  // index and get rendered.
  const sections: { id: string; label: string; count: number }[] = [];
  if (showMsg) {
    sections.push({ id: 'msg', label: 'msg file edits', count: msgCount });
  }
  if (showItems) {
    sections.push({ id: 'items', label: 'Item name edits', count: itemCount });
  }
  if (showSongs) {
    sections.push({
      id: 'songs',
      label: 'Song retranslations',
      count: songCount,
    });
  }
  if (showOverlays) {
    sections.push({
      id: 'overlays',
      label: 'Overlay / ARM9 edits',
      count: overlayRowCount,
    });
  }
  if (showOther) {
    sections.push({
      id: 'other',
      label: 'Other byte-level changes',
      count: otherCount,
    });
  }

  return (
    <>
      <nav className="cl-toc" aria-label="Sections in this release">
        {sections.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="cl-toc-item">
            <span className="cl-toc-label">{s.label}</span>
            <span className="cl-toc-count">{s.count.toLocaleString()}</span>
          </a>
        ))}
      </nav>

      {showMsg && (
        <section id="msg" className="cl-section">
          <h2>
            msg file edits
            <span className="cl-section-count">
              {msgCount.toLocaleString()}
            </span>
          </h2>
          <MsgSection
            data={data.msgFileEdits!}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
          />
          {data.msgFileEdits!.entryIdNote && (
            <p className="cl-footnote">{data.msgFileEdits!.entryIdNote}</p>
          )}
        </section>
      )}

      {showItems && (
        <section id="items" className="cl-section">
          <h2>
            Item name edits
            <span className="cl-section-count">
              {itemCount.toLocaleString()}
            </span>
          </h2>
          <ItemNameSection
            data={data.itemNameEdits!}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
          />
        </section>
      )}

      {showSongs && (
        <section id="songs" className="cl-section">
          <h2>
            Song retranslations
            <span className="cl-section-count">
              {songCount.toLocaleString()}
            </span>
          </h2>
          <SongSection
            data={data.songRetranslations!}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
          />
        </section>
      )}

      {showOverlays && (
        <section id="overlays" className="cl-section">
          <h2>
            Overlay / ARM9 edits
            <span className="cl-section-count">
              {overlayRowCount.toLocaleString()}
            </span>
          </h2>
          <OverlaySection
            data={data.overlayEdits!}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
          />
        </section>
      )}

      {showOther && (
        <section id="other" className="cl-section">
          <h2>
            Other byte-level changes
            <span className="cl-section-count">{otherCount}</span>
          </h2>
          <OtherSection items={data.otherChanges} />
        </section>
      )}

      <style>{styles}</style>
    </>
  );
}

// Top-level public component. Accepts either pre-loaded `data` (small
// releases inline at build time) or a `dataUrl` for lazy fetch on mount
// (large releases — v2.0 is 22 MB of rows).
export default function ChangelogDetail({
  data,
  dataUrl,
  beforeLabel,
  afterLabel,
}: Props) {
  const [loaded, setLoaded] = useState<ChangelogData | null>(data ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data || !dataUrl) return;
    let cancelled = false;
    fetch(dataUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${dataUrl}`);
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setLoaded(d as ChangelogData);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [data, dataUrl]);

  if (error) {
    return (
      <div className="cl-banner cl-banner-warn">
        <strong>Couldn't load the changelog.</strong> {error}{' '}
        Try refreshing the page; if it keeps failing, the data file may
        be missing from the server.
        <style>{`
          .cl-banner { padding: 14px 18px; border-radius: 14px; font-size: 0.92rem; line-height: 1.5; }
          .cl-banner-warn { background: #fff1c4; color: #6b4d00; border: 1px solid #f0d68d; }
        `}</style>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="cl-loading">
        <div className="cl-loading-card">
          <div className="cl-loading-spinner" aria-hidden="true" />
          <p>
            Loading changelog data…
            <br />
            <span className="cl-loading-note">
              Older releases can be several MB — this only downloads once
              per visit.
            </span>
          </p>
        </div>
        <style>{`
          .cl-loading { display: flex; justify-content: center; padding: 60px 20px; }
          .cl-loading-card {
            display: flex; flex-direction: column; align-items: center; gap: 14px;
            color: var(--color-ink-soft); text-align: center;
            background: var(--surface-strong);
            border: 1px solid var(--color-pink-100);
            border-radius: 18px;
            padding: 32px 40px;
            box-shadow: var(--shadow-soft);
          }
          .cl-loading-card p { margin: 0; line-height: 1.6; color: var(--color-ink); }
          .cl-loading-note { font-size: 0.84rem; color: var(--color-ink-soft); }
          .cl-loading-spinner {
            width: 32px; height: 32px; border-radius: 50%;
            border: 3px solid var(--color-pink-100);
            border-top-color: var(--color-pink-400);
            animation: cl-spin 0.9s linear infinite;
          }
          @keyframes cl-spin { to { transform: rotate(360deg); } }
        `}</style>
      </div>
    );
  }

  const bl = beforeLabel ?? loaded.previousVersionLabel ?? 'before';
  const al = afterLabel ?? `v${loaded.version}`;
  return <Detail data={loaded} beforeLabel={bl} afterLabel={al} />;
}

// ─────────────────────────────────────────────────────────────────────
// Styles (inlined — the React island ships its own scoped styles so the
// Astro page can stay a thin shell)
// ─────────────────────────────────────────────────────────────────────

const styles = `
  .cl-toc {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 4px 0 28px;
    padding: 14px 16px;
    background: var(--color-purple-50);
    border: 1px solid var(--color-purple-100);
    border-radius: 18px;
  }
  .cl-toc-item {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    background: white;
    border: 1px solid var(--color-purple-100);
    border-radius: 999px;
    font-weight: 600;
    color: var(--color-purple-600);
    font-size: 0.88rem;
    text-decoration: none;
    transition: transform 0.15s ease, box-shadow 0.15s ease, color 0.15s ease;
  }
  .cl-toc-item:hover {
    transform: translateY(-1px);
    color: var(--color-pink-600);
    box-shadow: 0 4px 12px rgba(155, 123, 217, 0.18);
  }
  .cl-toc-count {
    padding: 1px 8px;
    background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
    color: white;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 700;
  }

  .cl-section {
    margin: 0 0 44px;
    scroll-margin-top: 84px;
  }
  .cl-section > h2 {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 14px;
    font-size: 1.45rem;
  }
  .cl-section-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    padding: 2px 10px;
    background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
    color: white;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 700;
    font-family: var(--font-display);
  }

  .cl-desc {
    margin: 0 0 16px;
    line-height: 1.6;
    color: var(--color-ink);
    max-width: 78ch;
  }
  .cl-source {
    margin: -8px 0 16px;
    color: var(--color-ink-soft);
    font-size: 0.92rem;
  }
  .cl-footnote {
    margin: 10px 0 0;
    color: var(--color-ink-soft);
    font-size: 0.85rem;
    line-height: 1.55;
    font-style: italic;
  }

  /* Callout block for the compressed-flag fix */
  .cl-callout {
    margin: 0 0 24px;
    padding: 18px 22px;
    background: linear-gradient(180deg, var(--color-pink-50), white 60%);
    border: 1px solid var(--color-pink-200);
    border-left: 4px solid var(--color-pink-400);
    border-radius: 18px;
    box-shadow: var(--shadow-soft);
  }
  .cl-callout h3 {
    margin: 0 0 8px;
    color: var(--color-pink-600);
    font-size: 1.05rem;
  }
  .cl-callout p {
    margin: 0 0 8px;
    line-height: 1.6;
  }
  .cl-affected {
    margin: 8px 0 0 !important;
    font-size: 0.92rem;
    color: var(--color-ink-soft);
  }
  .cl-affected strong {
    color: var(--color-purple-600);
  }

  /* Overlay groups (collapsible) */
  .cl-overlay-groups {
    display: grid;
    gap: 16px;
  }
  .cl-overlay-group {
    background: var(--surface-strong);
    border: 1px solid var(--color-pink-100);
    border-radius: 18px;
    box-shadow: var(--shadow-soft);
    padding: 18px 22px;
  }
  .cl-overlay-group > summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    list-style: none;
    padding: 4px 0;
  }
  .cl-overlay-group > summary::-webkit-details-marker {
    display: none;
  }
  .cl-overlay-group > summary::before {
    content: '▸';
    color: var(--color-purple-400);
    margin-right: 8px;
    transition: transform 0.15s ease;
    display: inline-block;
  }
  .cl-overlay-group[open] > summary::before {
    transform: rotate(90deg);
  }
  .cl-group-label {
    flex: 1;
    font-family: var(--font-display);
    font-weight: 700;
    color: var(--color-purple-600);
    font-size: 1.05rem;
  }
  .cl-group-count {
    padding: 2px 10px;
    background: var(--color-purple-50);
    border: 1px solid var(--color-purple-100);
    border-radius: 999px;
    color: var(--color-purple-600);
    font-size: 0.78rem;
    font-weight: 700;
  }
  .cl-overlay-note {
    margin: 10px 0 16px;
    padding: 10px 14px;
    background: var(--color-blue-50);
    border-left: 3px solid var(--color-blue-400);
    border-radius: 8px;
    color: var(--color-ink);
    font-size: 0.88rem;
    line-height: 1.55;
  }

  /* Generic table wrapper */
  .cl-table-wrap {
    margin: 0 0 8px;
  }
  .cl-table-caption {
    margin: 0 0 12px;
  }
  .cl-search-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin: 0 0 10px;
  }
  .cl-search {
    flex: 1;
    min-width: 220px;
    padding: 8px 14px;
    border: 1px solid var(--color-purple-100);
    border-radius: 999px;
    background: white;
    color: var(--color-ink);
    font-family: inherit;
    font-size: 0.92rem;
    box-shadow: var(--shadow-soft);
    transition: border-color 0.15s ease;
  }
  .cl-search:focus {
    outline: none;
    border-color: var(--color-pink-400);
  }
  .cl-count {
    font-size: 0.82rem;
    color: var(--color-ink-soft);
    font-weight: 600;
  }

  .cl-scroll {
    overflow-x: auto;
    border: 1px solid var(--color-pink-100);
    border-radius: 14px;
    background: white;
    box-shadow: var(--shadow-soft);
  }

  .cl-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
    min-width: 720px;
  }
  .cl-table thead {
    background: linear-gradient(180deg, var(--color-pink-50), white);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .cl-table th {
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--color-pink-100);
    font-family: var(--font-display);
    font-weight: 700;
    color: var(--color-purple-600);
    font-size: 0.82rem;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .cl-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--color-pink-50);
    vertical-align: top;
    line-height: 1.45;
  }
  .cl-table tbody tr:hover {
    background: var(--color-purple-50);
  }
  .cl-table tbody tr:last-child td {
    border-bottom: none;
  }

  /* Sticky first column on horizontal scroll (mobile-friendly) */
  .cl-table th:first-child,
  .cl-table td:first-child {
    position: sticky;
    left: 0;
    background: white;
    z-index: 1;
  }
  .cl-table thead th:first-child {
    background: linear-gradient(180deg, var(--color-pink-50), white);
  }
  .cl-table tbody tr:hover td:first-child {
    background: var(--color-purple-50);
  }

  .cl-sort-btn {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-align: left;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .cl-sort-btn:hover {
    color: var(--color-pink-600);
  }
  .cl-sort-btn.active {
    color: var(--color-pink-600);
  }
  .cl-sort-btn span {
    font-size: 0.7em;
    opacity: 0.6;
  }
  .cl-sort-btn.active span {
    opacity: 1;
  }

  .cl-empty {
    text-align: center;
    padding: 24px 12px;
    color: var(--color-ink-soft);
    font-style: italic;
  }

  /* "Show N more" pagination footer (kicks in for huge tables) */
  .cl-page-more {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 14px 0 4px;
  }
  .cl-more-btn {
    cursor: pointer;
    padding: 8px 16px;
    background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
    color: white;
    font-weight: 700;
    font-family: var(--font-display);
    font-size: 0.88rem;
    border: none;
    border-radius: 999px;
    box-shadow: 0 4px 12px rgba(155, 123, 217, 0.25);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .cl-more-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 16px rgba(155, 123, 217, 0.32);
  }
  .cl-more-hint {
    font-size: 0.84rem;
    color: var(--color-ink-soft);
  }

  /* Cell content variants */
  .cl-mono {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.82rem;
    color: var(--color-purple-600);
    background: var(--color-purple-50);
    padding: 1px 6px;
    border-radius: 5px;
    border: 1px solid var(--color-purple-100);
    word-break: break-all;
  }
  .cl-jp {
    font-family: 'Noto Sans JP', system-ui, sans-serif;
    color: var(--color-ink);
  }
  .cl-muted {
    color: var(--color-ink-soft);
    font-size: 0.85rem;
  }
  .cl-notes {
    color: var(--color-ink-soft);
    font-size: 0.85rem;
  }
  .cl-context {
    display: block;
    margin-top: 4px;
    padding: 2px 8px;
    background: var(--color-blue-50);
    border-radius: 6px;
    color: var(--color-blue-600);
    font-size: 0.78rem;
    font-weight: 600;
    width: fit-content;
  }

  .cl-cell-text {
    max-width: 360px;
  }
  .cl-cell-text pre {
    margin: 0;
    font-family: inherit;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cl-before pre {
    color: var(--color-ink-soft);
    text-decoration: line-through;
    text-decoration-color: var(--color-pink-200);
  }
  .cl-after pre {
    color: var(--color-ink);
    font-weight: 600;
  }
  .cl-before-inline {
    color: var(--color-ink-soft);
    text-decoration: line-through;
    text-decoration-color: var(--color-pink-200);
  }
  .cl-after-inline {
    color: var(--color-ink);
    font-weight: 600;
  }

  /* Other-changes list */
  .cl-other-list {
    display: grid;
    gap: 14px;
  }
  .cl-other-item {
    padding: 18px 22px;
    background: var(--surface-strong);
    border: 1px solid var(--color-pink-100);
    border-radius: 18px;
    box-shadow: var(--shadow-soft);
  }
  .cl-other-item h3 {
    margin: 0 0 8px;
    font-size: 1.02rem;
    color: var(--color-purple-600);
  }
  .cl-other-item p {
    margin: 0;
    line-height: 1.6;
    color: var(--color-ink);
  }

  /* Mobile: turn each row into a stacked card on very narrow screens */
  @media (max-width: 640px) {
    .cl-table {
      min-width: 560px;
    }
    .cl-cell-text {
      max-width: 240px;
    }
  }
`;
