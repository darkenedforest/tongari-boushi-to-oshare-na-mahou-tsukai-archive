import { useEffect, useMemo, useState } from 'react';

// ---------------------------------------------------------------------
// Types — mirror the shape written by
// src/translator/_export_overlay_knowledgebase.py
// ---------------------------------------------------------------------

interface ContainerRef {
  name: string;
  path: string | null;
  is_patched: boolean | null;
  note: string | null;
}

interface EmbeddedString {
  addr: string;
  value: string;
}

interface FunctionRow {
  index: number;
  addr: string;
  size: number;
  calls: number;
  strings: number;
  role_hint: string;
}

export interface Overlay {
  id: number;
  file_id: number | null;
  ram_load_addr: string;
  ram_size: number | null;
  ram_size_hex: string | null;
  bss_size: number | null;
  size_compressed: number | null;
  compression_flag: string;
  function_count: number;
  string_count: number;
  unpatched_container_count: number;
  unpatched_container_count_from_md?: number;
  external_call_count: number | null;
  data_count: number | null;
  jump_table_count: number | null;
  prior_pass_role: string | null;
  prior_pass_category: string | null;
  containers_referenced: ContainerRef[];
  embedded_jp_strings: EmbeddedString[];
  function_list: FunctionRow[];
  purpose_summary: string;
  translation_surface_summary: string;
  open_questions: string[];
  conflicts: string[];
}

interface Snapshot {
  generated_at: string;
  total: number;
  totals: {
    overlays: number;
    with_unpatched_containers: number;
    with_embedded_strings: number;
    pure_code: number;
    total_functions: number;
    total_unpatched_container_refs: number;
  };
  overlays: Overlay[];
}

interface Props {
  dataUrl: string;
  detailHrefBase: string; // e.g. "/tongari-boushi-.../field-guide/how-the-game-works/overlays/"
}

// ---------------------------------------------------------------------
// Filter UI state
// ---------------------------------------------------------------------

type SurfaceFilter = 'any' | 'has_containers' | 'embedded_strings' | 'pure_code';
type SortKey = 'id' | 'functions' | 'strings' | 'containers';

const PAGE_SIZE = 30;

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString();
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0');
}

