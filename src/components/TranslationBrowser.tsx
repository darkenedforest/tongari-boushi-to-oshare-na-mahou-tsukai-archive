import { useEffect, useMemo, useRef, useState } from 'react';
import MiniSearch from 'minisearch';
import { supabase, supabaseConfigured } from '../lib/supabase';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

type Kind = 'dialog' | 'item' | 'npc';

interface Row {
  kind: Kind;
  ref: string;
  en: string;
  max_chars: number | null;
}

interface Snapshot {
  generated_at: string;
  source_db_mtime: string;
  counts: { dialog: number; items: number; npcs: number };
  rows: Row[];
}

interface Props {
  // URL the React island fetches the rows snapshot from on mount.  Passed
  // in from the Astro page so the base path (e.g. GitHub Pages subpath) is
  // resolved at build time.
  dataUrl: string;
}

type Filter = 'all' | Kind;

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const PAGE_SIZE = 50;
const MAX_REASON = 500;
const MAX_AUTHOR = 40;
const DEBOUNCE_MS = 180;
// Each row needs a stable, MiniSearch-safe numeric id. We just use the
// row's index in the snapshot array.
type IndexedRow = Row & { _id: number };

const KIND_LABEL: Record<Kind, string> = {
  dialog: 'Dialog',
  item: 'Item',
  npc: 'NPC',
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// MiniSearch tokenizer that doesn't choke on the in-game tag syntax
// (e.g. "[NPC:1009]", "▼", "§"). We strip ASCII punctuation that would
// otherwise split tokens we don't care about and lowercase. We keep
// alphanumerics and a few useful chars.
function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[\[\]\{\}\(\)<>!?.,:;"“”'’/\\|`~@#$%^&*+=]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function KindBadge({ kind }: { kind: Kind }) {
  return <span className={`kind-badge kind-${kind}`}>{KIND_LABEL[kind]}</span>;
}

function MaxBadge({ max }: { max: number | null }) {
  if (max == null) return null;
  return <span className="max-badge">Max {max} chars</span>;
}

// ---------------------------------------------------------------------
// Edit form (inline, expandable)
// ---------------------------------------------------------------------

function EditForm({
  row,
  onClose,
  disabled,
  disabledReason,
}: {
  row: Row;
  onClose: () => void;
  disabled: boolean;
  disabledReason: string;
}) {
  const [proposed, setProposed] = useState(row.en);
  const [reason, setReason] = useState('');
  const [submitter, setSubmitter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!proposed.trim()) {
      setErr('Suggestion is required.');
      return;
    }
    if (proposed.trim() === row.en.trim()) {
      setErr("Suggestion is identical to the current text.");
      return;
    }
    if (disabled || !supabaseConfigured || !supabase) {
      setErr(disabledReason || "Backend isn't configured.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        kind: row.kind,
        ref: row.ref,
        original_en: row.en,
        proposed_en: proposed.trim(),
        reason: reason.trim() ? reason.trim().slice(0, MAX_REASON) : null,
        submitter: submitter.trim() ? submitter.trim().slice(0, MAX_AUTHOR) : null,
      };
      const { error } = await supabase.from('edit_suggestions').insert(payload);
      if (error) throw error;
      // Reset the editable fields. Keep the form open so the user can keep
      // refining (per spec). Don't update the displayed `row.en` — the
      // suggestion isn't accepted yet, so showing the unchanged original
      // is the honest state.
      setProposed(row.en);
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

  const proposedLen = [...proposed].length;
  const over = row.max_chars != null && proposedLen > row.max_chars;

  return (
    <form className="edit-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">
          Suggested EN
          <span className={`char-count ${over ? 'over' : ''}`}>
            {proposedLen}
            {row.max_chars != null && <> / {row.max_chars}</>} chars
          </span>
        </span>
        <textarea
          value={proposed}
          onChange={e => setProposed(e.target.value)}
          rows={Math.min(8, Math.max(2, Math.ceil(proposed.length / 64)))}
          maxLength={4000}
          disabled={busy}
        />
        {over && (
          <span className="warn">
            This exceeds the in-game budget of {row.max_chars} chars — it may not fit.
          </span>
        )}
      </label>
      <label className="field">
        <span className="field-label">Why this change? (optional)</span>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={2}
          maxLength={MAX_REASON}
          placeholder="Typo, awkward phrasing, official localization, etc."
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">Your name (optional)</span>
        <input
          type="text"
          value={submitter}
          onChange={e => setSubmitter(e.target.value)}
          maxLength={MAX_AUTHOR}
          placeholder="Anonymous"
          disabled={busy}
        />
      </label>
      {err && <div className="form-error">{err}</div>}
      {flash && (
        <div className="form-posted">
          ✓ Submitted — thanks! You can edit the suggestion above and submit again, or close.
        </div>
      )}
      <div className="edit-form-actions">
        <button
          type="button"
          className="cancel-btn small"
          onClick={onClose}
          disabled={busy}
        >
          Close
        </button>
        <button
          type="submit"
          className="submit-btn small"
          disabled={busy || disabled}
          title={disabled ? disabledReason : undefined}
        >
          {busy ? 'Submitting…' : 'Submit suggestion'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------
// Result row
// ---------------------------------------------------------------------

function ResultRow({
  row,
  expanded,
  onToggle,
  submitDisabled,
  submitDisabledReason,
}: {
  row: Row;
  expanded: boolean;
  onToggle: () => void;
  submitDisabled: boolean;
  submitDisabledReason: string;
}) {
  return (
    <li
      className={`tr-row ${expanded ? 'is-expanded' : ''}`}
      data-kind={row.kind}
      data-ref={row.ref}
    >
      <div className="tr-row-head">
        <div className="tr-row-en">{row.en}</div>
        <div className="tr-row-badges">
          <KindBadge kind={row.kind} />
          <MaxBadge max={row.max_chars} />
          <button
            type="button"
            className="edit-btn"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            {expanded ? 'Cancel' : 'Edit'}
          </button>
        </div>
      </div>
      {expanded && (
        <EditForm
          row={row}
          onClose={onToggle}
          disabled={submitDisabled}
          disabledReason={submitDisabledReason}
        />
      )}
    </li>
  );
}

// ---------------------------------------------------------------------
// Outer component: handles fetch-on-mount + loading / error UI.  The
// inner `Browser` component owns all the search / pagination / submission
// logic and only renders once the snapshot has arrived.
// ---------------------------------------------------------------------

export default function TranslationBrowser({ dataUrl }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(dataUrl)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching translation snapshot`);
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        setSnapshot(data as Snapshot);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err?.message || String(err));
      });
    return () => { cancelled = true; };
  }, [dataUrl]);

  if (error) {
    return (
      <div className="tr-browser">
        <div className="banner banner-warn">
          <strong>Couldn't load the translation snapshot.</strong>
          {' '}{error}{' '}
          Try refreshing the page; if it keeps failing, the data file may be missing from the server.
        </div>
        <style>{`
          .tr-browser { display: flex; flex-direction: column; gap: 16px; }
          .banner { padding: 12px 16px; border-radius: var(--radius-md); font-size: 0.92rem; line-height: 1.5; }
          .banner-warn { background: #fff1c4; color: #6b4d00; border: 1px solid #f0d68d; }
        `}</style>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="tr-browser tr-loading-state">
        <div className="tr-loading-card">
          <div className="tr-loading-spinner" aria-hidden="true" />
          <p>
            Loading translations…
            <br />
            <span className="tr-loading-note">
              The snapshot is around 3.5 MB compressed and downloads once per visit.
            </span>
          </p>
        </div>
        <style>{`
          .tr-loading-state {
            display: flex; justify-content: center; padding: 60px 20px;
          }
          .tr-loading-card {
            display: flex; flex-direction: column; align-items: center; gap: 14px;
            color: var(--color-ink-soft);
            text-align: center;
            background: var(--surface-strong);
            border: 1px solid var(--color-pink-100);
            border-radius: var(--radius-lg);
            padding: 32px 40px;
            box-shadow: var(--shadow-soft);
          }
          .tr-loading-card p { margin: 0; line-height: 1.6; color: var(--color-ink); }
          .tr-loading-note {
            font-size: 0.84rem; color: var(--color-ink-soft);
          }
          .tr-loading-spinner {
            width: 32px; height: 32px; border-radius: 50%;
            border: 3px solid var(--color-pink-100);
            border-top-color: var(--color-pink-400);
            animation: tr-spin 0.9s linear infinite;
          }
          @keyframes tr-spin { to { transform: rotate(360deg); } }
        `}</style>
      </div>
    );
  }

  return <Browser snapshot={snapshot} />;
}

// ---------------------------------------------------------------------
// Inner component — original implementation, runs once data has loaded.
// ---------------------------------------------------------------------

function Browser({ snapshot }: { snapshot: Snapshot }) {
  // Flatten + assign stable internal numeric ids for MiniSearch.
  const allRows = useMemo<IndexedRow[]>(
    () => snapshot.rows.map((r, i) => ({ ...r, _id: i })),
    [snapshot.rows]
  );

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null); // ref of expanded row

  // Debounce the query so we don't re-search on every keystroke for 86k
  // rows. 180ms is a reasonable balance.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  // Reset to page 0 whenever the query or filter changes.
  useEffect(() => {
    setPage(0);
    setExpanded(null);
  }, [debouncedQuery, filter]);

  // Build the MiniSearch index once on mount. With ~86k short rows this
  // is fast (~1s) but still worth keeping out of render.
  const index = useMemo(() => {
    const idx = new MiniSearch<IndexedRow>({
      fields: ['en'],
      storeFields: [],
      idField: '_id',
      tokenize,
      searchOptions: {
        prefix: true,
        fuzzy: 0.15,
        combineWith: 'AND',
      },
    });
    idx.addAll(allRows);
    return idx;
  }, [allRows]);

  // Apply search + filter. When no query, just slice the filtered set.
  const results = useMemo<IndexedRow[]>(() => {
    const q = debouncedQuery.trim();
    let pool: IndexedRow[];
    if (q.length === 0) {
      pool = allRows;
    } else {
      const hits = index.search(q);
      // Map hits back to rows by id, preserving relevance order.
      pool = hits
        .map(h => allRows[h.id as number])
        .filter(Boolean) as IndexedRow[];
    }
    if (filter !== 'all') {
      pool = pool.filter(r => r.kind === filter);
    }
    return pool;
  }, [debouncedQuery, filter, allRows, index]);

  const visible = results.slice(0, (page + 1) * PAGE_SIZE);
  const hasMore = visible.length < results.length;

  const submitDisabled = !supabaseConfigured;
  const submitDisabledReason = supabaseConfigured
    ? ''
    : "Submissions are temporarily disabled — the site owner hasn't connected the suggestions backend yet.";

  const searchRef = useRef<HTMLInputElement>(null);

  const counts = snapshot.counts;
  const totalCount = counts.dialog + counts.items + counts.npcs;

  return (
    <div className="tr-browser">
      {!supabaseConfigured && (
        <div className="banner banner-warn">
          <strong>Suggestions are disabled.</strong> The site owner hasn't
          connected the submissions backend yet — you can still browse and
          search, but the Submit button won't work.
        </div>
      )}

      <div className="tr-controls">
        <div className="tr-search">
          <input
            ref={searchRef}
            type="search"
            className="tr-search-input"
            placeholder="Search English text…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
          {query && (
            <button
              type="button"
              className="tr-clear"
              onClick={() => { setQuery(''); searchRef.current?.focus(); }}
              aria-label="Clear search"
            >×</button>
          )}
        </div>

        <div className="tr-pills">
          <button
            className={`tr-pill ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All <span className="tr-pill-count">{totalCount.toLocaleString()}</span>
          </button>
          <button
            className={`tr-pill ${filter === 'dialog' ? 'active' : ''}`}
            onClick={() => setFilter('dialog')}
          >
            Dialog <span className="tr-pill-count">{counts.dialog.toLocaleString()}</span>
          </button>
          <button
            className={`tr-pill ${filter === 'item' ? 'active' : ''}`}
            onClick={() => setFilter('item')}
          >
            Items <span className="tr-pill-count">{counts.items.toLocaleString()}</span>
          </button>
          <button
            className={`tr-pill ${filter === 'npc' ? 'active' : ''}`}
            onClick={() => setFilter('npc')}
          >
            NPCs <span className="tr-pill-count">{counts.npcs.toLocaleString()}</span>
          </button>
        </div>
      </div>

      <div className="tr-status">
        Showing <strong>{visible.length.toLocaleString()}</strong> of{' '}
        <strong>{results.length.toLocaleString()}</strong> matching entries
        {debouncedQuery && (
          <> for <em>"{debouncedQuery}"</em></>
        )}
        .
      </div>

      {results.length === 0 ? (
        <div className="tr-empty">
          <p>No entries matched your search. Try a shorter or differently spelled term.</p>
        </div>
      ) : (
        <>
          <ul className="tr-list">
            {visible.map(r => (
              <ResultRow
                key={r.ref}
                row={r}
                expanded={expanded === r.ref}
                onToggle={() =>
                  setExpanded(prev => (prev === r.ref ? null : r.ref))
                }
                submitDisabled={submitDisabled}
                submitDisabledReason={submitDisabledReason}
              />
            ))}
          </ul>
          {hasMore && (
            <div className="tr-more">
              <button
                className="tr-more-btn"
                onClick={() => setPage(p => p + 1)}
              >
                Show more ({(results.length - visible.length).toLocaleString()} remaining)
              </button>
            </div>
          )}
        </>
      )}

      <style>{`
        .tr-browser { display: flex; flex-direction: column; gap: 16px; }

        .banner {
          padding: 12px 16px; border-radius: var(--radius-md);
          font-size: 0.92rem; line-height: 1.5;
        }
        .banner-warn {
          background: #fff1c4; color: #6b4d00;
          border: 1px solid #f0d68d;
        }

        .tr-controls {
          display: flex; flex-direction: column; gap: 12px;
          padding: 16px 18px;
          background: linear-gradient(135deg, var(--color-pink-50), var(--color-purple-50));
          border-radius: var(--radius-lg); border: 1px solid var(--color-pink-100);
        }
        .tr-search { position: relative; }
        .tr-search-input {
          width: 100%; padding: 12px 40px 12px 16px;
          border-radius: var(--radius-pill);
          border: 1px solid var(--color-purple-100);
          background: white; color: var(--color-ink);
          font: inherit; font-size: 1rem;
        }
        .tr-search-input:focus {
          outline: 2px solid var(--color-pink-200);
        }
        .tr-clear {
          position: absolute; top: 50%; right: 10px; transform: translateY(-50%);
          width: 26px; height: 26px; border-radius: 50%;
          background: var(--color-pink-100); color: var(--color-pink-600);
          border: none; cursor: pointer; font-size: 1rem; line-height: 1;
        }
        .tr-clear:hover { background: var(--color-pink-200); }

        .tr-pills { display: flex; gap: 6px; flex-wrap: wrap; }
        .tr-pill {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 7px 14px; border-radius: var(--radius-pill);
          background: white; color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100);
          font-weight: 600; font-size: 0.85rem; cursor: pointer; font-family: inherit;
        }
        .tr-pill:hover { background: var(--color-purple-100); }
        .tr-pill.active {
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; border-color: transparent;
        }
        .tr-pill-count {
          background: rgba(255, 255, 255, 0.45);
          color: inherit;
          padding: 1px 8px; border-radius: 999px;
          font-size: 0.74rem; font-weight: 700;
        }
        .tr-pill:not(.active) .tr-pill-count {
          background: var(--color-purple-50);
          color: var(--color-purple-400);
        }

        .tr-status {
          color: var(--color-ink-soft); font-size: 0.88rem;
          padding: 0 4px;
        }
        .tr-status em { color: var(--color-pink-600); font-style: normal; }

        .tr-empty {
          padding: 60px 20px; text-align: center;
          color: var(--color-ink-soft);
          background: var(--surface-strong); border-radius: var(--radius-lg);
          border: 1px solid var(--color-pink-100);
        }

        .tr-list {
          list-style: none; margin: 0; padding: 0;
          display: flex; flex-direction: column; gap: 8px;
        }
        .tr-row {
          background: var(--surface-strong);
          border: 1px solid var(--color-pink-100);
          border-radius: var(--radius-md);
          padding: 12px 16px;
          transition: border-color 0.12s ease, box-shadow 0.12s ease;
        }
        .tr-row:hover { border-color: var(--color-pink-200); }
        .tr-row.is-expanded {
          border-color: var(--color-purple-400);
          box-shadow: var(--shadow-soft);
        }
        .tr-row-head {
          display: flex; align-items: flex-start; gap: 12px;
        }
        .tr-row-en {
          flex: 1; color: var(--color-ink);
          font-size: 0.96rem; line-height: 1.5;
          word-break: break-word;
          white-space: pre-wrap;
        }
        .tr-row-badges {
          display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
          flex-shrink: 0;
        }
        .kind-badge {
          padding: 3px 10px; border-radius: var(--radius-pill);
          font-size: 0.72rem; font-weight: 700;
          letter-spacing: 0.02em;
        }
        .kind-dialog { background: var(--color-purple-100); color: var(--color-purple-600); }
        .kind-item   { background: #d9f3df;                  color: #2c8a4a; }
        .kind-npc    { background: var(--color-pink-100);    color: var(--color-pink-600); }
        .max-badge {
          padding: 3px 10px; border-radius: var(--radius-pill);
          background: #fff1c4; color: #6b4d00;
          font-size: 0.72rem; font-weight: 700;
        }
        .edit-btn {
          padding: 4px 12px; border-radius: var(--radius-pill);
          background: white; color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100);
          font-size: 0.78rem; font-weight: 600; cursor: pointer; font-family: inherit;
        }
        .edit-btn:hover { background: var(--color-purple-100); }
        .tr-row.is-expanded .edit-btn {
          background: var(--color-pink-100); color: var(--color-pink-600);
          border-color: var(--color-pink-200);
        }

        .edit-form {
          margin-top: 12px; padding-top: 12px;
          border-top: 1px dashed var(--color-pink-100);
          display: flex; flex-direction: column; gap: 10px;
        }
        .field { display: flex; flex-direction: column; gap: 4px; }
        .field-label {
          display: flex; align-items: center; justify-content: space-between;
          gap: 8px; font-weight: 600; color: var(--color-purple-600);
          font-size: 0.82rem;
        }
        .char-count {
          font-weight: 600; color: var(--color-ink-soft);
          font-size: 0.78rem;
        }
        .char-count.over { color: var(--color-pink-600); }
        .field input, .field textarea {
          padding: 8px 12px; border-radius: var(--radius-md);
          border: 1px solid var(--color-purple-100); background: white;
          font: inherit; resize: vertical; color: var(--color-ink);
        }
        .field input:focus, .field textarea:focus {
          outline: 2px solid var(--color-pink-200);
        }
        .warn { color: #b07f00; font-size: 0.82rem; }
        .form-error {
          color: var(--color-pink-600); font-size: 0.85rem;
          background: var(--color-pink-100); padding: 6px 10px;
          border-radius: var(--radius-md);
        }
        .form-posted {
          color: #2c8a4a; background: #d9f3df;
          padding: 6px 10px; border-radius: var(--radius-md);
          font-size: 0.85rem; font-weight: 600;
        }

        .edit-form-actions {
          display: flex; gap: 6px; justify-content: flex-end;
        }
        .cancel-btn.small {
          padding: 5px 12px; border-radius: var(--radius-pill);
          background: white; color: var(--color-ink-soft);
          border: 1px solid var(--color-purple-100);
          font-weight: 600; font-size: 0.82rem;
          cursor: pointer; font-family: inherit;
        }
        .submit-btn.small {
          padding: 5px 14px; border-radius: var(--radius-pill);
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; border: none;
          font-weight: 700; font-size: 0.82rem;
          cursor: pointer; font-family: inherit;
        }
        .submit-btn.small:disabled {
          opacity: 0.5; cursor: not-allowed;
        }

        .tr-more { text-align: center; padding: 12px 0; }
        .tr-more-btn {
          padding: 9px 22px; border-radius: var(--radius-pill);
          background: white; color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100);
          font-weight: 600; font-family: inherit; cursor: pointer;
        }
        .tr-more-btn:hover { background: var(--color-purple-50); }

        @media (max-width: 640px) {
          .tr-row-head { flex-direction: column; }
          .tr-row-badges { width: 100%; justify-content: flex-end; }
        }
      `}</style>
    </div>
  );
}
