import { useEffect, useMemo, useState } from 'react';

/** Generic record shape — pages pass `fields` to tell the component
 *  which keys to use for the image, label, and search haystack. */
export interface LazyImageGridRecord {
  [key: string]: any;
}

interface Props {
  /** URL of the manifest JSON (array of records). */
  manifestUrl: string;
  /** URL prefix prepended to record.fileField — e.g. "/scenes/npc-scenes". */
  imagePrefix: string;
  /** Key on the record holding the relative image filename. */
  fileField: string;
  /** Key (or list of keys) used to build the visible label per card. */
  labelFields: string[];
  /** Keys searched when the user types in the search box. */
  searchFields?: string[];
  /** Optional secondary line per card (e.g. JP name, container path). */
  subField?: string;
  /** Page size (cards per "page"). */
  pageSize?: number;
  /** Aspect ratio for card image wrapper (width / height). */
  imageAspect?: string;
}

export default function LazyImageGrid({
  manifestUrl,
  imagePrefix,
  fileField,
  labelFields,
  searchFields,
  subField,
  pageSize = 60,
  imageAspect,
}: Props) {
  const [records, setRecords] = useState<LazyImageGridRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(pageSize);

  useEffect(() => {
    // Cache-bust so we don't serve stale manifest from a previous deploy.
    fetch(`${manifestUrl}?cb=${Date.now()}`)
      .then(r => {
        if (!r.ok) throw new Error(`Manifest fetch failed: ${r.status}`);
        return r.json();
      })
      .then(data => {
        setRecords(data);
        setLoading(false);
      })
      .catch(e => {
        setErr(String(e));
        setLoading(false);
      });
  }, [manifestUrl]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return records;
    const fields = searchFields ?? labelFields;
    return records.filter(r =>
      fields.some(f => String(r[f] ?? '').toLowerCase().includes(q))
    );
  }, [records, query, labelFields, searchFields]);

  useEffect(() => { setVisible(pageSize); }, [query, pageSize]);

  const buildLabel = (r: LazyImageGridRecord) =>
    labelFields.map(f => r[f]).filter(v => v !== undefined && v !== null && v !== '').join(' · ');

  if (loading) return <div className="lazy-grid-status">Loading manifest…</div>;
  if (err)     return <div className="lazy-grid-status error">Couldn't load manifest. ({err})</div>;

  const shown = filtered.slice(0, visible);
  const remaining = Math.max(0, filtered.length - visible);

  return (
    <div className="lazy-grid-root">
      <div className="lazy-grid-controls">
        <input
          className="lazy-grid-search"
          type="search"
          placeholder="Search…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <span className="lazy-grid-count">
          Showing <strong>{shown.length}</strong> of <strong>{filtered.length}</strong>
          {filtered.length !== records.length && (
            <> (filtered from {records.length})</>
          )}
        </span>
      </div>

      <div className="lazy-grid">
        {shown.map((r, i) => (
          <figure key={String(r[fileField]) + i} className="lazy-grid-card">
            <div
              className="lazy-grid-imgwrap"
              style={imageAspect ? { aspectRatio: imageAspect } : undefined}
            >
              <img
                src={`${imagePrefix}/${r[fileField]}`}
                alt={buildLabel(r) || String(r[fileField])}
                loading="lazy"
              />
            </div>
            <figcaption>
              <strong>{buildLabel(r) || r[fileField]}</strong>
              {subField && r[subField] && (
                <span className="lazy-grid-sub">{String(r[subField])}</span>
              )}
            </figcaption>
          </figure>
        ))}
      </div>

      {remaining > 0 && (
        <div className="lazy-grid-more">
          <button
            type="button"
            className="lazy-grid-morebtn"
            onClick={() => setVisible(v => v + pageSize)}
          >
            Show {Math.min(pageSize, remaining)} more
          </button>
        </div>
      )}

      <style>{`
        .lazy-grid-root { padding: 0 0 60px; }
        .lazy-grid-controls {
          display: flex;
          gap: 14px;
          align-items: center;
          flex-wrap: wrap;
          margin: 8px 0 18px;
        }
        .lazy-grid-search {
          flex: 1 1 240px;
          min-width: 180px;
          padding: 10px 16px;
          border-radius: 999px;
          border: 1px solid var(--color-purple-100);
          background: white;
          color: var(--color-ink);
          font-family: inherit;
          font-size: 0.95rem;
          box-shadow: var(--shadow-soft);
        }
        .lazy-grid-search:focus {
          outline: none;
          border-color: var(--color-purple-200);
          box-shadow: 0 0 0 3px rgba(155, 123, 217, 0.15);
        }
        .lazy-grid-count {
          color: var(--color-ink-soft);
          font-size: 0.88rem;
        }
        .lazy-grid-count strong { color: var(--color-purple-600); }

        .lazy-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 16px;
        }

        .lazy-grid-card {
          margin: 0;
          background: var(--surface-strong);
          border-radius: 18px;
          box-shadow: var(--shadow-soft);
          border: 1px solid var(--color-pink-100);
          overflow: hidden;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .lazy-grid-card:hover {
          transform: translateY(-3px);
          box-shadow: var(--shadow-pop);
        }

        .lazy-grid-imgwrap {
          background: #1a1330;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .lazy-grid-imgwrap img {
          width: 100%;
          height: auto;
          display: block;
          image-rendering: -webkit-optimize-contrast;
        }

        .lazy-grid-card figcaption {
          padding: 10px 14px 12px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .lazy-grid-card figcaption strong {
          color: var(--color-purple-600);
          font-size: 0.9rem;
          line-height: 1.3;
        }
        .lazy-grid-sub {
          color: var(--color-ink-soft);
          font-size: 0.78rem;
          font-family: ui-monospace, monospace;
        }

        .lazy-grid-more {
          display: flex;
          justify-content: center;
          padding: 26px 0 0;
        }
        .lazy-grid-morebtn {
          padding: 12px 28px;
          border-radius: 999px;
          border: none;
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white;
          font-family: inherit;
          font-weight: 700;
          cursor: pointer;
          box-shadow: var(--shadow-pop);
        }
        .lazy-grid-morebtn:hover { transform: translateY(-2px); }

        .lazy-grid-status {
          padding: 32px;
          text-align: center;
          color: var(--color-ink-soft);
        }
        .lazy-grid-status.error { color: #b03030; }
      `}</style>
    </div>
  );
}