export default function OverlaysBrowser({ dataUrl, detailHrefBase }: Props) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [surface, setSurface] = useState<SurfaceFilter>('any');
  const [minFns, setMinFns] = useState<string>(''); // string so empty stays empty
  const [sortKey, setSortKey] = useState<SortKey>('id');
  const [sortDesc, setSortDesc] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let aborted = false;
    fetch(dataUrl, { cache: 'no-cache' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: Snapshot) => {
        if (!aborted) setSnap(d);
      })
      .catch(e => {
        if (!aborted) setErr(String(e));
      });
    return () => {
      aborted = true;
    };
  }, [dataUrl]);

  const filtered = useMemo(() => {
    if (!snap) return [] as Overlay[];
    const needle = q.trim().toLowerCase();
    const minFnsNum = minFns === '' ? 0 : Math.max(0, Number(minFns) || 0);
    let rows = snap.overlays.filter(o => {
      if (surface === 'has_containers' && o.containers_referenced.length <= 0) return false;
      if (surface === 'embedded_strings' && o.string_count <= 0) return false;
      if (surface === 'pure_code') {
        if (o.containers_referenced.length > 0 || o.embedded_jp_strings.length > 0) return false;
      }
      if (o.function_count < minFnsNum) return false;
      if (needle) {
        // Search id, prior-pass role, purpose, and container names.
        const haystack = [
          `ov${pad3(o.id)}`,
          o.prior_pass_role || '',
          o.prior_pass_category || '',
          o.purpose_summary || '',
          o.translation_surface_summary || '',
          ...o.containers_referenced.map(c => c.name),
          ...o.containers_referenced.map(c => c.path || ''),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    rows = rows.slice().sort((a, b) => {
      const av =
        sortKey === 'id'
          ? a.id
          : sortKey === 'functions'
          ? a.function_count
          : sortKey === 'strings'
          ? a.string_count
          : a.containers_referenced.length;
      const bv =
        sortKey === 'id'
          ? b.id
          : sortKey === 'functions'
          ? b.function_count
          : sortKey === 'strings'
          ? b.string_count
          : b.containers_referenced.length;
      const cmp = av - bv;
      return sortDesc ? -cmp : cmp;
    });
    return rows;
  }, [snap, q, surface, minFns, sortKey, sortDesc]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [q, surface, minFns, sortKey, sortDesc]);

  if (err) {
    return (
      <div className="ov-error">
        Failed to load overlay snapshot: <code>{err}</code>
      </div>
    );
  }
  if (!snap) {
    return <div className="ov-loading">Loading overlay knowledgebase…</div>;
  }

  const total = filtered.length;
  const pageStart = page * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, total);
  const pageRows = filtered.slice(pageStart, pageEnd);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function setSort(k: SortKey) {
    if (sortKey === k) setSortDesc(d => !d);
    else {
      setSortKey(k);
      setSortDesc(k !== 'id'); // default to descending for count columns
    }
  }

  function arrow(k: SortKey) {
    if (sortKey !== k) return '';
    return sortDesc ? ' ▼' : ' ▲';
  }

  return (
    <div className="ov-browser">
      <div className="ov-filters">
        <label className="ov-search">
          <span className="ov-search-label">Search</span>
          <input
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="ov016, hair_catalog, dispatcher, 2d_ui…"
          />
        </label>

        <label className="ov-pick">
          <span>Contents</span>
          <select value={surface} onChange={e => setSurface(e.target.value as SurfaceFilter)}>
            <option value="any">Any</option>
            <option value="has_containers">References container files</option>
            <option value="embedded_strings">Has embedded JP strings</option>
            <option value="pure_code">Pure code (no strings, no containers)</option>
          </select>
        </label>

        <label className="ov-pick ov-pick-num">
          <span>Min functions</span>
          <input
            type="number"
            min={0}
            value={minFns}
            onChange={e => setMinFns(e.target.value)}
            placeholder="0"
          />
        </label>
      </div>

      <p className="ov-summary">
        Showing <strong>{total.toLocaleString()}</strong> of {snap.total.toLocaleString()} overlays
        {q || surface !== 'any' || minFns ? ' (filtered)' : ''}.
      </p>

      <div className="ov-table-wrap">
        <table className="ov-table">
          <thead>
            <tr>
              <th className="ov-th ov-th-sort" onClick={() => setSort('id')}>
                Overlay{arrow('id')}
              </th>
              <th>Purpose</th>
              <th className="ov-th-num ov-th-sort" onClick={() => setSort('functions')}>
                Fns{arrow('functions')}
              </th>
              <th className="ov-th-num ov-th-sort" onClick={() => setSort('strings')}>
                JP strings{arrow('strings')}
              </th>
              <th className="ov-th-num ov-th-sort" onClick={() => setSort('containers')}>
                Containers{arrow('containers')}
              </th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map(o => {
              const href = `${detailHrefBase}${o.id}/`;
              const containerCount = o.containers_referenced.length;
              const hasContents = containerCount > 0 || o.string_count > 0;
              return (
                <tr key={o.id} className={hasContents ? 'ov-row ov-row-active' : 'ov-row'}>
                  <td className="ov-cell-id">
                    <a href={href}>ov{pad3(o.id)}</a>
                  </td>
                  <td className="ov-cell-purpose">
                    <span className="ov-purpose">{o.purpose_summary || '—'}</span>
                    {o.prior_pass_role && (
                      <span className="ov-role-pill">{o.prior_pass_role}</span>
                    )}
                  </td>
                  <td className="ov-cell-num">{fmt(o.function_count)}</td>
                  <td className="ov-cell-num">
                    {o.string_count > 0 ? (
                      <span className="ov-pill ov-pill-strings">{o.string_count}</span>
                    ) : (
                      <span className="ov-pill-dim">0</span>
                    )}
                  </td>
                  <td className="ov-cell-num">
                    {containerCount > 0 ? (
                      <span className="ov-pill ov-pill-containers">
                        {containerCount}
                      </span>
                    ) : (
                      <span className="ov-pill-dim">0</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={5} className="ov-empty">
                  Nothing matches those filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="ov-pager">
          <button onClick={() => setPage(0)} disabled={page === 0}>
            « First
          </button>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
            ‹ Prev
          </button>
          <span className="ov-page-info">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next ›
          </button>
          <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}>
            Last »
          </button>
        </div>
      )}

      <style>{`
        .ov-browser { margin: 16px 0 40px; }
        .ov-loading, .ov-error {
          padding: 24px;
          background: var(--surface-strong, white);
          border-radius: 12px;
          border: 1px solid var(--color-pink-100, #f8c8dc);
          color: var(--color-ink-soft, #5a4470);
        }
        .ov-error { color: #8b1d3a; border-color: #ffc7d7; }
        .ov-filters {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          align-items: flex-end;
          background: var(--surface-strong, white);
          border: 1px solid var(--color-pink-100, #f8c8dc);
          border-radius: 14px;
          padding: 14px 16px;
          box-shadow: var(--shadow-soft, 0 4px 14px rgba(155,123,217,0.10));
        }
        .ov-filters label {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 0.82rem;
          font-weight: 600;
          color: var(--color-purple-600, #6f3fa3);
        }
        .ov-search { flex: 1 1 260px; min-width: 220px; }
        .ov-search input, .ov-pick select, .ov-pick input {
          padding: 8px 12px;
          border-radius: 10px;
          border: 1px solid var(--color-pink-100, #f8c8dc);
          font: inherit;
          color: var(--color-ink, #3a2350);
          background: white;
        }
        .ov-search input:focus, .ov-pick select:focus, .ov-pick input:focus {
          outline: 2px solid var(--color-purple-400, #b58cd9);
          outline-offset: 1px;
        }
        .ov-pick-num input { width: 110px; }
        .ov-summary {
          margin: 14px 2px 8px;
          color: var(--color-ink-soft, #5a4470);
          font-size: 0.9rem;
        }
        .ov-summary strong { color: var(--color-purple-600, #6f3fa3); }
        .ov-table-wrap {
          background: var(--surface-strong, white);
          border: 1px solid var(--color-pink-100, #f8c8dc);
          border-radius: 14px;
          overflow: hidden;
          box-shadow: var(--shadow-soft, 0 4px 14px rgba(155,123,217,0.10));
          overflow-x: auto;
        }
        .ov-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.92rem;
        }
        .ov-table thead {
          background: linear-gradient(
            135deg,
            var(--color-pink-100, #ffe2ec),
            var(--color-purple-100, #e8dcff)
          );
        }
        .ov-table th, .ov-table td {
          padding: 10px 14px;
          text-align: left;
          border-bottom: 1px solid var(--color-pink-100, #f8c8dc);
        }
        .ov-th-num { text-align: right; }
        .ov-cell-num { text-align: right; }
        .ov-th-sort { cursor: pointer; user-select: none; }
        .ov-th-sort:hover { color: var(--color-pink-600, #d63384); }
        .ov-row-active { background: rgba(255, 240, 246, 0.4); }
        .ov-row:hover { background: rgba(232, 220, 255, 0.45); }
        .ov-cell-id a {
          font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
          font-weight: 700;
          color: var(--color-pink-600, #d63384);
          text-decoration: none;
          border-bottom: 1px dashed rgba(233, 63, 142, 0.35);
        }
        .ov-cell-id a:hover { color: var(--color-purple-600, #6f3fa3); }
        .ov-cell-purpose { color: var(--color-ink, #3a2350); max-width: 560px; }
        .ov-purpose { display: inline-block; }
        .ov-role-pill {
          display: inline-block;
          margin-left: 8px;
          padding: 1px 8px;
          font-size: 0.72rem;
          font-weight: 700;
          color: var(--color-purple-600, #6f3fa3);
          background: rgba(232, 220, 255, 0.55);
          border-radius: 999px;
        }
        .ov-pill {
          display: inline-block;
          padding: 2px 9px;
          border-radius: 999px;
          font-weight: 700;
          font-size: 0.85rem;
        }
        .ov-pill-strings { background: #fff0d6; color: #8a5300; }
        .ov-pill-containers { background: #e8dcff; color: #5a3d8a; }
        .ov-pill-dim { color: var(--color-ink-soft, #9a87b8); }
        .ov-empty { text-align: center; padding: 30px; color: var(--color-ink-soft, #5a4470); }

        .ov-pager {
          margin-top: 14px;
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
          justify-content: center;
        }
        .ov-pager button {
          padding: 6px 12px;
          border-radius: 10px;
          border: 1px solid var(--color-pink-100, #f8c8dc);
          background: var(--surface-strong, white);
          color: var(--color-purple-600, #6f3fa3);
          font: inherit;
          font-weight: 600;
          cursor: pointer;
        }
        .ov-pager button:hover:not(:disabled) {
          background: var(--color-purple-100, #e8dcff);
        }
        .ov-pager button:disabled { opacity: 0.4; cursor: default; }
        .ov-page-info { color: var(--color-ink-soft, #5a4470); font-size: 0.88rem; }

        @media (max-width: 640px) {
          .ov-table th:nth-child(2), .ov-table td:nth-child(2) { display: none; }
        }
      `}</style>
    </div>
  );
}
