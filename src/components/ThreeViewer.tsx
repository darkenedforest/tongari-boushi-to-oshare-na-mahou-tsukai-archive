import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Data contract: scripts/build_3d_assets.py writes 3d-manifest.json (the grid)
// and 3d-textures.json (texture pools + per-model material slots, loaded when
// the first model is opened). The glTF files are self-contained: the default
// textures are embedded; the sidebar swaps them for others from the same pool.

// Manifest records use short keys to keep the index small (14k models).
interface RawModel {
  id: string; n: string; c: string; tri?: number | null; b?: number | null; tx?: number | null;
  kb?: number; al: number; an?: string[]; g?: number[]; anim?: string;
}

interface ModelGroup { hat: number; hair: number; body: number }

interface ModelRecord {
  id: string;
  name: string;
  category: string;
  gltf: string;
  thumb: string;
  triangles?: number | null;
  bones?: number | null;
  textures?: number | null;
  kb?: number | null;
  alias_count: number;
  alias_names: string[];
  group?: ModelGroup | null;
  anim?: string | null;
}

interface Category { id: string; title: string; count: number }
interface AnimSet { id: string; title: string; skeleton: string; clips: string[]; kb: number }

interface Manifest {
  version: string;
  generated: string;
  base: string;
  model_count: number;
  alias_count: number;
  categories: Category[];
  anim_sets: AnimSet[];
  models: RawModel[];
}

interface RawSwatch { e: number; l: number | null; w: number; h: number; f: string }
interface Swatch { entry: number; lod: number | null; w: number; h: number; png: string }
interface RawSlot { m: string; t: string; w: number; h: number; x: number; e: number | null; l: number | null; p: number | null }

interface Slot {
  material: string;
  texture: string;
  w: number;
  h: number;
  textured: boolean;
  entry: number | null;
  lod: number | null;
  pool: number | null;
}

interface TextureData { version: string; pools: { key: string; items: RawSwatch[] }[]; slots: Record<string, RawSlot[]> }

function expandModel(r: RawModel, base: string, v: string): ModelRecord {
  return {
    id: r.id, name: r.n, category: r.c,
    gltf: `${base}/3d/${r.c}/${r.id}.glb?v=${v}`,
    thumb: `${base}/images/3d/${r.c}/${r.id}.png?v=${v}`,
    triangles: r.tri, bones: r.b, textures: r.tx, kb: r.kb,
    alias_count: r.al, alias_names: r.an || [],
    group: r.g ? { hat: r.g[0], hair: r.g[1], body: r.g[2] } : null,
    anim: r.anim || null,
  };
}

interface Props { manifestUrl: string; texturesUrl: string }

const PAGE_SIZE = 60;

const SLOT_LABELS: Record<string, string> = {
  c00_face: 'Face', c01_cloth_u: 'Top', c02_cloth_d: 'Bottom', c03_shoes: 'Shoes',
  c04_ear: 'Ears', c04_hair: 'Hair', c05_hair: 'Hair colour', c05_ear: 'Ears', c05_skin: 'Skin',
  c06_tail: 'Tail', c07_hand: 'Hands', c09_glasses: 'Glasses', zc08_hat: 'Hat',
  ucc_n_b: 'Necklace chain', ucc_n_j: 'Necklace jewel',
};

function slotLabel(material: string, texture: string): string {
  return SLOT_LABELS[material] || SLOT_LABELS[texture] || material || texture;
}

function imageToDataUrl(img: any): string | null {
  try {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d')!.drawImage(img, 0, 0);
    return c.toDataURL('image/png');
  } catch { return null; }
}

