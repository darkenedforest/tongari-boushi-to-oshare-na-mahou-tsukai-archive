import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase, supabaseConfigured, GUESTBOOK_BUCKET, getOrCreateSession } from '../lib/supabase';
import assets from '../data/guestbook_assets.json';

// ── Card geometry ────────────────────────────────────────────────────
// The card is a 2x DS screen. The drawing layer is a chunky pixel grid
// (each cell is 4 card-px), Piskel-style. Cards are saved as 2x PNGs.
const CARD_W = 512;
const CARD_H = 384;
const PIX_W = 128;
const PIX_H = 96;
const CELL = CARD_W / PIX_W; // 4
const SAVE_SCALE = 2;
const STAMP_BASE = 64; // stamp display size in card-px at scale 1 (32px art doubled)
const UNDO_DEPTH = 25;
const MAX_AUTHOR = 40;

// DB32 pixel-art palette + the site's own pastels.
const PALETTE = [
  '#000000', '#222034', '#45283c', '#663931', '#8f563b', '#df7126', '#d9a066', '#eec39a',
  '#fbf236', '#99e550', '#6abe30', '#37946e', '#4b692f', '#524b24', '#323c39', '#3f3f74',
  '#306082', '#5b6ee1', '#639bff', '#5fcde4', '#cbdbfc', '#ffffff', '#9badb7', '#847e87',
  '#696a6a', '#595652', '#76428a', '#ac3232', '#d95763', '#d77bba', '#8f974a', '#8a6f30',
  '#ff7eb6', '#e93f8e', '#ffd6e7', '#9b7bd9', '#cab3ff', '#5fa9ee', '#cce8ff', '#fff8ee',
];

// Plain "paper" background colors offered alongside the game-art backgrounds.
const PAPERS = ['#ffffff', '#fff0f6', '#f5f0ff', '#eaf6ff', '#fff8ee', '#e8f8e8', '#4a2e5e'];

const TEXT_DEFAULT_SIZE = 26;
const TEXT_MIN_SIZE = 10;
const TEXT_MAX_SIZE = 120;

type Tool = 'draw' | 'erase' | 'fill' | 'line' | 'select';

interface StampEl {
  kind: 'stamp';
  id: number;
  src: string;
  x: number;
  y: number;
  scale: number;
  rot: number; // radians
}

interface TextEl {
  kind: 'text';
  id: number;
  text: string;
  x: number;
  y: number;
  color: string;
  size: number; // px at card scale
  rot: number;
}

type El = StampEl | TextEl;

