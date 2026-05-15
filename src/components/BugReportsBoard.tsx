import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, supabaseConfigured, BUG_BUCKET, getOrCreateSession } from '../lib/supabase';

interface ReportImage { id: number; url: string; }
interface Report {
  id: number;
  title: string;
  body: string;
  author: string | null;
  status: 'open' | 'flagged' | 'resolved' | 'closed';
  metoo_count: number;
  created_at: string;
  report_images?: ReportImage[];
  comments?: Comment[];
}
interface Comment {
  id: number;
  report_id: number;
  body: string;
  author: string | null;
  created_at: string;
}

type SortMode = 'open-first' | 'newest' | 'most-metoos';

const MAX_IMAGES = 6;
const MAX_IMAGE_MB = 5;
const MAX_TITLE = 120;
const MAX_BODY = 4000;
const MAX_COMMENT = 2000;
const MAX_AUTHOR = 40;
const MAX_HARDWARE = 8;

// Hardware options for the bug-report form. Grouped via optgroup so the
// dropdown stays scannable. Order is rough-chronological within each
// group. The strings are submitted as-is into the report body.
const HARDWARE_OPTIONS: { label: string; items: string[] }[] = [
  {
    label: 'Original DS',
    items: ['Nintendo DS (Phat)', 'Nintendo DS Lite'],
  },
  {
    label: 'DSi family',
    items: ['Nintendo DSi', 'Nintendo DSi XL'],
  },
  {
    label: '3DS family',
    items: [
      'Nintendo 3DS',
      'Nintendo 3DS XL',
      'Nintendo 2DS',
      'New Nintendo 3DS',
      'New Nintendo 3DS XL',
      'New Nintendo 2DS XL',
    ],
  },
  {
    label: 'Homebrew launcher (running on DSi/3DS)',
    items: ['TWiLight Menu++', 'nds-bootstrap', 'Unlaunch (DSi)'],
  },
  {
    label: 'Flashcart',
    items: ['R4 / R4i', 'AceKard 2i', 'DSTT', 'M3 / M3i Zero', 'SuperCard DSTWO', 'EZ Flash 5'],
  },
  {
    label: 'Emulator (PC)',
    items: ['melonDS', 'DeSmuME', 'no$GBA', 'iDeaS', 'RetroArch (melonDS core)', 'RetroArch (DeSmuME core)'],
  },
  {
    label: 'Emulator (mobile / other)',
    items: ['DraStic (Android)', 'Delta (iOS)', 'RetroArch (mobile)'],
  },
  {
    label: 'Other',
    items: ['Other (note in description)'],
  },
];

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function authorOrAnon(s: string | null | undefined): string {
  const trimmed = (s || '').trim();
  return trimmed || 'Anonymous';
}

function StatusPill({ status }: { status: Report['status'] }) {
  const map: Record<Report['status'], { label: string; cls: string }> = {
    open: { label: 'Open', cls: 'pill-open' },
    flagged: { label: 'Flagged', cls: 'pill-flagged' },
    resolved: { label: 'Resolved', cls: 'pill-resolved' },
    closed: { label: 'Closed', cls: 'pill-closed' },
  };
  const { label, cls } = map[status];
  return <span className={`status-pill ${cls}`}>{label}</span>;
}

function ImageThumbs({ urls, onOpen }: { urls: string[]; onOpen: (url: string) => void }) {
  if (!urls.length) return null;
  return (
    <div className="thumb-row">
      {urls.map((url, i) => (
        <button key={i} className="thumb-btn" onClick={() => onOpen(url)} aria-label="Open image">
          <img src={url} alt="" loading="lazy" />
        </button>
      ))}
    </div>
  );
}

