import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

interface AssetRecord {
  png_path: string;            // relative to BASE_URL, served from /assets/
  source_container: string;    // e.g. "2d/inputmagic/msg.ofs"
  category: string;            // e.g. "magic_glyphs" | "item_icons" | "ui" | "title" | etc.
  ncgr_inner_index: number;
  label_jp?: string;
  label_en?: string;
  width?: number;
  height?: number;
  bpp?: number;
  palette_strategy?: string;
}

interface Props {
  manifestUrl: string;
}

const PAGE_SIZE = 60;

export default function AssetGallery({ manifestUrl }: Props) {
  const [records, setRecords] = useState<AssetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<AssetRecord | null>(null);

  useEffect(() => {
    // Cache-bust the manifest fetch — browser must never serve a stale
    // manifest because the png_path entries it contains are tied to the
    // build that produced them.
    fetch(`${manifestUrl}?cb=${Date.now()}`)
      .then(r => {
        if (!r.ok) throw new Error(`Manifest fetch failed: ${r.status}`);
        return r.json();
      })
      .then((data: AssetRecord[]) => {
        setRecords(data);
        setLoading(false);
      })
      .catch(e => {
        setErr(String(e));
        setLoading(false);
      });
  }, [manifestUrl]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    records.forEach(r => set.add(r.category || 'uncategorized'));
    return ['all', ...Array.from(set).sort()];
  }, [records]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter(r => {
      if (category !== 'all' && (r.category || 'uncategorized') !== category) return false;
      if (q) {
        const hay = `${r.source_container} ${r.png_path} ${r.label_en ?? ''} ${r.label_jp ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [records, query, category]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRecords = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => { setPage(0); }, [query, category]);

  if (loading) return <div className="gallery-status">Loading manifest…</div>;
  if (err)     return <div className="gallery-status error">Couldn't load asset manifest. ({err})</div>;
  if (records.length === 0) {
    return (
      <div className="gallery-status">
        Manifest is empty. Once the asset-extraction pass finishes, PNGs and a <code>manifest.json</code> will be published here.
      </div>
    );
  }

  return (
    <div className="gallery-root">
      <div className="gallery-controls">
        <input
          className="search-input"
          type="search"
          placeholder="Search by path or container…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <div className="category-pills">
          {categories.map(c => (
            <button
              key={c}
              className={`pill ${category === c ? 'pill-active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="counts">{filtered.length.toLocaleString()} of {records.length.toLocaleString()} images</div>
      </div>

      <div className="grid">
        {pageRecords.map(r => {
          const primary = r.label_en || r.label_jp || r.source_container.split('/').pop() || '';
          const tooltip = r.label_en && r.label_jp
            ? `${r.label_en} — ${r.label_jp}`
            : r.label_en || r.label_jp || r.source_container;
          return (
            <button
              key={r.png_path}
              className="tile"
              onClick={() => setSelected(r)}
              title={tooltip}
            >
              <img loading="lazy" src={r.png_path} alt={primary} />
              <span className="tile-label">{primary}</span>
              {r.label_jp && r.label_en && (
                <span className="tile-sub">{r.label_jp}</span>
              )}
            </button>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="pagination">
          <button className="page-btn" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>← Prev</button>
          <span className="page-info">Page {page + 1} of {totalPages}</span>
          <button className="page-btn" disabled={page >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>Next →</button>
        </div>
      )}

      {/* Portal to <body>: the page container's z-index:1 stacking context
          would trap this overlay below the sticky site header, which then
          covers (and swallows clicks on) the close button. */}
      {selected && createPortal(
        <div className="lightbox" onClick={() => setSelected(null)} role="dialog">
          <div className="lightbox-inner" onClick={e => e.stopPropagation()}>
            <button className="lightbox-close" onClick={() => setSelected(null)} aria-label="Close">×</button>
            <img className="lightbox-img" src={selected.png_path} alt={selected.label_en || selected.source_container} />
            <div className="lightbox-meta">
              <h3>{selected.label_en || selected.label_jp || selected.source_container.split('/').pop()}</h3>
              {selected.label_jp && (
                <p className="lightbox-jp">{selected.label_jp}</p>
              )}
              <dl>
                {selected.label_en && (<><dt>English name</dt><dd>{selected.label_en}</dd></>)}
                {selected.label_jp && (<><dt>Japanese name</dt><dd lang="ja">{selected.label_jp}</dd></>)}
                <dt>Category</dt><dd>{selected.category}</dd>
                <dt>Source container</dt><dd><code>{selected.source_container}</code></dd>
                <dt>NCGR index</dt><dd>{selected.ncgr_inner_index}</dd>
                {selected.width && selected.height && (<><dt>Size</dt><dd>{selected.width} × {selected.height}</dd></>)}
                {selected.bpp && (<><dt>BPP</dt><dd>{selected.bpp}</dd></>)}
                {selected.palette_strategy && (<><dt>Palette source</dt><dd>{selected.palette_strategy}</dd></>)}
              </dl>
            </div>
          </div>
        </div>,
        document.body
      )}

      <style>{`
        .gallery-root { padding-bottom: 40px; }
        .gallery-status { padding: 40px; text-align: center; color: var(--color-ink-soft); }
        .gallery-status.error { color: var(--color-pink-600); }

        .gallery-controls {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          align-items: center;
          padding: 16px;
          margin-bottom: 20px;
          background: var(--surface-strong);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-soft);
          border: 1px solid var(--color-pink-100);
        }
        .search-input {
          flex: 1 1 240px;
          padding: 10px 16px;
          border-radius: var(--radius-pill);
          border: 1px solid var(--color-purple-100);
          font: inherit;
          background: var(--color-purple-50);
          color: var(--color-ink);
        }
        .search-input:focus { outline: 2px solid var(--color-pink-200); }

        .category-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .pill {
          padding: 6px 14px;
          border-radius: var(--radius-pill);
          background: var(--color-purple-50);
          color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100);
          font-weight: 600;
          font-size: 0.85rem;
          cursor: pointer;
          transition: background 0.12s ease, color 0.12s ease;
          font-family: inherit;
        }
        .pill:hover { background: var(--color-purple-100); }
        .pill-active { background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400)); color: white; border-color: transparent; }

        .counts { color: var(--color-ink-soft); font-size: 0.85rem; margin-left: auto; }

        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
          gap: 12px;
        }
        .tile {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 8px;
          background: var(--surface-strong);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-soft);
          border: 1px solid var(--color-pink-100);
          cursor: pointer;
          transition: transform 0.12s ease, box-shadow 0.12s ease;
          font: inherit;
          color: inherit;
        }
        .tile:hover {
          transform: translateY(-2px);
          box-shadow: var(--shadow-pop);
        }
        .tile img {
          width: 100%;
          height: 100px;
          object-fit: contain;
          image-rendering: pixelated;
          background: repeating-conic-gradient(#f5f0ff 0% 25%, #ffffff 0% 50%) 0 / 14px 14px;
          border-radius: 8px;
        }
        .tile-label {
          font-size: 0.78rem;
          font-weight: 600;
          color: var(--color-ink);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tile-sub {
          font-size: 0.68rem;
          color: var(--color-ink-soft);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .pagination {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 16px;
          padding-top: 24px;
        }
        .page-btn {
          padding: 8px 16px;
          border-radius: var(--radius-pill);
          background: var(--color-purple-50);
          color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100);
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
        }
        .page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .page-info { font-weight: 600; color: var(--color-ink-soft); }

        .lightbox {
          position: fixed;
          inset: 0;
          background: rgba(74, 46, 94, 0.6);
          backdrop-filter: blur(6px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          z-index: 100;
        }
        .lightbox-inner {
          background: white;
          border-radius: var(--radius-lg);
          padding: 24px;
          max-width: 720px;
          width: 100%;
          max-height: 90vh;
          overflow: auto;
          position: relative;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        .lightbox-close {
          position: absolute;
          top: 12px; right: 12px;
          width: 32px; height: 32px;
          border-radius: 50%;
          background: var(--color-pink-100);
          color: var(--color-pink-600);
          border: none;
          font-size: 1.4rem;
          cursor: pointer;
          line-height: 1;
        }
        .lightbox-img {
          display: block;
          width: 100%;
          max-height: 480px;
          object-fit: contain;
          background: repeating-conic-gradient(#f5f0ff 0% 25%, #ffffff 0% 50%) 0 / 14px 14px;
          border-radius: var(--radius-md);
          image-rendering: pixelated;
        }
        .lightbox-meta { margin-top: 16px; }
        .lightbox-meta h3 { margin: 0 0 4px; }
        .lightbox-jp {
          margin: 0 0 14px;
          font-size: 1.05rem;
          color: var(--color-purple-600);
        }
        .lightbox-meta dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
        .lightbox-meta dt { font-weight: 700; color: var(--color-purple-600); font-size: 0.85rem; }
        .lightbox-meta dd { margin: 0; color: var(--color-ink); font-size: 0.9rem; word-break: break-all; }
      `}</style>
    </div>
  );
}