function fmtKb(kb?: number | null): string {
  if (!kb) return '';
  if (kb > 1000) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

export default function ThreeViewer({ manifestUrl, texturesUrl }: Props) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ModelRecord | null>(null);
  const texData = useRef<Promise<TextureData> | null>(null);

  useEffect(() => {
    fetch(`${manifestUrl}?cb=${Date.now()}`)
      .then(r => { if (!r.ok) throw new Error(`Manifest fetch failed: ${r.status}`); return r.json(); })
      .then((data: Manifest) => setManifest(data))
      .catch(e => setErr(String(e)));
  }, [manifestUrl]);

  function loadTextures(): Promise<TextureData> {
    if (!texData.current) {
      texData.current = fetch(`${texturesUrl}?cb=${manifest?.version ?? Date.now()}`)
        .then(r => { if (!r.ok) throw new Error(`Texture index fetch failed: ${r.status}`); return r.json(); });
    }
    return texData.current;
  }

  const models = useMemo(
    () => (manifest ? manifest.models.map(r => expandModel(r, manifest.base, manifest.version)) : []),
    [manifest]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    return models.filter(r => {
      if (category !== 'all' && r.category !== category) return false;
      if (!terms.length) return true;
      const hay = [
        r.name, r.id, r.category, ...(r.alias_names || []),
        r.group ? `hat${r.group.hat} hat ${r.group.hat} hair${r.group.hair} hair ${r.group.hair} body${r.group.body} body ${r.group.body}` : '',
      ].join(' ').toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }, [models, query, category]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRecords = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  useEffect(() => { setPage(0); }, [query, category]);

  if (err) return <div className="viewer-status"><p>The model index could not be loaded ({err}).</p></div>;
  if (!manifest) return <div className="viewer-status">Loading the model index…</div>;
  if (!models.length) return <div className="viewer-status"><p>The model index is empty.</p></div>;

  return (
    <div className="viewer-root">
      <div className="viewer-controls">
        <input
          className="search-input"
          type="search"
          placeholder="Search by name, file, hat/hair/body number…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <div className="category-pills">
          <button className={`pill ${category === 'all' ? 'pill-active' : ''}`} onClick={() => setCategory('all')}>
            All <span className="pill-count">{manifest.model_count.toLocaleString()}</span>
          </button>
          {manifest.categories.map(c => (
            <button key={c.id} className={`pill ${category === c.id ? 'pill-active' : ''}`} onClick={() => setCategory(c.id)} title={c.id}>
              {c.title} <span className="pill-count">{c.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
        <div className="counts">
          {filtered.length.toLocaleString()} of {manifest.model_count.toLocaleString()} distinct models
          <span className="counts-sub"> · {(manifest.model_count + manifest.alias_count).toLocaleString()} files in the ROM</span>
        </div>
      </div>

      <div className="grid">
        {pageRecords.map(m => (
          <button key={m.id} className="tile" onClick={() => setSelected(m)} title={m.name}>
            <img loading="lazy" src={m.thumb} alt={m.name} />
            <span className="tile-label">{m.name}</span>
            <span className="tile-sub">
              {m.group ? `hat ${m.group.hat} · hair ${m.group.hair} · body ${m.group.body}` : m.category}
            </span>
            {m.alias_count > 0 && <span className="tile-alias" title={`${m.alias_count} more files in the ROM are this exact model`}>+{m.alias_count}</span>}
          </button>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="pagination">
          <button className="page-btn" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>← Prev</button>
          <span className="page-info">Page {page + 1} of {totalPages}</span>
          <button className="page-btn" disabled={page >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>Next →</button>
        </div>
      )}

      {selected && <ViewerModal model={selected} manifest={manifest} loadTextures={loadTextures} onClose={() => setSelected(null)} />}

      <style>{`
        .viewer-status { padding: 60px 20px; text-align: center; color: var(--color-ink-soft); background: var(--surface-strong); border-radius: var(--radius-lg); border: 1px solid var(--color-pink-100); }
        .viewer-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 16px; margin-bottom: 20px; background: var(--surface-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-soft); border: 1px solid var(--color-pink-100); }
        .search-input { flex: 1 1 260px; padding: 10px 16px; border-radius: var(--radius-pill); border: 1px solid var(--color-purple-100); font: inherit; background: var(--color-purple-50); color: var(--color-ink); }
        .search-input:focus { outline: 2px solid var(--color-pink-200); }
        .category-pills { display: flex; flex-wrap: wrap; gap: 6px; }
        .pill { padding: 6px 12px; border-radius: var(--radius-pill); background: var(--color-purple-50); color: var(--color-purple-600); border: 1px solid var(--color-purple-100); font-weight: 600; font-size: 0.82rem; cursor: pointer; font-family: inherit; }
        .pill:hover { background: var(--color-purple-100); }
        .pill-active { background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400)); color: white; border-color: transparent; }
        .pill-count { opacity: 0.7; font-weight: 500; margin-left: 4px; }
        .counts { color: var(--color-ink-soft); font-size: 0.85rem; margin-left: auto; }
        .counts-sub { opacity: 0.75; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
        .tile { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 8px; background: var(--surface-strong); border-radius: var(--radius-md); box-shadow: var(--shadow-soft); border: 1px solid var(--color-pink-100); cursor: pointer; font: inherit; color: inherit; text-align: left; transition: transform 0.12s ease, box-shadow 0.12s ease; }
        .tile:hover { transform: translateY(-2px); box-shadow: var(--shadow-pop); }
        .tile img { width: 100%; height: 130px; object-fit: contain; background: repeating-conic-gradient(#f5f0ff 0% 25%, #ffffff 0% 50%) 0 / 14px 14px; border-radius: 8px; image-rendering: auto; }
        .tile-label { font-size: 0.8rem; font-weight: 700; color: var(--color-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 4px; }
        .tile-sub { font-size: 0.72rem; color: var(--color-ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tile-alias { position: absolute; top: 12px; right: 12px; background: var(--color-purple-50); color: var(--color-purple-600); border: 1px solid var(--color-purple-100); font-size: 0.7rem; padding: 2px 7px; border-radius: 999px; font-weight: 700; }
        .pagination { display: flex; align-items: center; justify-content: center; gap: 16px; padding-top: 24px; }
        .page-btn { padding: 8px 16px; border-radius: var(--radius-pill); background: var(--color-purple-50); color: var(--color-purple-600); border: 1px solid var(--color-purple-100); font-weight: 600; cursor: pointer; font-family: inherit; }
        .page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .page-info { font-weight: 600; color: var(--color-ink-soft); }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface LoadedSlot extends Slot {
  current: string;          // PNG URL or data URI currently applied
  embedded: string | null;  // the default (embedded) image data URI
}

type ThreeApi = {
  setSlotTexture: (material: string, url: string, w: number, h: number) => void;
  setAutoRotate: (on: boolean) => void;
  loadAnimSet: (url: string) => Promise<string[]>;
  playClip: (index: number | null) => void;
  snapshot: () => string | null;
};

function ViewerModal({ model, manifest, loadTextures, onClose }: {
  model: ModelRecord; manifest: Manifest; loadTextures: () => Promise<TextureData>; onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const apiRef = useRef<ThreeApi | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [slots, setSlots] = useState<LoadedSlot[]>([]);
  const [pools, setPools] = useState<Swatch[][]>([]);
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const [clips, setClips] = useState<string[]>([]);
  const [clip, setClip] = useState<number | null>(null);
  const [animSet, setAnimSet] = useState<string>('');
  const [animBusy, setAnimBusy] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [showAliases, setShowAliases] = useState(false);
  const animSets = model.anim ? manifest.anim_sets.filter(s => s.skeleton === model.anim) : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let disposed = false;
    let cleanupFn: (() => void) | null = null;

    async function init() {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      if (disposed || !canvasRef.current) return;

      const canvas = canvasRef.current;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      renderer.setClearColor(0xfff8ee, 1);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xfff8ee);
      const camera = new THREE.PerspectiveCamera(35, canvas.clientWidth / canvas.clientHeight, 0.01, 1000);

      scene.add(new THREE.HemisphereLight(0xffffff, 0xd9c7ff, 1.6));
      const key = new THREE.DirectionalLight(0xffffff, 2.0);
      key.position.set(2, 3, 4);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xffd6e7, 0.8);
      rim.position.set(-3, 2, -2);
      scene.add(rim);

      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.autoRotateSpeed = 1.5;

      let mixer: any = null;
      let actions: any[] = [];
      const materialsByName = new Map<string, any[]>();
      const texLoader = new THREE.TextureLoader();

      const loader = new GLTFLoader();
      loader.load(
        model.gltf,
        gltf => {
          if (disposed) return;
          scene.add(gltf.scene);
          gltf.scene.traverse((o: any) => {
            if (!o.isMesh) return;
            o.frustumCulled = false;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
              if (!m) continue;
              m.side = THREE.DoubleSide;
              if (m.map) { m.map.magFilter = THREE.NearestFilter; m.map.minFilter = THREE.NearestFilter; m.map.needsUpdate = true; }
              const list = materialsByName.get(m.name) || [];
              list.push(m);
              materialsByName.set(m.name, list);
            }
          });
          const box = new THREE.Box3().setFromObject(gltf.scene);
          const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-3);
          const center = box.getCenter(new THREE.Vector3());
          gltf.scene.position.sub(center);
          camera.position.set(size * 0.55, size * 0.35, size * 1.25);
          camera.near = size / 100;
          camera.far = size * 100;
          camera.updateProjectionMatrix();
          controls.target.set(0, 0, 0);
          controls.update();
          if (gltf.animations && gltf.animations.length) {
            mixer = new THREE.AnimationMixer(gltf.scene);
            actions = gltf.animations.map((c: any) => mixer.clipAction(c));
            setClips(gltf.animations.map((c: any, i: number) => c.name || `clip ${i}`));
            actions[0].play();
            setClip(0);
          }
          // Material slots: names from the glTF, default swatches read back
          // from the decoded textures (the GLB packs them, so no data URIs).
          const json = gltf.parser.json;
          const defaults: Record<string, string | null> = {};
          materialsByName.forEach((mats, name) => {
            const img = mats.find(m => m.map?.image)?.map?.image;
            defaults[name] = img ? imageToDataUrl(img) : null;
          });
          loadTextures().then(td => {
            if (disposed) return;
            const texBase = `${manifest.base}/3d-tex/`;
            setPools(td.pools.map(p => p.items.map(it => ({
              entry: it.e, lod: it.l, w: it.w, h: it.h, png: `${texBase}${it.f}?v=${td.version}`,
            }))));
            const list: LoadedSlot[] = (td.slots[model.id] || []).map(s => ({
              material: s.m, texture: s.t, w: s.w, h: s.h, textured: !!s.x, entry: s.e, lod: s.l, pool: s.p,
              embedded: defaults[s.m] ?? null, current: defaults[s.m] ?? '',
            }));
            // Slots the index does not know (no companion texture) still get a row.
            (json.materials || []).forEach((m: any) => {
              if (!list.find(s => s.material === m.name)) {
                list.push({ material: m.name, texture: m.extras?.texture ?? '', w: m.extras?.width ?? 0, h: m.extras?.height ?? 0,
                  textured: !!defaults[m.name], entry: null, lod: null, pool: null, embedded: defaults[m.name] ?? null, current: defaults[m.name] ?? '' });
              }
            });
            setSlots(list);
          }).catch(e => setLoadErr(`Texture index: ${e}`));
        },
        undefined,
        e => { if (!disposed) setLoadErr(`Couldn't load model: ${(e as any)?.message ?? e}`); }
      );

      apiRef.current = {
        setSlotTexture(material, url, w, h) {
          const mats = materialsByName.get(material);
          if (!mats) return;
          texLoader.load(url, tex => {
            tex.flipY = false;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            for (const m of mats) {
              if (m.map) { tex.wrapS = m.map.wrapS; tex.wrapT = m.map.wrapT; }
              m.map = tex;
              m.needsUpdate = true;
            }
          });
        },
        setAutoRotate(on) { controls.autoRotate = on; },
        async loadAnimSet(url) {
          // Skeleton-only GLB whose clips name the same bones as this model;
          // three.js binds tracks by node name, so they drive this scene.
          const set = await loader.loadAsync(url);
          const root = scene.children.find((o: any) => o !== key && o !== rim && o.type === 'Group') ?? scene;
          actions.forEach(a => a.stop());
          mixer = new THREE.AnimationMixer(root);
          actions = set.animations.map((c: any) => mixer.clipAction(c));
          return set.animations.map((c: any, i: number) => c.name || `clip ${i}`);
        },
        playClip(index) {
          actions.forEach(a => a.stop());
          if (index != null && actions[index]) actions[index].reset().play();
        },
        snapshot() {
          try { renderer.render(scene, camera); return canvas.toDataURL('image/png'); } catch { return null; }
        },
      };

      let last = performance.now();
      function frame(now: number) {
        if (disposed) return;
        const dt = (now - last) / 1000;
        last = now;
        if (mixer) mixer.update(dt);
        controls.update();
        renderer.render(scene, camera);
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);

      function onResize() {
        if (!canvasRef.current) return;
        renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
        camera.aspect = canvas.clientWidth / canvas.clientHeight;
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
    return () => { disposed = true; if (cleanupFn) cleanupFn(); };
  }, [model.gltf]);

  useEffect(() => { apiRef.current?.setAutoRotate(autoRotate); }, [autoRotate]);

  function applySwatch(slot: LoadedSlot, sw: Swatch) {
    apiRef.current?.setSlotTexture(slot.material, sw.png, sw.w, sw.h);
    setSlots(prev => prev.map(s => s.material === slot.material ? { ...s, current: sw.png, entry: sw.entry, lod: sw.lod } : s));
  }
  function resetSlot(slot: LoadedSlot) {
    if (!slot.embedded) return;
    apiRef.current?.setSlotTexture(slot.material, slot.embedded, slot.w, slot.h);
    setSlots(prev => prev.map(s => s.material === slot.material ? { ...s, current: slot.embedded! } : s));
  }
  function downloadSnapshot() {
    const url = apiRef.current?.snapshot();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url; a.download = `${model.name}.png`; a.click();
  }
  async function chooseAnimSet(id: string) {
    setAnimSet(id);
    setClip(null);
    if (!id) { apiRef.current?.playClip(null); setClips([]); return; }
    setAnimBusy(true);
    try {
      const names = await apiRef.current!.loadAnimSet(`${manifest.base}/3d/anim/${id}.glb?v=${manifest.version}`);
      setClips(names);
      if (names.length) { setClip(0); apiRef.current?.playClip(0); }
    } catch (e) {
      setLoadErr(`Animation set: ${e}`);
    } finally {
      setAnimBusy(false);
    }
  }

  const fileName = `${model.name}.glb`;

  return createPortal(
    <div className="viewer-modal" onClick={onClose} role="dialog" aria-label={model.name}>
      <div className="viewer-modal-inner" onClick={e => e.stopPropagation()}>
        <button className="viewer-close" onClick={onClose} aria-label="Close">×</button>
        <div className="viewer-stage">
          <canvas ref={canvasRef} className="viewer-canvas" />
          {loadErr && <div className="viewer-error">{loadErr}</div>}
          <div className="stage-tools">
            <label className="tool"><input type="checkbox" checked={autoRotate} onChange={e => setAutoRotate(e.target.checked)} /> spin</label>
            {animSets.length > 0 && (
              <select className="tool-select" value={animSet} disabled={animBusy} onChange={e => chooseAnimSet(e.target.value)} title="Animation set">
                <option value="">no animation</option>
                {animSets.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            )}
            {clips.length > 0 && (
              <select className="tool-select" value={clip ?? ''} onChange={e => { const v = e.target.value === '' ? null : Number(e.target.value); setClip(v); apiRef.current?.playClip(v); }} title="Clip">
                <option value="">hold pose</option>
                {clips.map((c, i) => <option key={i} value={i}>{c}</option>)}
              </select>
            )}
            <button className="tool-btn" onClick={downloadSnapshot}>save picture</button>
          </div>
        </div>

        <aside className="viewer-side">
          <h3>{model.name}</h3>
          <p className="side-sub">
            {model.group ? `hat ${model.group.hat} · hair ${model.group.hair} · body ${model.group.body}` : model.category}
            {model.triangles != null && <> · {model.triangles.toLocaleString()} triangles</>}
            {model.bones ? <> · {model.bones} bones</> : null}
          </p>
          <div className="side-actions">
            <a className="dl" href={model.gltf} download={fileName}>Download model (.glb{model.kb ? `, ${fmtKb(model.kb)}` : ''})</a>
            <span className="dl-note">Textures are embedded; opens in Blender via File › Import › glTF.</span>
          </div>

          {model.alias_count > 0 && (
            <div className="aliases">
              <button className="link-btn" onClick={() => setShowAliases(v => !v)}>
                {model.alias_count} more file{model.alias_count === 1 ? '' : 's'} in the ROM are this exact model {showAliases ? '▴' : '▾'}
              </button>
              {showAliases && <p className="alias-list">{model.alias_names.join(', ')}{model.alias_count > model.alias_names.length ? ', …' : ''}</p>}
            </div>
          )}

          <h4>Textures</h4>
          {slots.length === 0 && !loadErr && <p className="side-note">Loading texture list…</p>}
          <ul className="slot-list">
            {slots.map(s => {
              const pool = s.pool != null ? pools[s.pool] : undefined;
              const open = openSlot === s.material;
              return (
                <li key={s.material} className={`slot ${open ? 'slot-open' : ''}`}>
                  <button className="slot-head" onClick={() => setOpenSlot(open ? null : s.material)} disabled={!pool}>
                    <span className="swatch-box">{s.current ? <img src={s.current} alt="" /> : <span className="swatch-empty">none</span>}</span>
                    <span className="slot-text">
                      <span className="slot-name">{slotLabel(s.material, s.texture)}</span>
                      <span className="slot-meta">{s.texture}{s.w ? ` · ${s.w}×${s.h}` : ''}{pool ? ` · ${pool.length} options` : ''}</span>
                    </span>
                    {pool && <span className="slot-caret">{open ? '▴' : '▾'}</span>}
                  </button>
                  <span className="slot-dl">
                    {s.current && <a href={s.current} download={`${model.name}__${s.texture || s.material}.png`}>download png</a>}
                    {pool && s.embedded && s.current !== s.embedded && <button className="link-btn" onClick={() => resetSlot(s)}>reset</button>}
                  </span>
                  {open && pool && (
                    <div className="swatches">
                      {pool.map(sw => (
                        <button key={`${sw.entry}-${sw.lod}`} className={`swatch ${s.current === sw.png ? 'swatch-active' : ''}`} title={`entry ${sw.entry}${sw.lod != null ? ` lod ${sw.lod}` : ''}`} onClick={() => applySwatch(s, sw)}>
                          <img src={sw.png} alt={`entry ${sw.entry}`} loading="lazy" />
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
      <style>{`
        .viewer-modal { position: fixed; inset: 0; background: rgba(74, 46, 94, 0.7); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 100; }
        .viewer-modal-inner { background: white; border-radius: var(--radius-lg); width: 100%; max-width: 1180px; height: min(92vh, 760px); overflow: hidden; display: grid; grid-template-columns: minmax(0, 1fr) 340px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); position: relative; }
        .viewer-close { position: absolute; top: 12px; right: 12px; width: 36px; height: 36px; border-radius: 50%; background: white; color: var(--color-pink-600); border: none; font-size: 1.5rem; cursor: pointer; line-height: 1; z-index: 3; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        .viewer-stage { position: relative; background: var(--color-cream); min-height: 320px; }
        .viewer-canvas { display: block; width: 100%; height: 100%; }
        .viewer-error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--color-pink-600); font-weight: 600; padding: 20px; text-align: center; }
        .stage-tools { position: absolute; left: 12px; bottom: 12px; display: flex; gap: 8px; align-items: center; background: rgba(255,255,255,0.85); padding: 6px 10px; border-radius: var(--radius-pill); font-size: 0.82rem; }
        .tool { display: flex; gap: 4px; align-items: center; color: var(--color-ink); }
        .tool-select { font: inherit; font-size: 0.82rem; border-radius: 6px; border: 1px solid var(--color-purple-100); padding: 2px 6px; }
        .tool-btn { font: inherit; font-size: 0.82rem; background: var(--color-purple-50); color: var(--color-purple-600); border: 1px solid var(--color-purple-100); border-radius: var(--radius-pill); padding: 3px 10px; cursor: pointer; }
        .viewer-side { padding: 18px 20px 24px; border-left: 1px solid var(--color-pink-100); background: var(--surface-strong); overflow: auto; }
        .viewer-side h3 { margin: 0 24px 2px 0; color: var(--color-ink); font-size: 1.15rem; word-break: break-all; }
        .viewer-side h4 { margin: 18px 0 8px; color: var(--color-purple-600); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.04em; }
        .side-sub { margin: 0 0 4px; color: var(--color-ink-soft); font-size: 0.85rem; }
        .side-src { margin: 0 0 12px; font-size: 0.75rem; word-break: break-all; }
        .side-src code { background: var(--color-purple-50); padding: 1px 6px; border-radius: 4px; }
        .side-actions { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
        .dl { display: inline-block; padding: 8px 14px; border-radius: var(--radius-pill); background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400)); color: white; font-weight: 700; font-size: 0.85rem; text-decoration: none; text-align: center; }
        .dl-note { font-size: 0.72rem; color: var(--color-ink-soft); }
        .aliases { font-size: 0.8rem; margin-bottom: 6px; }
        .alias-list { margin: 4px 0 0; color: var(--color-ink-soft); font-size: 0.75rem; line-height: 1.4; }
        .link-btn { background: none; border: none; padding: 0; color: var(--color-purple-600); font: inherit; font-size: 0.8rem; cursor: pointer; text-decoration: underline; }
        .side-note { font-size: 0.8rem; color: var(--color-ink-soft); }
        .slot-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .slot { border: 1px solid var(--color-pink-100); border-radius: var(--radius-md); background: white; padding: 6px 8px; }
        .slot-head { display: flex; align-items: center; gap: 10px; width: 100%; background: none; border: none; padding: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
        .slot-head:disabled { cursor: default; }
        .swatch-box { width: 44px; height: 44px; flex: none; border-radius: 6px; background: repeating-conic-gradient(#f0eaff 0% 25%, #ffffff 0% 50%) 0 / 10px 10px; display: flex; align-items: center; justify-content: center; overflow: hidden; border: 1px solid var(--color-purple-100); }
        .swatch-box img { max-width: 44px; max-height: 44px; image-rendering: pixelated; }
        .swatch-empty { font-size: 0.65rem; color: var(--color-ink-soft); }
        .slot-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
        .slot-name { font-weight: 700; font-size: 0.85rem; color: var(--color-ink); }
        .slot-meta { font-size: 0.72rem; color: var(--color-ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .slot-caret { color: var(--color-purple-400); }
        .slot-dl { display: flex; gap: 10px; margin: 4px 0 0 54px; font-size: 0.72rem; }
        .slot-dl a { color: var(--color-purple-600); }
        .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); gap: 4px; margin-top: 8px; max-height: 260px; overflow: auto; padding: 4px; background: var(--color-purple-50); border-radius: 8px; }
        .swatch { padding: 2px; border: 2px solid transparent; border-radius: 6px; background: white; cursor: pointer; height: 46px; display: flex; align-items: center; justify-content: center; }
        .swatch img { max-width: 36px; max-height: 38px; image-rendering: pixelated; }
        .swatch-active { border-color: var(--color-pink-400); }
        @media (max-width: 860px) {
          .viewer-modal-inner { grid-template-columns: 1fr; grid-template-rows: minmax(260px, 45%) 1fr; height: 94vh; }
          .viewer-side { border-left: none; border-top: 1px solid var(--color-pink-100); }
        }
      `}</style>
    </div>,
    document.body
  );
}