interface CardRow {
  id: number;
  author: string | null;
  image_url: string;
  heart_count: number;
  created_at: string;
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function authorOrAnon(s: string | null | undefined): string {
  return (s || '').trim() || 'Anonymous';
}

let nextId = 1;

// ── The card editor ──────────────────────────────────────────────────

function CardEditor({ base, onClose, onPosted }: {
  base: string;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [tool, setTool] = useState<Tool>('draw');
  const [color, setColor] = useState('#e93f8e');
  const [brush, setBrush] = useState(2);
  const [bg, setBg] = useState<string | null>(null); // asset src or css color or null
  const [soften, setSoften] = useState(true);
  const [panel, setPanel] = useState(true);
  const [els, setEls] = useState<El[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawer, setDrawer] = useState<'stamps' | 'bg' | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [savePreview, setSavePreview] = useState<string | null>(null);
  const [saveBlob, setSaveBlob] = useState<Blob | null>(null);
  const [author, setAuthor] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stageW, setStageW] = useState(CARD_W);

  const pixCanvas = useRef<HTMLCanvasElement>(null);
  const undoStack = useRef<ImageData[]>([]);
  const holderRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const lastCell = useRef<{ x: number; y: number } | null>(null);
  // Line tool: anchor cell + canvas snapshot so the preview can redraw
  // from the anchor to the cursor on every move.
  const lineStart = useRef<{ x: number; y: number } | null>(null);
  const lineSnapshot = useRef<ImageData | null>(null);
  // Only one pointer drives the editor at a time — a second touch (thumb,
  // palm) must not corrupt the stroke or gesture in progress.
  const activePointer = useRef<number | null>(null);
  const measureCanvas = useRef<CanvasRenderingContext2D | null>(null);
  // Gesture state for element drag / resize / rotate.
  const gesture = useRef<{
    mode: 'move' | 'resize' | 'rotate';
    id: number;
    startX: number; startY: number;
    elX: number; elY: number;
    startDist: number; startScale: number;
    startAngle: number; startRot: number;
  } | null>(null);

  const selected = els.find((e) => e.id === selectedId) || null;
  const isPaperBg = bg !== null && bg.startsWith('#');
  const isImageBg = bg !== null && !bg.startsWith('#');

  // Scale the fixed-size card to the available width.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const ro = new ResizeObserver(() => {
      setStageW(Math.min(CARD_W, holder.clientWidth));
    });
    ro.observe(holder);
    return () => ro.disconnect();
  }, []);
  const stageScale = stageW / CARD_W;

  // Lock body scroll while the editor overlay is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Each composed preview is a blob URL; revoke the old one when it's
  // replaced and the last one on unmount.
  useEffect(() => {
    return () => { if (savePreview) URL.revokeObjectURL(savePreview); };
  }, [savePreview]);

  // Close the color pop-out when clicking anywhere else.
  useEffect(() => {
    if (!paletteOpen) return;
    const onDocDown = (e: PointerEvent) => {
      if (!(e.target as Element)?.closest?.('.gb-color-wrap')) setPaletteOpen(false);
    };
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, [paletteOpen]);

  // Losing window focus mid-stroke can swallow the pointerup — drop any
  // in-flight gesture so the editor never comes back wedged.
  useEffect(() => {
    const clear = () => {
      activePointer.current = null;
      lastCell.current = null;
      gesture.current = null;
      lineStart.current = null;
      lineSnapshot.current = null;
    };
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);

  function pixCtx(): CanvasRenderingContext2D | null {
    return pixCanvas.current?.getContext('2d', { willReadFrequently: true }) || null;
  }

  function pushUndo() {
    const ctx = pixCtx();
    if (!ctx) return;
    undoStack.current.push(ctx.getImageData(0, 0, PIX_W, PIX_H));
    if (undoStack.current.length > UNDO_DEPTH) undoStack.current.shift();
    setCanUndo(true);
  }

  function undo() {
    const ctx = pixCtx();
    const snap = undoStack.current.pop();
    if (ctx && snap) ctx.putImageData(snap, 0, 0);
    setCanUndo(undoStack.current.length > 0);
  }

  function clearDrawing() {
    const ctx = pixCtx();
    if (!ctx) return;
    pushUndo();
    ctx.clearRect(0, 0, PIX_W, PIX_H);
  }

  function paintCell(cx: number, cy: number) {
    const ctx = pixCtx();
    if (!ctx) return;
    const half = Math.floor(brush / 2);
    const x = cx - half;
    const y = cy - half;
    if (tool === 'erase') {
      ctx.clearRect(x, y, brush, brush);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, brush, brush);
    }
  }

  function floodFill(cx: number, cy: number) {
    const ctx = pixCtx();
    if (!ctx || cx < 0 || cy < 0 || cx >= PIX_W || cy >= PIX_H) return;
    const img = ctx.getImageData(0, 0, PIX_W, PIX_H);
    const d = img.data;
    const at = (x: number, y: number) => (y * PIX_W + x) * 4;
    const t = at(cx, cy);
    const target = [d[t], d[t + 1], d[t + 2], d[t + 3]];
    // Parse the fill color to RGBA.
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.fillStyle = color;
    const hex = probe.fillStyle as string; // normalized #rrggbb
    const fill = [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
      255,
    ];
    if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === fill[3]) return;
    pushUndo();
    const stack = [[cx, cy]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      if (x < 0 || y < 0 || x >= PIX_W || y >= PIX_H) continue;
      const i = at(x, y);
      if (d[i] !== target[0] || d[i + 1] !== target[1] || d[i + 2] !== target[2] || d[i + 3] !== target[3]) continue;
      d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = fill[3];
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    ctx.putImageData(img, 0, 0);
  }

  function paintLine(from: { x: number; y: number }, to: { x: number; y: number }) {
    // Bresenham so fast strokes don't leave gaps.
    let x0 = from.x, y0 = from.y;
    const x1 = to.x, y1 = to.y;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) {
      paintCell(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
  }

  function textWidth(text: string, size: number): number {
    if (!measureCanvas.current) {
      measureCanvas.current = document.createElement('canvas').getContext('2d');
    }
    const ctx = measureCanvas.current;
    if (!ctx) return Math.max(24, text.length * size * 0.64);
    ctx.font = `${size}px 'DotGothic16', monospace`;
    return ctx.measureText(text).width;
  }

  function cardPoint(e: React.PointerEvent): { x: number; y: number } {
    const rect = cardRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / stageScale,
      y: (e.clientY - rect.top) / stageScale,
    };
  }

  function hitTest(p: { x: number; y: number }): El | null {
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      // An emptied-out text element is invisible — don't let it swallow clicks.
      if (el.kind === 'text' && !el.text.trim()) continue;
      // Transform the point into the element's local (unrotated) space.
      const dx = p.x - el.x;
      const dy = p.y - el.y;
      const cos = Math.cos(-el.rot);
      const sin = Math.sin(-el.rot);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      let hw: number, hh: number;
      if (el.kind === 'stamp') {
        hw = hh = (STAMP_BASE * el.scale) / 2;
      } else {
        hw = Math.max(24, textWidth(el.text, el.size) / 2);
        hh = el.size * 0.75;
      }
      if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) return el;
    }
    return null;
  }

  function onPointerDown(e: React.PointerEvent) {
    if (saveOpen) return;
    if (e.button !== 0) return; // left click / touch / pen only
    if (activePointer.current !== null) {
      // A different pointer while one is mid-gesture: that's a second
      // finger — ignore it. The SAME pointer pressing again means its
      // pointerup got lost (alt-tab, popup, focus steal): the lock is
      // stale, so reset it and let this press through. Without this a
      // single lost release would disable drawing forever.
      if (activePointer.current !== e.pointerId) return;
      activePointer.current = null;
      lastCell.current = null;
      gesture.current = null;
    }
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // Capture can throw (e.g. the pointer vanished) — the gesture still
      // works uncaptured, so never let this wedge the editor.
    }
    const p = cardPoint(e);
    if (tool === 'fill') {
      floodFill(Math.floor(p.x / CELL), Math.floor(p.y / CELL));
      return;
    }
    if (tool === 'line') {
      const ctx = pixCtx();
      if (!ctx) return;
      activePointer.current = e.pointerId;
      pushUndo();
      lineSnapshot.current = ctx.getImageData(0, 0, PIX_W, PIX_H);
      const cell = { x: Math.floor(p.x / CELL), y: Math.floor(p.y / CELL) };
      lineStart.current = cell;
      paintCell(cell.x, cell.y);
      return;
    }
    if (tool === 'draw' || tool === 'erase') {
      activePointer.current = e.pointerId;
      pushUndo();
      const cell = { x: Math.floor(p.x / CELL), y: Math.floor(p.y / CELL) };
      paintCell(cell.x, cell.y);
      lastCell.current = cell;
      return;
    }
    // select tool
    const hit = hitTest(p);
    if (!hit) {
      setSelectedId(null);
      return;
    }
    activePointer.current = e.pointerId;
    setSelectedId(hit.id);
    // Bring to front.
    setEls((prev) => [...prev.filter((el) => el.id !== hit.id), hit]);
    gesture.current = {
      mode: 'move', id: hit.id,
      startX: p.x, startY: p.y, elX: hit.x, elY: hit.y,
      startDist: 0, startScale: hit.kind === 'stamp' ? hit.scale : 1,
      startAngle: 0, startRot: hit.rot,
    };
  }

  function startHandleGesture(e: React.PointerEvent, mode: 'resize' | 'rotate') {
    e.stopPropagation();
    if (!selected) return;
    if (e.button !== 0) return;
    if (activePointer.current !== null) {
      if (activePointer.current !== e.pointerId) return;
      // Same pointer pressing again — the previous release was lost.
      lastCell.current = null;
      gesture.current = null;
    }
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // See onPointerDown — an uncaptured gesture still works.
    }
    activePointer.current = e.pointerId;
    const p = cardPoint(e);
    gesture.current = {
      mode, id: selected.id,
      startX: p.x, startY: p.y, elX: selected.x, elY: selected.y,
      startDist: Math.max(8, Math.hypot(p.x - selected.x, p.y - selected.y)),
      startScale: selected.kind === 'stamp' ? selected.scale : selected.size,
      startAngle: Math.atan2(p.y - selected.y, p.x - selected.x),
      startRot: selected.rot,
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    if (saveOpen) return;
    if (activePointer.current !== null && e.pointerId !== activePointer.current) return;
    if (tool === 'line') {
      const ctx = pixCtx();
      if (!ctx || !lineStart.current || !lineSnapshot.current) return;
      if (e.buttons === 0) {
        // Lost release mid-line — abort the preview.
        ctx.putImageData(lineSnapshot.current, 0, 0);
        lineStart.current = null;
        lineSnapshot.current = null;
        activePointer.current = null;
        return;
      }
      const p = cardPoint(e);
      const cell = {
        x: Math.max(0, Math.min(PIX_W - 1, Math.floor(p.x / CELL))),
        y: Math.max(0, Math.min(PIX_H - 1, Math.floor(p.y / CELL))),
      };
      ctx.putImageData(lineSnapshot.current, 0, 0);
      paintLine(lineStart.current, cell);
      return;
    }
    if (tool === 'draw' || tool === 'erase') {
      if (!lastCell.current) return;
      if (e.buttons === 0) {
        // Button released outside our notice (e.g. a native context menu
        // swallowed the pointerup) — stop the stroke instead of smearing.
        lastCell.current = null;
        activePointer.current = null;
        return;
      }
      const p = cardPoint(e);
      const cell = {
        x: Math.max(0, Math.min(PIX_W - 1, Math.floor(p.x / CELL))),
        y: Math.max(0, Math.min(PIX_H - 1, Math.floor(p.y / CELL))),
      };
      paintLine(lastCell.current, cell);
      lastCell.current = cell;
      return;
    }
    const g = gesture.current;
    if (!g) return;
    const p = cardPoint(e);
    setEls((prev) => prev.map((el) => {
      if (el.id !== g.id) return el;
      if (g.mode === 'move') {
        return {
          ...el,
          x: Math.max(0, Math.min(CARD_W, g.elX + (p.x - g.startX))),
          y: Math.max(0, Math.min(CARD_H, g.elY + (p.y - g.startY))),
        };
      }
      if (g.mode === 'resize') {
        const dist = Math.max(8, Math.hypot(p.x - el.x, p.y - el.y));
        const ratio = dist / g.startDist;
        if (el.kind === 'stamp') {
          return { ...el, scale: Math.max(0.4, Math.min(7, g.startScale * ratio)) };
        }
        return {
          ...el,
          size: Math.max(TEXT_MIN_SIZE, Math.min(TEXT_MAX_SIZE, g.startScale * ratio)),
        };
      }
      if (g.mode === 'rotate') {
        const ang = Math.atan2(p.y - el.y, p.x - el.x);
        return { ...el, rot: g.startRot + (ang - g.startAngle) };
      }
      return el;
    }));
  }

  function onPointerUp(e: React.PointerEvent) {
    if (activePointer.current !== null && e.pointerId !== activePointer.current) return;
    activePointer.current = null;
    lastCell.current = null;
    gesture.current = null;
    lineStart.current = null;
    lineSnapshot.current = null;
  }

  function addStamp(src: string) {
    const el: StampEl = {
      kind: 'stamp', id: nextId++, src,
      x: CARD_W / 2 + (Math.random() * 60 - 30),
      y: CARD_H / 2 + (Math.random() * 40 - 20),
      scale: 1.4, rot: 0,
    };
    setEls((prev) => [...prev, el]);
    setSelectedId(el.id);
    setTool('select');
    setDrawer(null);
  }

  function addText() {
    const el: TextEl = {
      kind: 'text', id: nextId++, text: 'hello ✦',
      x: CARD_W / 2, y: CARD_H / 2,
      color, size: TEXT_DEFAULT_SIZE, rot: 0,
    };
    setEls((prev) => [...prev, el]);
    setSelectedId(el.id);
    setTool('select');
  }

  function updateSelected(patch: Partial<Omit<StampEl, 'kind'>> & Partial<Omit<TextEl, 'kind'>>) {
    setEls((prev) => prev.map((el) => (el.id === selectedId ? { ...el, ...patch } as El : el)));
  }

  function deleteSelected() {
    setEls((prev) => prev.filter((el) => el.id !== selectedId));
    setSelectedId(null);
  }

  async function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    });
  }

  // Flatten every layer into a PNG at 2x.
  async function composeCard(): Promise<Blob> {
    // Load the exact glyphs the card uses — DotGothic16 ships in unicode-range
    // slices, and warming only the latin slice would bake fallback glyphs for
    // Japanese (or ✦) into the saved PNG.
    const allText = els
      .filter((e): e is TextEl => e.kind === 'text')
      .map((e) => e.text)
      .join('') || ' ';
    // One load is enough: face loading is size-independent, only the
    // glyph coverage (second argument) matters.
    await document.fonts.load(`${TEXT_DEFAULT_SIZE * SAVE_SCALE}px 'DotGothic16'`, allText).catch(() => {});
    const W = CARD_W * SAVE_SCALE;
    const H = CARD_H * SAVE_SCALE;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    // Background
    ctx.fillStyle = isPaperBg ? bg! : '#ffffff';
    ctx.fillRect(0, 0, W, H);
    if (isImageBg) {
      const img = await loadImage(`${base}${bg}`);
      // Cover-crop to the card (the editor shows the bg with
      // object-fit: cover) — plain drawImage would stretch any
      // background that isn't exactly 4:3.
      const s = Math.max(W / img.width, H / img.height);
      const dw = img.width * s;
      const dh = img.height * s;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    if (isImageBg && soften) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(0, 0, W, H);
    }
    if (panel) {
      const inset = 28 * SAVE_SCALE;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(inset, inset, W - inset * 2, H - inset * 2);
      ctx.strokeStyle = 'rgba(155,123,217,0.55)';
      ctx.lineWidth = 2 * SAVE_SCALE;
      ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
    }

    // Pixel drawing layer
    if (pixCanvas.current) {
      ctx.drawImage(pixCanvas.current, 0, 0, W, H);
    }

    // Stamps + text, in z order
    for (const el of els) {
      if (el.kind === 'text' && !el.text.trim()) continue;
      ctx.save();
      ctx.translate(el.x * SAVE_SCALE, el.y * SAVE_SCALE);
      ctx.rotate(el.rot);
      if (el.kind === 'stamp') {
        const img = await loadImage(`${base}${el.src}`);
        const size = STAMP_BASE * el.scale * SAVE_SCALE;
        ctx.drawImage(img, -size / 2, -size / 2, size, size);
      } else {
        ctx.font = `${el.size * SAVE_SCALE}px 'DotGothic16', monospace`;
        ctx.fillStyle = el.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(el.text, 0, 0);
      }
      ctx.restore();
    }

    return new Promise((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render the card.'))), 'image/png');
    });
  }

  async function openSave() {
    setErr(null);
    try {
      const blob = await composeCard();
      setSaveBlob(blob);
      setSavePreview(URL.createObjectURL(blob));
      setSaveOpen(true);
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }

  async function post() {
    setErr(null);
    if (honeypot) return; // bot
    if (!supabaseConfigured || !supabase) {
      setErr("The guest book backend isn't configured in this build.");
      return;
    }
    const last = Number(localStorage.getItem('tongari-guestbook-last') || 0);
    if (Date.now() - last < 2 * 60 * 1000) {
      setErr('You just posted a card — give it a couple of minutes before another one.');
      return;
    }
    if (!saveBlob) return;
    setBusy(true);
    try {
      const path = `${new Date().getFullYear()}/${crypto.randomUUID()}.png`;
      const { error: upErr } = await supabase.storage
        .from(GUESTBOOK_BUCKET)
        .upload(path, saveBlob, { contentType: 'image/png', cacheControl: '31536000' });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from(GUESTBOOK_BUCKET).getPublicUrl(path);
      if (!pub?.publicUrl) throw new Error('No public URL returned.');
      const { error: insErr } = await supabase.from('guestbook_cards').insert({
        author: author.trim() ? author.trim().slice(0, MAX_AUTHOR) : null,
        image_url: pub.publicUrl,
      });
      if (insErr) throw insErr;
      localStorage.setItem('tongari-guestbook-last', String(Date.now()));
      onPosted();
      onClose();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const stampSrc = (src: string) => `${base}${src}`;

  // Portal to <body>: the page wraps content in a `.container` with
  // z-index:1, which traps any overlay in a stacking context BELOW the
  // sticky site header (z-index:50) — the header would invisibly cover
  // the editor's top toolbar and swallow clicks on Draw/Erase/Move.
  return createPortal(
    <div className="gb-editor" role="dialog" aria-label="Card editor">
      <div className="gb-editor-frame">
        <header className="gb-editor-head">
          <h2>Make your guest book card ✦</h2>
          <button className="gb-close" onClick={onClose} aria-label="Close editor">×</button>
        </header>

        <div className="gb-editor-body">
          {/* ── Toolbar ── */}
          <div className="gb-tools">
            <div className="gb-tool-row">
              <button className={`gb-tool ${tool === 'draw' ? 'on' : ''}`} onClick={() => setTool('draw')}>✏️ Draw</button>
              <button className={`gb-tool ${tool === 'erase' ? 'on' : ''}`} onClick={() => setTool('erase')}>🧽 Erase</button>
              <button className={`gb-tool ${tool === 'fill' ? 'on' : ''}`} onClick={() => setTool('fill')}>🪣 Fill</button>
              <button className={`gb-tool ${tool === 'line' ? 'on' : ''}`} onClick={() => setTool('line')}>📏 Line</button>
              <button className={`gb-tool ${tool === 'select' ? 'on' : ''}`} onClick={() => setTool('select')}>👆 Move</button>
            </div>
            <div className="gb-tool-row">
              <button className="gb-tool" onClick={addText}>🔤 Text</button>
              <button className={`gb-tool ${drawer === 'stamps' ? 'on' : ''}`} onClick={() => setDrawer(drawer === 'stamps' ? null : 'stamps')}>🍄 Stamps</button>
              <button className={`gb-tool ${drawer === 'bg' ? 'on' : ''}`} onClick={() => setDrawer(drawer === 'bg' ? null : 'bg')}>🏰 Background</button>
            </div>
            <div className="gb-tool-row">
              <button className="gb-tool" onClick={undo} disabled={!canUndo}>↩️ Undo drawing</button>
              <button className="gb-tool" onClick={clearDrawing}>🗑️ Clear drawing</button>
            </div>

            <div className="gb-sub">
              <span className="gb-sub-label">Brush</span>
              {[1, 2, 3].map((b) => (
                <button
                  key={b}
                  className={`gb-brush ${brush === b ? 'on' : ''}`}
                  onClick={() => setBrush(b)}
                  aria-label={`Brush size ${b}`}
                >
                  <span style={{ width: b * 4, height: b * 4 }} />
                </button>
              ))}
              <span className="gb-sub-label gb-color-label">Color</span>
              <div className="gb-color-wrap">
                <button
                  className="gb-color-chip"
                  style={{ background: color }}
                  onClick={() => setPaletteOpen((o) => !o)}
                  aria-label="Choose color"
                  aria-expanded={paletteOpen}
                >
                  <span className="gb-color-caret" aria-hidden>▾</span>
                </button>
                {paletteOpen && (
                  <div className="gb-palette-pop">
                    <div className="gb-palette" role="listbox" aria-label="Colors">
                      {PALETTE.map((c) => (
                        <button
                          key={c}
                          className={`gb-swatch ${color === c ? 'on' : ''}`}
                          style={{ background: c }}
                          onClick={() => {
                            setColor(c);
                            setPaletteOpen(false);
                            if (selected?.kind === 'text' && tool === 'select') {
                              // Recoloring the selected text — stay in Move.
                              updateSelected({ color: c });
                            } else if (tool === 'erase' || tool === 'select') {
                              // Picking a color means "I want to draw with it".
                              setTool('draw');
                            }
                          }}
                          aria-label={`Color ${c}`}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {selected && (
              <div className="gb-selected">
                <span className="gb-sub-label">
                  {selected.kind === 'stamp' ? 'Selected stamp' : 'Selected text'}
                </span>
                {selected.kind === 'text' && (
                  <>
                    <input
                      className="gb-text-input"
                      type="text"
                      value={selected.text}
                      maxLength={60}
                      onChange={(e) => updateSelected({ text: e.target.value })}
                    />
                    <p className="gb-hint">
                      Drag the ⤡ handle on the card to resize. Pick a palette
                      color to recolor this text.
                    </p>
                  </>
                )}
                <button className="gb-tool small danger" onClick={deleteSelected}>Delete</button>
              </div>
            )}

            {isImageBg && (
              <div className="gb-sub gb-bg-opts">
                <label><input type="checkbox" checked={soften} onChange={(e) => setSoften(e.target.checked)} /> Soften background</label>
                <label><input type="checkbox" checked={panel} onChange={(e) => setPanel(e.target.checked)} /> Writing panel</label>
              </div>
            )}
            {!isImageBg && (
              <div className="gb-sub gb-bg-opts">
                <label><input type="checkbox" checked={panel} onChange={(e) => setPanel(e.target.checked)} /> Writing panel</label>
              </div>
            )}
          </div>

          {/* ── Card stage ── */}
          <div className="gb-stage" ref={holderRef}>
            <div
              className="gb-stage-holder"
              style={{ width: stageW, height: stageW * (CARD_H / CARD_W) }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div
                ref={cardRef}
                className={`gb-card-surface ${tool !== 'select' ? 'drawing' : ''}`}
                style={{ transform: `scale(${stageScale})` }}
              >
                <div
                  className="gb-layer gb-bg-layer"
                  style={{ background: isPaperBg ? bg! : '#ffffff' }}
                >
                  {isImageBg && <img src={stampSrc(bg!)} alt="" draggable={false} />}
                </div>
                {isImageBg && soften && <div className="gb-layer gb-soften" />}
                {panel && <div className="gb-panel-box" />}
                <canvas
                  ref={pixCanvas}
                  className="gb-layer gb-pix"
                  width={PIX_W}
                  height={PIX_H}
                />
                {els.map((el) => (
                  <div
                    key={el.id}
                    className="gb-el"
                    style={{
                      left: el.x,
                      top: el.y,
                      transform: `translate(-50%, -50%) rotate(${el.rot}rad)`,
                    }}
                  >
                    {el.kind === 'stamp' ? (
                      <img
                        src={stampSrc(el.src)}
                        alt=""
                        draggable={false}
                        style={{ width: STAMP_BASE * el.scale, height: STAMP_BASE * el.scale }}
                      />
                    ) : (
                      <span
                        className="gb-el-text"
                        style={{ color: el.color, fontSize: el.size }}
                      >
                        {el.text}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {/* Handles live OUTSIDE the overflow:hidden card so they stay
                  reachable when the element sits near a card edge. */}
              {selected && tool === 'select' && (
                <div
                  className="gb-handles-layer"
                  style={{ transform: `scale(${stageScale})` }}
                >
                  <div
                    className="gb-handles"
                    style={{
                      left: selected.x,
                      top: selected.y,
                      transform: `translate(-50%, -50%) rotate(${selected.rot}rad)`,
                      width: selected.kind === 'stamp'
                        ? STAMP_BASE * selected.scale + 16
                        : Math.max(64, textWidth(selected.text, selected.size)) + 16,
                      height: selected.kind === 'stamp'
                        ? STAMP_BASE * selected.scale + 16
                        : selected.size * 1.6 + 16,
                    }}
                  >
                    <button
                      className="gb-handle gb-handle-rotate"
                      onPointerDown={(e) => startHandleGesture(e, 'rotate')}
                      aria-label="Rotate"
                    >↻</button>
                    <button
                      className="gb-handle gb-handle-resize"
                      onPointerDown={(e) => startHandleGesture(e, 'resize')}
                      aria-label="Resize"
                    >⤡</button>
                  </div>
                </div>
              )}
            </div>
            <p className="gb-stage-hint">
              {tool === 'select'
                ? 'Tap a stamp or text to select it — drag to move, use ↻ to rotate and ⤡ to resize.'
                : 'Draw on the card! Switch to Move to arrange stamps and text.'}
            </p>
            <div className="gb-actions">
              <button className="gb-post" onClick={openSave}>Sign the guest book ✦</button>
            </div>
            {err && !saveOpen && <p className="gb-err">{err}</p>}
          </div>

          {/* ── Drawers ── */}
          {drawer === 'stamps' && (
            <div className="gb-drawer">
              <h3>Stamps</h3>
              <div className="gb-stamp-grid">
                {(assets.stamps as { src: string }[]).map((s) => (
                  <button key={s.src} className="gb-stamp-pick" onClick={() => addStamp(s.src)}>
                    <img src={stampSrc(s.src)} alt="" loading="lazy" draggable={false} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {drawer === 'bg' && (
            <div className="gb-drawer">
              <h3>Background</h3>
              <div className="gb-bg-grid">
                <button
                  className={`gb-bg-pick paper ${bg === null ? 'on' : ''}`}
                  onClick={() => setBg(null)}
                  style={{ background: '#fff' }}
                >None</button>
                {PAPERS.map((c) => (
                  <button
                    key={c}
                    className={`gb-bg-pick paper ${bg === c ? 'on' : ''}`}
                    onClick={() => setBg(c)}
                    style={{ background: c }}
                    aria-label={`Paper ${c}`}
                  />
                ))}
                {(assets.backgrounds as { src: string; label: string }[]).map((b) => (
                  <button
                    key={b.src}
                    className={`gb-bg-pick ${bg === b.src ? 'on' : ''}`}
                    onClick={() => setBg(b.src)}
                    title={b.label}
                  >
                    <img src={stampSrc(b.src)} alt={b.label} loading="lazy" draggable={false} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Save dialog ── */}
      {saveOpen && (
        <div className="gb-save-overlay">
          <div className="gb-save-box">
            <h3>Ready to sign? ✦</h3>
            {savePreview && <img className="gb-save-preview" src={savePreview} alt="Your card" />}
            <label className="gb-field">
              <span>Your name (optional)</span>
              <input
                type="text"
                value={author}
                maxLength={MAX_AUTHOR}
                placeholder="Anonymous"
                onChange={(e) => setAuthor(e.target.value)}
              />
            </label>
            <label className="gb-hp" aria-hidden="true">
              Website (leave blank)
              <input type="text" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} tabIndex={-1} autoComplete="off" />
            </label>
            {err && <p className="gb-err">{err}</p>}
            <div className="gb-save-actions">
              <button className="gb-tool" onClick={() => { setSaveOpen(false); setErr(null); }} disabled={busy}>
                Keep editing
              </button>
              <button className="gb-post" onClick={post} disabled={busy || !supabaseConfigured}>
                {busy ? 'Posting…' : 'Post my card'}
              </button>
            </div>
            {!supabaseConfigured && (
              <p className="gb-hint">The backend isn't configured in this build, so posting is disabled.</p>
            )}
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}

// ── Heart button (same pattern as the bug board's Me too) ────────────

function HeartButton({ card }: { card: CardRow }) {
  const session = getOrCreateSession();
  const localKey = `gbheart-${card.id}`;
  const [pressed, setPressed] = useState<boolean>(() =>
    typeof window !== 'undefined' && localStorage.getItem(localKey) === '1'
  );
  const [count, setCount] = useState(card.heart_count);
  const [busy, setBusy] = useState(false);

  async function press() {
    if (pressed || busy || !supabaseConfigured || !supabase) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('guestbook_hearts')
        .insert({ card_id: card.id, session_id: session });
      if (error && error.code !== '23505') throw error;
      setPressed(true);
      setCount((c) => c + 1);
      localStorage.setItem(localKey, '1');
    } catch {
      // ignore for MVP
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={`gb-heart ${pressed ? 'pressed' : ''}`}
      onClick={press}
      disabled={pressed || busy}
      title={pressed ? 'You hearted this card' : 'Heart this card'}
    >
      {pressed ? '💖' : '🤍'} <span>{count}</span>
    </button>
  );
}

// ── The guest book board ─────────────────────────────────────────────

export default function GuestbookBoard() {
  const base = (import.meta.env.BASE_URL as string).replace(/\/$/, '');
  const [cards, setCards] = useState<CardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [lightbox, setLightbox] = useState<CardRow | null>(null);
  const [posted, setPosted] = useState(false);

  async function load() {
    if (!supabaseConfigured || !supabase) {
      setLoading(false);
      setErr('not_configured');
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from('guestbook_cards')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      setErr(error.message);
    } else {
      setCards((data as CardRow[]) || []);
      setErr(null);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const signButton = (
    <button className="gb-sign-btn" onClick={() => setEditorOpen(true)}>
      <span aria-hidden>💌</span> Sign the guest book <span aria-hidden>✦</span>
    </button>
  );

  return (
    <div className="gb-board">
      <div className="gb-board-head">
        {signButton}
        {posted && <span className="gb-posted">✓ Your card is on the wall!</span>}
        {cards.length > 0 && (
          <span className="gb-count">{cards.length} card{cards.length === 1 ? '' : 's'} so far</span>
        )}
      </div>

      {err === 'not_configured' && (
        <div className="gb-status">
          <p>
            The guest book backend isn't configured for this build yet — but you
            can still open the editor and play with the card maker.
          </p>
        </div>
      )}
      {err && err !== 'not_configured' && (
        <div className="gb-status error">Couldn't load the guest book: {err}</div>
      )}
      {loading && !err && <div className="gb-status">Loading cards…</div>}

      {!loading && !err && cards.length === 0 && (
        <div className="gb-empty">
          <div className="gb-empty-emoji" aria-hidden>💌</div>
          <h3>No cards yet</h3>
          <p>Be the first to sign — draw something, stamp something, say hi.</p>
        </div>
      )}

      <div className="gb-grid">
        {cards.map((c) => (
          <figure key={c.id} className="gb-card-tile">
            <button className="gb-card-open" onClick={() => setLightbox(c)}>
              <img src={c.image_url} alt={`Guest book card by ${authorOrAnon(c.author)}`} loading="lazy" />
            </button>
            <figcaption>
              <span className="gb-author">{authorOrAnon(c.author)}</span>
              <span className="gb-when">{timeAgo(c.created_at)}</span>
              <HeartButton card={c} />
            </figcaption>
          </figure>
        ))}
      </div>

      {lightbox && createPortal(
        <div className="gb-lightbox" onClick={() => setLightbox(null)} role="dialog">
          <button className="gb-lightbox-close" aria-label="Close">×</button>
          <img src={lightbox.image_url} alt={`Guest book card by ${authorOrAnon(lightbox.author)}`} />
        </div>,
        document.body
      )}

      {editorOpen && (
        <CardEditor
          base={base}
          onClose={() => setEditorOpen(false)}
          onPosted={() => { setPosted(true); load(); }}
        />
      )}

      <style>{`
        .gb-board-head {
          display: flex; flex-wrap: wrap; align-items: center; gap: 14px;
          padding: 18px 20px; margin-bottom: 24px;
          background: linear-gradient(135deg, var(--color-pink-50), var(--color-purple-50));
          border: 2px solid var(--color-pink-200); box-shadow: var(--shadow-soft);
        }
        .gb-sign-btn {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 12px 22px; border: none; cursor: pointer;
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; font-family: var(--font-display); font-weight: 700; font-size: 1.05rem;
          box-shadow: var(--shadow-pop);
          transition: transform 0.12s ease;
        }
        .gb-sign-btn:hover { transform: translate(-2px, -2px); }
        .gb-posted { color: #2c8a4a; background: #d9f3df; padding: 6px 12px; font-weight: 700; font-size: 0.85rem; }
        .gb-count { margin-left: auto; color: var(--color-ink-soft); font-size: 0.85rem; }

        .gb-status {
          padding: 40px 20px; text-align: center; color: var(--color-ink-soft);
          background: var(--surface-strong); border: 2px solid var(--color-pink-100);
        }
        .gb-status.error { color: var(--color-pink-600); }

        .gb-empty {
          text-align: center; padding: 60px 20px; background: var(--surface-strong);
          border: 2px solid var(--color-pink-100); box-shadow: var(--shadow-soft);
        }
        .gb-empty-emoji { font-size: 3rem; }
        .gb-empty h3 { color: var(--color-pink-600); margin: 8px 0 6px; }
        .gb-empty p { color: var(--color-ink-soft); margin: 0; }

        .gb-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 18px; margin-top: 18px;
        }
        .gb-card-tile {
          margin: 0; background: var(--surface-strong);
          border: 2px solid var(--color-pink-100); box-shadow: var(--shadow-soft);
          transition: transform 0.12s ease, box-shadow 0.15s ease;
        }
        .gb-card-tile:hover { transform: translate(-2px, -2px); box-shadow: var(--shadow-pop); }
        .gb-card-open { display: block; width: 100%; padding: 0; border: none; background: none; cursor: zoom-in; }
        .gb-card-open img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; image-rendering: pixelated; }
        .gb-card-tile figcaption {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 12px; border-top: 2px solid var(--color-pink-100);
          font-size: 0.85rem;
        }
        .gb-author { color: var(--color-purple-600); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .gb-when { color: var(--color-ink-soft); flex-shrink: 0; }
        .gb-heart {
          margin-left: auto; border: 1px solid var(--color-pink-100); background: white;
          padding: 3px 10px; cursor: pointer; font: inherit; font-size: 0.82rem;
          color: var(--color-ink);
        }
        .gb-heart.pressed { background: var(--color-pink-50); cursor: default; }
        .gb-heart:disabled { opacity: 0.9; }

        .gb-lightbox {
          position: fixed; inset: 0; z-index: 120;
          background: rgba(74, 46, 94, 0.78); backdrop-filter: blur(8px);
          display: flex; align-items: center; justify-content: center;
          padding: 24px; cursor: zoom-out;
        }
        .gb-lightbox img { max-width: 94vw; max-height: 90vh; image-rendering: pixelated; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        .gb-lightbox-close {
          position: absolute; top: 18px; right: 22px; width: 38px; height: 38px;
          background: white; color: var(--color-pink-600); border: none; font-size: 1.5rem; cursor: pointer;
        }

        /* ── Editor overlay ── */
        .gb-editor {
          position: fixed; inset: 0; z-index: 130;
          background: rgba(74, 46, 94, 0.6); backdrop-filter: blur(6px);
          display: flex; align-items: flex-start; justify-content: center;
          overflow-y: auto; padding: 20px 12px 40px;
        }
        .gb-editor-frame {
          width: min(1080px, 100%);
          background: var(--surface-strong);
          border: 2px solid var(--color-pink-200);
          box-shadow: 0 24px 64px rgba(74, 46, 94, 0.4);
        }
        .gb-editor-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 14px 20px;
          background: linear-gradient(120deg, var(--color-pink-100), var(--color-purple-100), var(--color-blue-100));
          border-bottom: 2px solid var(--color-purple-100);
        }
        .gb-editor-head h2 { margin: 0; font-size: 1.25rem; }
        .gb-close {
          width: 34px; height: 34px; border: 1px solid var(--color-pink-200);
          background: white; color: var(--color-pink-600); font-size: 1.3rem;
          cursor: pointer; line-height: 1;
        }

        .gb-editor-body {
          display: grid; grid-template-columns: 240px 1fr; gap: 18px;
          padding: 18px; align-items: start;
        }
        @media (max-width: 860px) {
          .gb-editor-body { grid-template-columns: 1fr; }
        }

        .gb-tools { display: flex; flex-direction: column; gap: 10px; }
        .gb-tool-row { display: flex; flex-wrap: wrap; gap: 6px; }
        .gb-tool {
          padding: 8px 12px; border: 1px solid var(--color-purple-100);
          background: var(--color-purple-50); color: var(--color-purple-600);
          font: inherit; font-size: 0.85rem; font-weight: 700; cursor: pointer;
        }
        .gb-tool:hover:not(:disabled) { background: var(--color-purple-100); }
        .gb-tool.on { background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400)); color: white; border-color: transparent; }
        .gb-tool:disabled { opacity: 0.45; cursor: not-allowed; }
        .gb-tool.small { padding: 5px 10px; font-size: 0.8rem; }
        .gb-tool.danger { background: var(--color-pink-50); color: var(--color-pink-600); border-color: var(--color-pink-200); }

        .gb-sub { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .gb-sub-label { font-size: 0.78rem; font-weight: 700; color: var(--color-ink-soft); text-transform: uppercase; letter-spacing: 0.05em; }
        .gb-brush {
          width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center;
          border: 1px solid var(--color-purple-100); background: white; cursor: pointer;
        }
        .gb-brush span { display: block; background: var(--color-ink); }
        .gb-brush.on { border-color: var(--color-pink-400); background: var(--color-pink-50); }

        .gb-color-label { margin-left: 8px; }
        .gb-color-wrap { position: relative; display: inline-block; }
        .gb-color-chip {
          width: 34px; height: 30px; padding: 0; cursor: pointer;
          border: 2px solid var(--color-purple-200);
          display: inline-flex; align-items: center; justify-content: center;
        }
        .gb-color-caret {
          color: white; font-size: 0.7rem; line-height: 1;
          text-shadow: 0 0 3px rgba(0,0,0,0.7);
        }
        .gb-palette-pop {
          position: absolute; top: 34px; left: 0; z-index: 30;
          width: 216px; padding: 6px;
          background: white; border: 2px solid var(--color-purple-200);
          box-shadow: var(--shadow-pop);
        }
        .gb-palette {
          display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px;
        }
        .gb-swatch {
          aspect-ratio: 1; border: 1px solid rgba(0,0,0,0.18); cursor: pointer; padding: 0;
        }
        .gb-swatch.on { outline: 2px solid var(--color-pink-600); outline-offset: 1px; }

        .gb-selected {
          display: flex; flex-direction: column; gap: 8px;
          padding: 10px; background: var(--color-pink-50); border: 1px dashed var(--color-pink-200);
        }
        .gb-text-input {
          padding: 8px 10px; border: 1px solid var(--color-purple-100); background: white;
          font: inherit; width: 100%;
        }
        .gb-hint { margin: 0; font-size: 0.75rem; color: var(--color-ink-soft); }
        .gb-bg-opts label { display: inline-flex; align-items: center; gap: 6px; font-size: 0.82rem; color: var(--color-ink); font-weight: 600; }

        .gb-stage { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
        .gb-stage-holder { position: relative; margin: 0 auto; }
        .gb-card-surface {
          position: absolute; top: 0; left: 0;
          width: ${CARD_W}px; height: ${CARD_H}px;
          transform-origin: top left;
          border: 2px solid var(--color-purple-200);
          box-shadow: var(--shadow-pop);
          overflow: hidden; touch-action: none;
          background: white;
          user-select: none;
          -webkit-user-select: none;
          -webkit-touch-callout: none;
        }
        .gb-stage-holder { touch-action: none; }
        .gb-handles-layer {
          position: absolute; top: 0; left: 0;
          width: ${CARD_W}px; height: ${CARD_H}px;
          transform-origin: top left;
          pointer-events: none;
          z-index: 5;
        }
        .gb-card-surface.drawing { cursor: crosshair; }
        .gb-layer { position: absolute; inset: 0; }
        .gb-bg-layer img { width: 100%; height: 100%; object-fit: cover; image-rendering: pixelated; display: block; pointer-events: none; }
        .gb-soften { background: rgba(255,255,255,0.55); pointer-events: none; }
        .gb-panel-box {
          position: absolute; inset: 28px;
          background: rgba(255,255,255,0.75);
          border: 2px solid rgba(155,123,217,0.55);
          pointer-events: none;
        }
        .gb-pix { width: 100%; height: 100%; image-rendering: pixelated; pointer-events: none; }
        .gb-el { position: absolute; pointer-events: none; }
        .gb-el img { display: block; image-rendering: pixelated; }
        .gb-el-text {
          font-family: 'DotGothic16', var(--font-body), monospace;
          white-space: nowrap; line-height: 1;
          display: block; transform: translateZ(0);
        }
        .gb-handles {
          position: absolute; pointer-events: none;
          border: 2px dashed var(--color-pink-400);
        }
        .gb-handle {
          position: absolute; width: 26px; height: 26px;
          border: 2px solid var(--color-purple-400); background: white; color: var(--color-purple-600);
          font-size: 0.95rem; line-height: 1; cursor: grab;
          pointer-events: auto; display: flex; align-items: center; justify-content: center;
          border-radius: 50% !important;
        }
        .gb-handle-rotate { top: -34px; left: 50%; transform: translateX(-50%); }
        .gb-handle-resize { bottom: -13px; right: -13px; cursor: nwse-resize; }

        .gb-stage-hint { margin: 0; text-align: center; font-size: 0.82rem; color: var(--color-ink-soft); }
        .gb-actions { display: flex; justify-content: center; }
        .gb-post {
          padding: 12px 26px; border: none; cursor: pointer;
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; font-family: var(--font-display); font-weight: 700; font-size: 1rem;
          box-shadow: var(--shadow-pop);
        }
        .gb-post:disabled { opacity: 0.5; cursor: not-allowed; }
        .gb-err { color: var(--color-pink-600); font-weight: 600; font-size: 0.88rem; text-align: center; }

        .gb-drawer {
          grid-column: 1 / -1;
          background: var(--color-purple-50); border: 2px solid var(--color-purple-100);
          padding: 14px; max-height: 340px; overflow-y: auto;
        }
        .gb-drawer h3 { margin: 0 0 10px; font-size: 1rem; color: var(--color-purple-600); }
        .gb-stamp-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); gap: 6px;
        }
        .gb-stamp-pick {
          aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
          background: white; border: 1px solid var(--color-purple-100); cursor: pointer; padding: 4px;
        }
        .gb-stamp-pick:hover { border-color: var(--color-pink-400); background: var(--color-pink-50); }
        .gb-stamp-pick img { max-width: 100%; max-height: 100%; image-rendering: pixelated; }
        .gb-bg-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px;
        }
        .gb-bg-pick {
          aspect-ratio: 4 / 3; padding: 0; overflow: hidden;
          border: 2px solid var(--color-purple-100); cursor: pointer; background: white;
          font: inherit; font-size: 0.8rem; font-weight: 700; color: var(--color-ink-soft);
        }
        .gb-bg-pick img { width: 100%; height: 100%; object-fit: cover; image-rendering: pixelated; display: block; }
        .gb-bg-pick.on { border-color: var(--color-pink-600); }
        .gb-bg-pick.paper { display: flex; align-items: center; justify-content: center; }

        .gb-save-overlay {
          position: fixed; inset: 0; z-index: 140;
          background: rgba(74, 46, 94, 0.65); backdrop-filter: blur(5px);
          display: flex; align-items: center; justify-content: center; padding: 16px;
        }
        .gb-save-box {
          width: min(460px, 100%); background: var(--surface-strong);
          border: 2px solid var(--color-pink-200); box-shadow: 0 24px 64px rgba(74,46,94,0.4);
          padding: 20px; display: flex; flex-direction: column; gap: 12px;
        }
        .gb-save-box h3 { margin: 0; color: var(--color-purple-600); }
        .gb-save-preview { width: 100%; border: 2px solid var(--color-purple-100); image-rendering: pixelated; }
        .gb-field { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; font-weight: 700; color: var(--color-purple-600); }
        .gb-field input { padding: 9px 12px; border: 1px solid var(--color-purple-100); background: var(--color-purple-50); font: inherit; }
        .gb-hp { position: absolute; left: -9999px; }
        .gb-save-actions { display: flex; justify-content: flex-end; gap: 8px; }
      `}</style>
    </div>
  );
}
