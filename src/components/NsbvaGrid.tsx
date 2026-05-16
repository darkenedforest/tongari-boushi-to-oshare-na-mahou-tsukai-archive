import { useEffect, useMemo, useState } from 'react';

interface NsbvaRecord {
  container: string;
  entry_idx: number;
  sub_label: string;
  frame_count?: number;
  visible_frames?: number;
  apng: string;
  strip: string;
}

interface Props {
  manifestUrl: string;
  imagePrefix: string;
}

const PAGE_SIZE = 36;

export default function NsbvaGrid({ manifestUrl, imagePrefix }: Props) {
  const [records, setRecords] = useState<NsbvaRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [container, setContainer] = useState<string>('all');
  const [visible, setVisible] = useState(PAGE_SIZE);

  useEffect(() => {
    fetch(`${manifestUrl}?cb=${Date.now()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setRecords)
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [manifestUrl]);

  const containers = useMemo(() => {
    // Strip "extracted/nds/data/model/" prefix and ".ofs" suffix for display.
    const set = new Set<string>();
    records.forEach(r => set.add(shortContainer(r.container)));
    return ['all', ...Array.from(set).sort()];
  }, [records]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter(r => {
      if (container !== 'all' && shortContainer(r.container) !== container) return false;
      if (q) {
        const hay = `${r.container} ${r.entry_idx} ${r.sub_label}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [records, query, container]);

  useEffect(() => { setVisible(PAGE_SIZE); }, [query, container]);

  if (loading) return <div className="nsbva-status">Loading manifest…</div>;
  if (err)     return <div className="nsbva-status error">Couldn't load manifest. ({err})</div>;

  const shown = filtered.slice(0, visible);
  const remaining = Math.max(0, filtered.length - visible);

  return (
    <div className="nsbva-root">
      <div className="nsbva-controls">
        <input
          className="nsbva-search"
          type="search"
          placeholder="Search by container / entry…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <select
          className="nsbva-select"
          value={container}
          onChange={e => setContainer(e.target.value)}
        >
          {containers.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="nsbva-count">
          <strong>{shown.length}</strong> of <strong>{filtered.length}</strong>
        </span>
      </div>

      <div className="nsbva-grid">
        {shown.map(r => (
          <figure key={r.apng} className="nsbva-card">
            <div className="nsbva-imgwrap">
              <img
                src={`${imagePrefix}/${r.apng}`}
                alt={`${shortContainer(r.container)} #${r.entry_idx}${r.sub_label}`}
                loading="lazy"
              />
            </div>
            <img
              className="nsbva-strip"
              src={`${imagePrefix}/${r.strip}`}
              alt=""
              loading="lazy"
            />
            <figcaption>
              <strong>{shortContainer(r.container)} #{r.entry_idx}{r.sub_label}</strong>
              <span className="nsbva-meta">
                {r.frame_count ?? '?'} frames · {r.visible_frames ?? '?'} visible
              </span>
            </figcaption>
          </figure>
        ))}
      </div>

      {remaining > 0 && (
        <div className="nsbva-more">
          <button
            type="button"
            className="nsbva-morebtn"
            onClick={() => setVisible(v => v + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, remaining)} more
          </button>
        </div>
      )}

      <style>{`
        .nsbva-root { padding: 0 0 60px; }
        .nsbva-controls {
          display: flex; gap: 12px; align-items: center;
          flex-wrap: wrap; margin: 8px 0 18px;
        }
        .nsbva-search, .nsbva-select {
          padding: 10px 16px;
          border-radius: 999px;
          border: 1px solid var(--color-purple-100);
          background: white; color: var(--color-ink);
          font-family: inherit; font-size: 0.95rem;
          box-shadow: var(--shadow-soft);
        }
        .nsbva-search { flex: 1 1 240px; min-width: 180px; }
        .nsbva-search:focus, .nsbva-select:focus {
          outline: none; border-color: var(--color-purple-200);
          box-shadow: 0 0 0 3px rgba(155, 123, 217, 0.15);
        }
        .nsbva-count { color: var(--color-ink-soft); font-size: 0.88rem; }
        .nsbva-count strong { color: var(--color-purple-600); }

        .nsbva-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 16px;
        }

        .nsbva-card {
          margin: 0;
          background: var(--surface-strong);
          border-radius: 18px;
          box-shadow: var(--shadow-soft);
          border: 1px solid var(--color-pink-100);
          overflow: hidden;
        }

        .nsbva-imgwrap {
          background: #1a1330;
          display: flex; align-items: center; justify-content: center;
          aspect-ratio: 1 / 1;
          overflow: hidden;
        }
        .nsbva-imgwrap img {
          max-width: 100%; max-height: 100%;
          object-fit: contain;
          image-rendering: -webkit-optimize-contrast;
        }

        .nsbva-strip {
          display: block;
          width: 100%;
          height: 22px;
          object-fit: cover;
          object-position: left center;
          background: #0f0a20;
          border-top: 1px solid rgba(255,255,255,0.06);
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }

        .nsbva-card figcaption {
          padding: 8px 14px 12px;
          display: flex; flex-direction: column; gap: 2px;
        }
        .nsbva-card figcaption strong {
          color: var(--color-purple-600);
          font-size: 0.88rem;
          font-family: ui-monospace, monospace;
        }
        .nsbva-meta {
          color: var(--color-ink-soft);
          font-size: 0.76rem;
        }

        .nsbva-more {
          display: flex; justify-content: center; padding: 26px 0 0;
        }
        .nsbva-morebtn {
          padding: 12px 28px; border-radius: 999px; border: none;
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; font-family: inherit; font-weight: 700; cursor: pointer;
          box-shadow: var(--shadow-pop);
        }
        .nsbva-morebtn:hover { transform: translateY(-2px); }

        .nsbva-status {
          padding: 32px; text-align: center; color: var(--color-ink-soft);
        }
        .nsbva-status.error { color: #b03030; }
      `}</style>
    </div>
  );
}

function shortContainer(p: string) {
  // "extracted/nds/data/model/item/room.ofs" → "item/room"
  return p
    .replace(/^extracted\/nds\/data\/model\//, '')
    .replace(/\.ofs$/, '');
}