function NewReportForm({
  onPosted,
  rateLimited,
}: {
  onPosted: () => void;
  rateLimited: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [author, setAuthor] = useState('');
  const [title, setTitle] = useState('');
  const [patchVersion, setPatchVersion] = useState('');
  const [hardware, setHardware] = useState<string[]>(['']);
  const [body, setBody] = useState('');
  const [steps, setSteps] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [honeypot, setHoneypot] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function setHardwareAt(idx: number, value: string) {
    setHardware(prev => prev.map((v, i) => i === idx ? value : v));
  }
  function addHardware() {
    setHardware(prev => prev.length >= MAX_HARDWARE ? prev : [...prev, '']);
  }
  function removeHardware(idx: number) {
    setHardware(prev => prev.length <= 1 ? [''] : prev.filter((_, i) => i !== idx));
  }

  function pickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files || []);
    const trimmed = list.slice(0, MAX_IMAGES).filter(f => f.size <= MAX_IMAGE_MB * 1024 * 1024);
    if (trimmed.length < list.length) {
      setErr(`Some files were too big or you picked more than ${MAX_IMAGES}; ignored.`);
    }
    setFiles(prev => [...prev, ...trimmed].slice(0, MAX_IMAGES));
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    setErr(null);
    if (honeypot) return; // bot
    if (!title.trim() || !body.trim()) {
      setErr('Title and description are required.');
      return;
    }
    if (rateLimited) {
      setErr("You just posted — give it a couple of minutes before another one.");
      return;
    }
    if (!supabaseConfigured || !supabase) {
      setErr("Backend isn't configured yet. (Site owner: see SUPABASE_SETUP.md)");
      return;
    }
    setBusy(true);
    try {
      // Combine patch version + hardware + description + optional steps
      // into a single body field (no separate columns in the schema).
      // Metadata at the top, description, then steps at the bottom.
      const pv = patchVersion.trim();
      const stepsTrimmed = steps.trim();
      const hwList = hardware.map(h => h.trim()).filter(Boolean);
      let combinedBody = body.trim();
      const metaLines: string[] = [];
      if (pv) metaLines.push(`**Patch version:** ${pv.slice(0, 40)}`);
      if (hwList.length) metaLines.push(`**Hardware tested:** ${hwList.join(', ')}`);
      if (metaLines.length) {
        combinedBody = `${metaLines.join('\n')}\n\n${combinedBody}`;
      }
      if (stepsTrimmed) {
        combinedBody = `${combinedBody}\n\n**Steps to reproduce:**\n${stepsTrimmed}`;
      }
      const insertPayload = {
        title: title.trim().slice(0, MAX_TITLE),
        body: combinedBody.slice(0, MAX_BODY),
        author: author.trim() ? author.trim().slice(0, MAX_AUTHOR) : null,
        status: 'open' as const,
      };
      const { data: reportRow, error: insErr } = await supabase
        .from('reports')
        .insert(insertPayload)
        .select()
        .single();
      if (insErr || !reportRow) throw insErr || new Error('No report returned');

      const reportId = reportRow.id as number;

      // Upload images
      const imageRecords: { report_id: number; url: string }[] = [];
      for (const f of files) {
        const ext = f.name.split('.').pop()?.toLowerCase() || 'png';
        const path = `r${reportId}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage.from(BUG_BUCKET).upload(path, f, {
          contentType: f.type || 'image/png',
          cacheControl: '31536000',
        });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from(BUG_BUCKET).getPublicUrl(path);
        if (pub?.publicUrl) imageRecords.push({ report_id: reportId, url: pub.publicUrl });
      }
      if (imageRecords.length) {
        const { error: imgErr } = await supabase.from('report_images').insert(imageRecords);
        if (imgErr) throw imgErr;
      }

      window.localStorage.setItem('tongari-last-post', String(Date.now()));
      setAuthor('');
      setTitle('');
      setPatchVersion('');
      setHardware(['']);
      setBody('');
      setSteps('');
      setFiles([]);
      setOpen(false);
      onPosted();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="report-btn" onClick={() => setOpen(true)}>
        <span className="emoji" aria-hidden>🐛</span>
        <span>Post a bug report</span>
      </button>
    );
  }

  return (
    <form
      className="new-form"
      onSubmit={e => { e.preventDefault(); submit(); }}
    >
      <div className="form-row split">
        <label className="field">
          <span className="field-label">Your name (optional)</span>
          <input
            type="text"
            value={author}
            onChange={e => setAuthor(e.target.value)}
            placeholder="Anonymous"
            maxLength={MAX_AUTHOR}
          />
        </label>
        <label className="field hp" aria-hidden="true">
          <span className="field-label">Website (leave blank)</span>
          <input
            type="text"
            value={honeypot}
            onChange={e => setHoneypot(e.target.value)}
            tabIndex={-1}
            autoComplete="off"
          />
        </label>
      </div>
      <label className="field">
        <span className="field-label">Title</span>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Short summary of the bug"
          maxLength={MAX_TITLE}
          required
        />
      </label>
      <label className="field">
        <span className="field-label">Patch version (optional)</span>
        <input
          type="text"
          value={patchVersion}
          onChange={e => setPatchVersion(e.target.value)}
          placeholder="e.g. v2.31 — the version you were running when this happened"
          maxLength={40}
        />
      </label>
      <div className="field">
        <span className="field-label">Hardware tested on (optional, add more if multiple)</span>
        <div className="hw-list">
          {hardware.map((value, idx) => (
            <div key={idx} className="hw-row">
              <select
                value={value}
                onChange={e => setHardwareAt(idx, e.target.value)}
                className="hw-select"
              >
                <option value="">— Select hardware —</option>
                {HARDWARE_OPTIONS.map(group => (
                  <optgroup key={group.label} label={group.label}>
                    {group.items.map(item => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {(hardware.length > 1 || value) && (
                <button
                  type="button"
                  className="hw-remove"
                  onClick={() => removeHardware(idx)}
                  aria-label="Remove this hardware entry"
                  title="Remove"
                >×</button>
              )}
            </div>
          ))}
          {hardware.length < MAX_HARDWARE && (
            <button type="button" className="hw-add" onClick={addHardware}>
              <span aria-hidden>+</span> Add another
            </button>
          )}
        </div>
      </div>
      <label className="field">
        <span className="field-label">What's the issue?</span>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Describe what happened, where, and what you expected. Markdown is supported."
          rows={6}
          maxLength={MAX_BODY}
          required
        />
      </label>
      <label className="field">
        <span className="field-label">Steps to reproduce (optional)</span>
        <textarea
          value={steps}
          onChange={e => setSteps(e.target.value)}
          placeholder={"1. Open the magic shop\n2. Tap the Charm tab\n3. Garbled text appears in the description"}
          rows={5}
          maxLength={MAX_BODY}
        />
      </label>
      <div className="file-row">
        <button
          type="button"
          className="add-images-btn"
          onClick={() => fileInput.current?.click()}
        >
          <span aria-hidden>📷</span> Add screenshots
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          onChange={pickFiles}
          style={{ display: 'none' }}
        />
        <span className="file-hint">
          Up to {MAX_IMAGES} images, {MAX_IMAGE_MB}MB each.
        </span>
      </div>
      {files.length > 0 && (
        <div className="file-previews">
          {files.map((f, i) => (
            <div key={i} className="file-preview">
              <img src={URL.createObjectURL(f)} alt="" />
              <button
                type="button"
                className="remove-file"
                onClick={() => removeFile(i)}
                aria-label="Remove image"
              >×</button>
            </div>
          ))}
        </div>
      )}
      {err && <div className="form-error">{err}</div>}
      <div className="form-actions">
        <button type="button" className="cancel-btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="submit-btn" disabled={busy}>
          {busy ? 'Posting…' : 'Post bug report'}
        </button>
      </div>
    </form>
  );
}

function CommentForm({ reportId, onPosted }: { reportId: number; onPosted: () => void }) {
  const [open, setOpen] = useState(false);
  const [author, setAuthor] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!body.trim()) { setErr('Comment is required.'); return; }
    if (!supabaseConfigured || !supabase) {
      setErr("Backend isn't configured yet.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.from('comments').insert({
        report_id: reportId,
        body: body.trim().slice(0, MAX_COMMENT),
        author: author.trim() ? author.trim().slice(0, MAX_AUTHOR) : null,
      });
      if (error) throw error;
      setAuthor('');
      setBody('');
      setOpen(false);
      onPosted();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="action add-comment-btn" onClick={() => setOpen(true)}>
        <span className="emoji" aria-hidden>💬</span>
        <span className="action-label">Add a comment</span>
      </button>
    );
  }
  return (
    <form className="comment-form" onSubmit={e => { e.preventDefault(); submit(); }}>
      <input
        type="text"
        value={author}
        onChange={e => setAuthor(e.target.value)}
        placeholder="Your name (optional)"
        maxLength={MAX_AUTHOR}
      />
      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder="Got a fix, a workaround, or a similar experience? Share it."
        rows={3}
        maxLength={MAX_COMMENT}
        required
      />
      {err && <div className="form-error">{err}</div>}
      <div className="comment-form-actions">
        <button type="button" className="cancel-btn small" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
        <button type="submit" className="submit-btn small" disabled={busy}>{busy ? 'Posting…' : 'Add comment'}</button>
      </div>
    </form>
  );
}

function MeTooButton({ report, onTooed }: { report: Report; onTooed: () => void }) {
  const session = getOrCreateSession();
  const localKey = `metoo-${report.id}`;
  const [pressed, setPressed] = useState<boolean>(() =>
    typeof window !== 'undefined' && localStorage.getItem(localKey) === '1'
  );
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(report.metoo_count);

  async function press() {
    if (pressed || busy) return;
    if (!supabaseConfigured || !supabase) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('report_metoos')
        .insert({ report_id: report.id, session_id: session });
      if (error && error.code !== '23505') throw error;
      // Optimistically bump count
      setPressed(true);
      setCount(c => c + 1);
      window.localStorage.setItem(localKey, '1');
      onTooed();
    } catch (e) {
      // Ignore silently for MVP
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={`action me-too ${pressed ? 'pressed' : ''}`}
      onClick={press}
      disabled={busy || pressed}
      title={pressed ? "You've already said me too" : 'Tap if you have this bug too'}
    >
      <span className="emoji" aria-hidden>🙋</span>
      <span className="action-label">{pressed ? "You're in" : 'Me too'}</span>
      <span className="counter">{count}</span>
    </button>
  );
}

function ReportCard({
  report,
  onChanged,
  onOpenImage,
}: {
  report: Report;
  onChanged: () => void;
  onOpenImage: (url: string) => void;
}) {
  const imageUrls = (report.report_images || []).map(i => i.url);
  return (
    <article className="bug-card">
      <header className="bug-card-head">
        <div className="head-left">
          <span className="ticket-num">#{report.id}</span>
          <h2 className="bug-title">{report.title}</h2>
        </div>
        <div className="head-right">
          <StatusPill status={report.status} />
        </div>
      </header>
      <div className="bug-meta">
        <span className="author">{authorOrAnon(report.author)}</span>
        <span className="dot">·</span>
        <span className="timestamp">{timeAgo(report.created_at)}</span>
      </div>
      <div className="bug-body">
        {report.body.split(/\n+/).map((p, i) => <p key={i}>{p}</p>)}
      </div>
      {imageUrls.length > 0 && <ImageThumbs urls={imageUrls} onOpen={onOpenImage} />}
      <div className="bug-actions">
        <MeTooButton report={report} onTooed={onChanged} />
        <CommentForm reportId={report.id} onPosted={onChanged} />
      </div>
      {report.comments && report.comments.length > 0 && (
        <section className="comments">
          {report.comments.map(c => (
            <article key={c.id} className="comment">
              <header className="comment-head">
                <span className="author small">{authorOrAnon(c.author)}</span>
                <span className="timestamp">{timeAgo(c.created_at)}</span>
              </header>
              <div className="comment-body">
                {c.body.split(/\n+/).map((p, i) => <p key={i}>{p}</p>)}
              </div>
            </article>
          ))}
        </section>
      )}
    </article>
  );
}

export default function BugReportsBoard() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('open-first');
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);

  async function load() {
    if (!supabaseConfigured || !supabase) {
      setLoading(false);
      setErr('not_configured');
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from('reports')
      .select('*, report_images(*), comments(*)')
      .order('created_at', { ascending: false });
    if (error) {
      setErr(error.message);
    } else {
      // Sort comments oldest-first within each report
      const normalized = (data as Report[] || []).map(r => ({
        ...r,
        comments: (r.comments || []).slice().sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        ),
      }));
      setReports(normalized);
      setErr(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // Rate-limit: 2-minute window after a post
    const last = Number(localStorage.getItem('tongari-last-post') || 0);
    setRateLimited(Date.now() - last < 2 * 60 * 1000);
    const t = setInterval(() => {
      const last2 = Number(localStorage.getItem('tongari-last-post') || 0);
      setRateLimited(Date.now() - last2 < 2 * 60 * 1000);
    }, 15000);
    return () => clearInterval(t);
  }, []);

  const sorted = useMemo(() => {
    const list = [...reports];
    list.sort((a, b) => {
      if (sort === 'open-first') {
        const aOpen = a.status === 'open' || a.status === 'flagged' ? 0 : 1;
        const bOpen = b.status === 'open' || b.status === 'flagged' ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        return (b.metoo_count || 0) - (a.metoo_count || 0);
      }
      if (sort === 'newest') {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      if ((b.metoo_count || 0) !== (a.metoo_count || 0)) {
        return (b.metoo_count || 0) - (a.metoo_count || 0);
      }
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    return list;
  }, [reports, sort]);

  if (!supabaseConfigured) {
    return (
      <div className="board-status">
        <p>
          The bug-report backend isn't configured for this site yet. The site
          owner needs to add Supabase credentials — see{' '}
          <code>SUPABASE_SETUP.md</code> in the repo for the one-time setup.
        </p>
      </div>
    );
  }
  if (loading) return <div className="board-status">Loading bug reports…</div>;
  if (err) return <div className="board-status error">Couldn't load: {err}</div>;

  return (
    <div className="bug-board">
      <div className="board-header">
        <NewReportForm onPosted={load} rateLimited={rateLimited} />
        <div className="sort-pills">
          {(['open-first', 'newest', 'most-metoos'] as SortMode[]).map(s => (
            <button
              key={s}
              className={`sort-pill ${sort === s ? 'active' : ''}`}
              onClick={() => setSort(s)}
            >
              {s === 'open-first' ? 'Open first' : s === 'newest' ? 'Newest' : 'Most "me too"s'}
            </button>
          ))}
        </div>
        <span className="board-counts">
          {reports.filter(r => r.status === 'open' || r.status === 'flagged').length} open
          <span className="dot">·</span>
          {reports.filter(r => r.status === 'closed' || r.status === 'resolved').length} closed
        </span>
      </div>

      {sorted.length === 0 && (
        <div className="empty-state">
          <div className="empty-emoji" aria-hidden>🌸</div>
          <h3>No bug reports yet</h3>
          <p>Be the first to share something — the post form is above.</p>
        </div>
      )}

      <div className="cards">
        {sorted.map(r => (
          <ReportCard key={r.id} report={r} onChanged={load} onOpenImage={setLightbox} />
        ))}
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog">
          <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">×</button>
          <img src={lightbox} alt="" />
        </div>
      )}

      <style>{`
        .board-status { padding: 60px 20px; text-align: center; color: var(--color-ink-soft); background: var(--surface-strong); border-radius: var(--radius-lg); border: 1px solid var(--color-pink-100); }
        .board-status.error { color: var(--color-pink-600); }
        .board-status code { background: var(--color-purple-50); padding: 2px 6px; border-radius: 4px; }

        .board-header {
          display: flex; flex-wrap: wrap; align-items: center; gap: 14px;
          padding: 18px 20px;
          background: linear-gradient(135deg, var(--color-pink-50), var(--color-purple-50));
          border-radius: var(--radius-lg); margin-bottom: 24px;
          border: 1px solid var(--color-pink-100);
        }
        .report-btn {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 10px 18px; border-radius: var(--radius-pill);
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; font-weight: 700; border: none; cursor: pointer;
          font-family: inherit; font-size: 0.95rem;
          box-shadow: 0 6px 16px rgba(155, 123, 217, 0.35);
        }
        .report-btn:hover { transform: translateY(-1px); }
        .report-btn .emoji { font-size: 1.1rem; }
        .sort-pills { display: flex; gap: 6px; flex-wrap: wrap; }
        .sort-pill {
          padding: 6px 14px; border-radius: var(--radius-pill);
          background: white; color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100); font-weight: 600; font-size: 0.85rem;
          cursor: pointer; font-family: inherit;
        }
        .sort-pill:hover { background: var(--color-purple-100); }
        .sort-pill.active { background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400)); color: white; border-color: transparent; }
        .board-counts { margin-left: auto; color: var(--color-ink-soft); font-size: 0.85rem; }
        .dot { margin: 0 6px; opacity: 0.5; }

        .new-form {
          /* Claim a full row inside .board-header's flex layout so the form
             doesn't get squeezed into a narrow column next to the sort pills. */
          flex: 1 0 100%;
          width: 100%;
          max-width: 720px;
          background: white; padding: 18px 20px;
          border-radius: var(--radius-lg); border: 1px solid var(--color-pink-100);
          box-shadow: var(--shadow-soft);
          display: flex; flex-direction: column; gap: 12px;
          margin-bottom: 4px;
        }
        .form-row.split { display: grid; grid-template-columns: 1fr; gap: 12px; }
        .hw-list { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
        .hw-row { display: flex; gap: 8px; align-items: center; }
        .hw-select {
          flex: 1; padding: 10px 14px; border-radius: var(--radius-md);
          border: 1px solid var(--color-purple-100); background: var(--color-purple-50);
          font: inherit; color: var(--color-ink); cursor: pointer;
        }
        .hw-select:focus { outline: 2px solid var(--color-pink-200); background: white; }
        .hw-remove {
          width: 28px; height: 28px; border-radius: 50%;
          background: var(--color-pink-100); color: var(--color-pink-600);
          border: none; cursor: pointer; font-size: 1.1rem; line-height: 1;
          flex-shrink: 0;
        }
        .hw-remove:hover { background: var(--color-pink-200); }
        .hw-add {
          align-self: flex-start; margin-top: 2px;
          padding: 6px 14px; border-radius: var(--radius-pill);
          background: var(--color-purple-50); color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100); font: inherit; font-size: 0.82rem; font-weight: 600;
          cursor: pointer;
        }
        .hw-add:hover { background: var(--color-purple-100); }
        .field { display: flex; flex-direction: column; gap: 4px; }
        .field-label { font-weight: 600; color: var(--color-purple-600); font-size: 0.82rem; }
        .field input, .field textarea {
          padding: 10px 14px; border-radius: var(--radius-md);
          border: 1px solid var(--color-purple-100); background: var(--color-purple-50);
          color: var(--color-ink); font: inherit; resize: vertical;
        }
        .field input:focus, .field textarea:focus { outline: 2px solid var(--color-pink-200); background: white; }
        .field.hp { position: absolute; left: -9999px; }
        .file-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .add-images-btn {
          padding: 7px 14px; border-radius: var(--radius-pill);
          background: var(--color-purple-50); color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100); font-weight: 600; font-size: 0.85rem;
          cursor: pointer; font-family: inherit;
        }
        .add-images-btn:hover { background: var(--color-purple-100); }
        .file-hint { color: var(--color-ink-soft); font-size: 0.8rem; }
        .file-previews { display: flex; flex-wrap: wrap; gap: 8px; }
        .file-preview { position: relative; border: 2px solid var(--color-pink-100); border-radius: var(--radius-md); overflow: hidden; }
        .file-preview img { display: block; width: 80px; height: 80px; object-fit: cover; }
        .remove-file {
          position: absolute; top: 2px; right: 2px;
          width: 20px; height: 20px; border-radius: 50%;
          background: white; color: var(--color-pink-600); border: none;
          font-size: 0.9rem; cursor: pointer; line-height: 1;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }
        .form-error { color: var(--color-pink-600); font-size: 0.85rem; }
        .form-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .cancel-btn { padding: 8px 16px; border-radius: var(--radius-pill); background: white; color: var(--color-ink-soft); border: 1px solid var(--color-purple-100); font-weight: 600; cursor: pointer; font-family: inherit; }
        .cancel-btn.small { padding: 5px 11px; font-size: 0.82rem; }
        .submit-btn { padding: 8px 18px; border-radius: var(--radius-pill); background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400)); color: white; border: none; font-weight: 700; cursor: pointer; font-family: inherit; }
        .submit-btn.small { padding: 5px 12px; font-size: 0.82rem; }
        .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .empty-state { text-align: center; padding: 60px 20px; background: var(--surface-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-soft); border: 1px solid var(--color-pink-100); }
        .empty-state .empty-emoji { font-size: 3rem; }
        .empty-state h3 { color: var(--color-pink-600); margin: 8px 0 6px; }
        .empty-state p { color: var(--color-ink-soft); max-width: 50ch; margin: 0 auto; }

        .cards { display: flex; flex-direction: column; gap: 18px; }
        .bug-card {
          background: var(--surface-strong); border-radius: var(--radius-lg);
          box-shadow: var(--shadow-soft); border: 1px solid var(--color-pink-100);
          padding: 22px 24px;
          transition: box-shadow 0.15s ease, border-color 0.15s ease;
        }
        .bug-card:hover { box-shadow: var(--shadow-pop); border-color: var(--color-pink-200); }
        .bug-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
        .head-left { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; flex: 1; }
        .ticket-num { font-family: ui-monospace, monospace; color: var(--color-purple-400); font-weight: 700; font-size: 0.95rem; }
        .bug-title { margin: 0; font-size: 1.2rem; color: var(--color-ink); font-weight: 700; line-height: 1.3; }
        .status-pill { display: inline-block; padding: 4px 12px; border-radius: var(--radius-pill); font-size: 0.78rem; font-weight: 700; letter-spacing: 0.02em; }
        .pill-open      { background: var(--color-pink-100);    color: var(--color-pink-600); }
        .pill-flagged   { background: #fff1c4;                  color: #b07f00; }
        .pill-resolved  { background: #d9f3df;                  color: #2c8a4a; }
        .pill-closed    { background: var(--color-purple-100);  color: var(--color-purple-600); }
        .bug-meta { display: flex; align-items: center; gap: 6px; color: var(--color-ink-soft); font-size: 0.82rem; margin-bottom: 12px; }
        .author { color: var(--color-purple-600); font-weight: 600; }
        .author.small { font-size: 0.82rem; }
        .timestamp { color: var(--color-ink-soft); }
        .bug-body { color: var(--color-ink); line-height: 1.55; font-size: 0.96rem; }
        .bug-body p { margin: 0 0 10px; }
        .bug-body p:last-child { margin-bottom: 0; }

        .thumb-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
        .thumb-btn {
          padding: 0; border: 2px solid var(--color-pink-100); background: white;
          border-radius: var(--radius-md); overflow: hidden; cursor: pointer;
          transition: transform 0.12s ease, border-color 0.12s ease;
        }
        .thumb-btn:hover { transform: scale(1.03); border-color: var(--color-pink-400); }
        .thumb-btn img { display: block; width: 96px; height: 96px; object-fit: cover; }

        .bug-actions {
          display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start;
          margin-top: 14px; padding-top: 14px;
          border-top: 1px dashed var(--color-pink-100);
        }
        .action {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 7px 14px; border-radius: var(--radius-pill);
          background: var(--color-purple-50); color: var(--color-purple-600);
          border: 1px solid var(--color-purple-100); font-weight: 600; font-size: 0.82rem;
          cursor: pointer; font-family: inherit;
          transition: background 0.12s ease, color 0.12s ease;
        }
        .action:hover { background: var(--color-purple-100); }
        .action.me-too:hover { background: var(--color-pink-100); color: var(--color-pink-600); border-color: var(--color-pink-200); }
        .action.me-too.pressed { background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400)); color: white; border-color: transparent; cursor: default; }
        .action:disabled { cursor: not-allowed; }
        .action .counter {
          background: white; padding: 1px 8px; border-radius: 999px;
          font-size: 0.75rem; color: var(--color-ink); min-width: 16px; text-align: center;
        }
        .action.me-too.pressed .counter { background: rgba(255,255,255,0.85); }

        .comment-form {
          display: flex; flex-direction: column; gap: 8px;
          background: var(--color-purple-50); padding: 12px;
          border-radius: var(--radius-md); margin-top: 4px; width: 100%;
        }
        .comment-form input, .comment-form textarea {
          padding: 8px 12px; border-radius: var(--radius-md);
          border: 1px solid var(--color-purple-100); background: white;
          font: inherit; resize: vertical;
        }
        .comment-form-actions { display: flex; gap: 6px; justify-content: flex-end; }

        .comments {
          margin-top: 14px; padding-top: 14px;
          border-top: 1px dashed var(--color-pink-100);
          display: flex; flex-direction: column; gap: 10px;
        }
        .comment {
          background: var(--color-purple-50); padding: 12px 16px;
          border-radius: var(--radius-md); border-left: 3px solid var(--color-purple-200);
        }
        .comment-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: 0.82rem; }
        .comment-body { color: var(--color-ink); font-size: 0.92rem; line-height: 1.5; }
        .comment-body p { margin: 0 0 6px; }
        .comment-body p:last-child { margin-bottom: 0; }

        .lightbox {
          position: fixed; inset: 0;
          background: rgba(74, 46, 94, 0.75); backdrop-filter: blur(8px);
          display: flex; align-items: center; justify-content: center;
          padding: 24px; z-index: 100; cursor: zoom-out;
        }
        .lightbox img { max-width: 96vw; max-height: 92vh; object-fit: contain; border-radius: var(--radius-md); box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        .lightbox-close { position: absolute; top: 18px; right: 22px; width: 38px; height: 38px; border-radius: 50%; background: white; color: var(--color-pink-600); border: none; font-size: 1.5rem; cursor: pointer; line-height: 1; }
      `}</style>
    </div>
  );
}
