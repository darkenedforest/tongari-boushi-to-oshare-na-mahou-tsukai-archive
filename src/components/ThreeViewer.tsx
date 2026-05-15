import { useEffect, useMemo, useRef, useState } from 'react';

interface ModelRecord {
  name: string;
  category: string;
  source_container?: string;
  gltf_path: string;
  thumb_path: string;
  triangle_count?: number;
  bone_count?: number;
  texture_count?: number;
  has_animations?: boolean;
  label_en?: string | null;
  label_jp?: string | null;
}

interface Props {
  manifestUrl: string;
}

const PAGE_SIZE = 60;

export default function ThreeViewer({ manifestUrl }: Props) {
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ModelRecord | null>(null);

  useEffect(() => {
    fetch(`${manifestUrl}?cb=${Date.now()}`)
      .then(r => {
        if (!r.ok) throw new Error(`Manifest fetch failed: ${r.status}`);
        return r.json();
      })
      .then((data: ModelRecord[]) => {
        setModels(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(e => {
        setErr(String(e));
        setLoading(false);
      });
  }, [manifestUrl]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    models.forEach(r => set.add(r.category || 'uncategorized'));
    return ['all', ...Array.from(set).sort()];
  }, [models]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter(r => {
      if (category !== 'all' && (r.category || 'uncategorized') !== category) return false;
      if (q) {
        const hay = `${r.name} ${r.source_container ?? ''} ${r.label_en ?? ''} ${r.label_jp ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [models, query, category]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRecords = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  useEffect(() => { setPage(0); }, [query, category]);

  if (loading) return <div className="viewer-status">Loading 3D model index…</div>;
  if (err) {
    return (
      <div className="viewer-status">
        <p>No 3D models available yet. The extraction + glTF conversion pipeline is still running on the translator side.</p>
        <p className="status-note">When models land, they'll show up here as thumbnail tiles. Click a tile to spin the model in a 3D viewer with orbit / zoom / pan controls and animation playback.</p>
      </div>
    );
  }
  if (models.length === 0) {
    return (
      <div className="viewer-status">
        <p>The model manifest is empty. Extraction pipeline is still running.</p>
      </div>
    );
  }

  return (
    <div className="viewer-root">
      <div className="viewer-controls">
        <input
          className="search-input"
          type="search"
          placeholder="Search by name or container…"
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
        <div className="counts">{filtered.length.toLocaleString()} of {models.length.toLocaleString()} models</div>
      </div>

      <div className="grid">
        {pageRecords.map(m => {
          const primary = m.label_en || m.label_jp || m.name;
          return (
            <button key={m.gltf_path} className="tile" onClick={() => setSelected(m)} title={primary}>
              <img loading="lazy" src={m.thumb_path} alt={primary} />
              <span className="tile-label">{primary}</span>
              {m.has_animations && <span className="tile-anim" title="Has animations">▶</span>}
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

      {selected && <ViewerModal model={selected} onClose={() => setSelected(null)} />}

      <style>{`
        .viewer-status { padding: 60px 20px; text-align: center; color: var(--color-ink-soft); background: var(--surface-strong); border-radius: var(--radius-lg); border: 1px solid var(--color-pink-100); }
        .viewer-status .status-note { font-size: 0.88rem; opacity: 0.8; max-width: 50ch; margin: 12px auto 0; }
        .viewer-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 16px; margin-bottom: 20px; background: var(--surface-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-soft); border: 1px solid var(--color-pink-100); }
        .search-input { flex: 1 1 240px; padding: 10px 16px; border-radius: var(--radius-pill); border: 1px solid var(--color-purple-100); font: inherit; background: var(--color-purple-50); color: var(--color-ink); }
        .search-input:focus { outline: 2px solid var(--color-pink-200); }
        .category-pills { display: flex; flex-wrap: wrap; gap: 6px; }
        .pill { padding: 6px 14px; border-radius: var(--radius-pill); background: var(--color-purple-50); color: var(--color-purple-600); border: 1px solid var(--color-purple-100); font-weight: 600; font-size: 0.85rem; cursor: pointer; font-family: inherit; }
        .pill:hover { background: var(--color-purple-100); }
        .pill-active { background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400)); color: white; border-color: transparent; }
        .counts { color: var(--color-ink-soft); font-size: 0.85rem; margin-left: auto; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
        .tile { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 8px; background: var(--surface-strong); border-radius: var(--radius-md); box-shadow: var(--shadow-soft); border: 1px solid var(--color-pink-100); cursor: pointer; font: inherit; color: inherit; transition: transform 0.12s ease, box-shadow 0.12s ease; }
        .tile:hover { transform: translateY(-2px); box-shadow: var(--shadow-pop); }
        .tile img { width: 100%; height: 120px; object-fit: contain; background: repeating-conic-gradient(#f5f0ff 0% 25%, #ffffff 0% 50%) 0 / 14px 14px; border-radius: 8px; }
        .tile-label { font-size: 0.78rem; font-weight: 600; color: var(--color-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tile-anim { position: absolute; top: 12px; right: 12px; background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400)); color: white; font-size: 0.7rem; padding: 2px 6px; border-radius: 999px; font-weight: 700; }
        .pagination { display: flex; align-items: center; justify-content: center; gap: 16px; padding-top: 24px; }
        .page-btn { padding: 8px 16px; border-radius: var(--radius-pill); background: var(--color-purple-50); color: var(--color-purple-600); border: 1px solid var(--color-purple-100); font-weight: 600; cursor: pointer; font-family: inherit; }
        .page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .page-info { font-weight: 600; color: var(--color-ink-soft); }
      `}</style>
    </div>
  );
}

function ViewerModal({ model, onClose }: { model: ModelRecord; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [animPlaying, setAnimPlaying] = useState(true);

  useEffect(() => {
    let disposed = false;
    let cleanupFn: (() => void) | null = null;

    async function init() {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      if (disposed || !canvasRef.current) return;

      const canvas = canvasRef.current;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h, false);
      renderer.setClearColor(0xfff8ee, 1);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xfff8ee);

      const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 1000);
      camera.position.set(2, 1.6, 3);

      // Pastel lighting matching the site theme
      scene.add(new THREE.AmbientLight(0xffffff, 0.65));
      const key = new THREE.DirectionalLight(0xffd6e7, 0.9);
      key.position.set(2, 3, 2);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xcab3ff, 0.5);
      rim.position.set(-2, 2, -1);
      scene.add(rim);

      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;

      const loader = new GLTFLoader();
      let mixer: any = null;
      let actions: any[] = [];

      loader.load(
        model.gltf_path,
        gltf => {
          if (disposed) return;
          scene.add(gltf.scene);
          // Fit to view
          const box = new THREE.Box3().setFromObject(gltf.scene);
          const size = box.getSize(new THREE.Vector3()).length();
          const center = box.getCenter(new THREE.Vector3());
          gltf.scene.position.sub(center);
          camera.position.set(size * 0.8, size * 0.55, size * 1.1);
          camera.near = size / 100;
          camera.far = size * 100;
          camera.updateProjectionMatrix();
          controls.target.set(0, 0, 0);
          controls.update();
          if (gltf.animations && gltf.animations.length) {
            mixer = new THREE.AnimationMixer(gltf.scene);
            actions = gltf.animations.map(c => mixer.clipAction(c));
            actions.forEach(a => a.play());
          }
        },
        undefined,
        e => {
          if (!disposed) setLoadErr(`Couldn't load model: ${(e as any)?.message ?? e}`);
        }
      );

      let last = performance.now();
      function frame(now: number) {
        if (disposed) return;
        const dt = (now - last) / 1000;
        last = now;
        if (mixer && animPlaying) mixer.update(dt);
        controls.update();
        renderer.render(scene, camera);
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);

      function onResize() {
        if (!canvasRef.current) return;
        const w2 = canvas.clientWidth;
        const h2 = canvas.clientHeight;
        renderer.setSize(w2, h2, false);
        camera.aspect = w2 / h2;
        camera.updateProjectionMatrix();
      }
      window.addEventListener('resize', onResize);

      cleanupFn = () => {
        window.removeEventListener('resize', onResize);
        controls.dispose();
        renderer.dispose();
      };
    }

    init();
    return () => {
      disposed = true;
      if (cleanupFn) cleanupFn();
    };
  }, [model.gltf_path]);

  const title = model.label_en || model.label_jp || model.name;

  return (
    <div className="viewer-modal" onClick={onClose} role="dialog">
      <div className="viewer-modal-inner" onClick={e => e.stopPropagation()}>
        <button className="viewer-close" onClick={onClose} aria-label="Close">×</button>
        <div className="viewer-canvas-wrap">
          <canvas ref={canvasRef} className="viewer-canvas" />
          {loadErr && <div className="viewer-error">{loadErr}</div>}
        </div>
        <div className="viewer-meta">
          <h3>{title}</h3>
          {model.label_jp && model.label_en && <p className="jp">{model.label_jp}</p>}
          <dl>
            <dt>Category</dt><dd>{model.category}</dd>
            {model.source_container && (<><dt>Source</dt><dd><code>{model.source_container}</code></dd></>)}
            {model.triangle_count != null && (<><dt>Triangles</dt><dd>{model.triangle_count.toLocaleString()}</dd></>)}
            {model.bone_count != null && (<><dt>Bones</dt><dd>{model.bone_count}</dd></>)}
            {model.texture_count != null && (<><dt>Textures</dt><dd>{model.texture_count}</dd></>)}
            {model.has_animations && (<><dt>Animations</dt><dd>Yes (playing on load)</dd></>)}
          </dl>
        </div>
      </div>
      <style>{`
        .viewer-modal { position: fixed; inset: 0; background: rgba(74, 46, 94, 0.7); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 100; }
        .viewer-modal-inner { background: white; border-radius: var(--radius-lg); width: 100%; max-width: 920px; max-height: 92vh; overflow: hidden; display: grid; grid-template-rows: 1fr auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); position: relative; }
        .viewer-close { position: absolute; top: 12px; right: 12px; width: 36px; height: 36px; border-radius: 50%; background: white; color: var(--color-pink-600); border: none; font-size: 1.5rem; cursor: pointer; line-height: 1; z-index: 2; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        .viewer-canvas-wrap { position: relative; min-height: 380px; background: var(--color-cream); }
        .viewer-canvas { display: block; width: 100%; height: 100%; min-height: 380px; }
        .viewer-error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--color-pink-600); font-weight: 600; padding: 20px; }
        .viewer-meta { padding: 16px 22px; border-top: 1px solid var(--color-pink-100); background: var(--surface-strong); overflow: auto; }
        .viewer-meta h3 { margin: 0 0 4px; color: var(--color-ink); }
        .viewer-meta .jp { margin: 0 0 10px; color: var(--color-purple-600); font-size: 1rem; }
        .viewer-meta dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 0; }
        .viewer-meta dt { font-weight: 700; color: var(--color-purple-600); font-size: 0.85rem; }
        .viewer-meta dd { margin: 0; color: var(--color-ink); font-size: 0.9rem; word-break: break-all; }
        .viewer-meta code { background: var(--color-purple-50); padding: 1px 6px; border-radius: 4px; font-size: 0.85em; }
      `}</style>
    </div>
  );
}
