import { useRef, useState, useCallback } from 'react';
import { supabase, supabaseConfigured, SAVE_FILES_BUCKET } from '../lib/supabase';

// Tongari Boushi is a 2007 DS title. Its native save format on cart is a
// raw EEPROM blob (typ. 64 KB / 256 KB / 512 KB / 1 MB depending on save
// chip). Every realistic path a fan would have to a save file maps to
// one of the categories below.
//
// We split paths that produce SUBTLY different on-disk layouts into their
// own entries because Tyler needs that signal when triaging:
//
//   - DeSmuME prepends a header to its .dsv files. Anyone debugging a
//     "save won't load" report needs to know this up front.
//   - melonDS / No$GBA / DraStic / TWiLight Menu++ all write the raw save
//     with no header, but use slightly different default extensions and
//     in some cases (No$GBA) write a partial file until the game is
//     properly suspended.
//   - DSTwo flashcarts use .savn alongside .sav for some games.
//
// Order within each group is rough popularity / recency, not alphabetical.
const SAVE_SOURCE_OPTIONS: { label: string; items: string[] }[] = [
  {
    label: 'PC emulator',
    items: [
      'melonDS',
      'DeSmuME (.dsv has a 122-byte footer)',
      'no$GBA / no$Zoomer',
      'RetroArch (melonDS core)',
      'RetroArch (DeSmuME core)',
    ],
  },
  {
    label: 'Mobile emulator',
    items: [
      'DraStic (Android)',
      'MelonDS Android port',
      'Delta (iOS, DS core)',
    ],
  },
  {
    label: 'Original cartridge - DS / DS Lite / DSi',
    items: [
      'Save dumped via flashcart (read-back)',
      'Save dumped via Save Dongle / Cyclo Cart Reader',
      'Save dumped via NTRBoot / TWLSaveTool',
    ],
  },
  {
    label: 'DS game on 3DS / 2DS family',
    items: [
      'TWiLight Menu++ + nds-bootstrap (Luma3DS CFW)',
      '3DS GodMode9 (.sav from cartridge dump)',
      'TWLMenu++ on DSi mode (DSi/3DS native)',
      'Cartridge played through 3DS DS-mode',
    ],
  },
  {
    label: 'DS flashcart (running on real DS hardware)',
    items: [
      'R4 / R4i Gold',
      'AceKard 2i',
      'DSTT / DSTTi',
      'EZ-Flash IV / V / Vi',
      'EZ-Flash 3-in-1',
      'M3 / M3i Zero',
      'SuperCard DSTWO',
      'CycloDS Evolution',
    ],
  },
  // "Other" handled specially below (sentinel value reveals a text input).
];

const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB ceiling

const OTHER_SENTINEL = '__OTHER__';
const OTHER_PREFIX = 'Other: ';

const PATCH_VERSIONS = ['v2.4', 'v2.32', 'v2.31', 'v2.3', 'v2.2', 'v2.1', 'v2.0', 'Unpatched', 'Unsure'];
const PATCH_VERSION_LABELS: Record<string, string> = {
  Unpatched: 'Unpatched (JP ROM, no fan patch)',
};
const DEFAULT_PATCH = '';

// Common DS save extensions. We don't enforce these strictly server-side
// (Supabase Storage doesn't care), but the accept attribute keeps the
// file picker filtered to plausible candidates on most OSes.
//
// We deliberately do NOT include application/octet-stream here: browsers
// treat that MIME type as "anything", which makes the picker accept any
// file (including screenshots). Save files frequently have wrong / missing
// MIME types, so we gate on the extension list below in addFiles() as the
// real check.
const ACCEPT_EXT =
  '.sav,.dsv,.duc,.savn,.dat,.bin,.SAV,.DSV,.DUC,.SAVN,.DAT,.BIN';

const ALLOWED_EXTENSIONS = ['.sav', '.dsv', '.duc', '.savn', '.dat', '.bin'];

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

type RowStatus = 'pending' | 'uploading' | 'done' | 'failed';

interface FileRow {
  id: string;
  file: File;
  source: string;       // resolved value: '' or full label or 'Other: ...'
  patchVersion: string; // '' until user picks
  // Per-row in-game values the save-format research agent uses to localize
  // unknown offsets. Both optional - blank string = "user didn't say".
  ritch: string;        // string-typed to preserve "" vs "0"; numeric coerce at insert time
  wizardLevel: string;  // same pattern
  status: RowStatus;
  error: string | null;
  rowError: string | null; // inline validation error (e.g. missing dropdown)
}

function randomToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for ancient runtimes - not strictly needed in Astro/Vite,
  // but cheap insurance.
  return 'x' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function safeFilename(name: string): string {
  // Strip path separators, shell glob chars, quotes, and whitespace; keep
  // extension intact. Allow letters/digits/dot/dash/underscore only;
  // every other rune collapses to '_'. Defensive vs. weird filenames
  // ending up as ugly bucket keys.
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').trim();
  return cleaned.slice(0, 120) || 'save.sav';
}

function bytesToHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function truncateMid(name: string, max = 38): string {
  if (name.length <= max) return name;
  const keep = max - 1;
  const left = Math.ceil(keep * 0.6);
  const right = Math.floor(keep * 0.4);
  return name.slice(0, left) + '…' + name.slice(name.length - right);
}

export default function SaveFilesBatchForm() {
  const [rows, setRows] = useState<FileRow[]>([]);
  const [honeypot, setHoneypot] = useState('');
  const [busy, setBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchPosted, setBatchPosted] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    setBatchError(null);
    setBatchPosted(false);

    const items = Array.from(incoming);
    const errors: string[] = [];
    const fresh: FileRow[] = [];

    for (const f of items) {
      if (!hasAllowedExtension(f.name)) {
        errors.push(
          `${f.name}: not a save file - expected .sav/.dsv/.duc/.savn/.dat/.bin - skipped.`
        );
        continue;
      }
      if (f.size === 0) {
        errors.push(`${f.name}: empty (0 bytes) - skipped.`);
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        errors.push(
          `${f.name}: ${bytesToHuman(f.size)} exceeds the ${bytesToHuman(MAX_FILE_BYTES)} cap - skipped.`
        );
        continue;
      }
      fresh.push({
        id: randomToken(),
        file: f,
        source: '',
        patchVersion: DEFAULT_PATCH,
        ritch: '',
        wizardLevel: '',
        status: 'pending',
        error: null,
        rowError: null,
      });
    }

    if (fresh.length > 0) {
      setRows(prev => [...prev, ...fresh]);
    }
    if (errors.length > 0) {
      setBatchError(errors.join(' '));
    }
  }, []);

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (list && list.length > 0) {
      addFiles(list);
    }
    // Reset input so picking the same file again still fires onChange.
    if (fileInput.current) fileInput.current.value = '';
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(true);
  }

  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
  }

  function openPicker() {
    fileInput.current?.click();
  }

  function onDropZoneKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  }

  function updateRow(id: string, patch: Partial<FileRow>) {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRow(id: string) {
    setRows(prev => prev.filter(r => r.id !== id));
  }

  function setRowSource(id: string, raw: string) {
    if (raw === OTHER_SENTINEL) {
      updateRow(id, { source: OTHER_PREFIX, rowError: null });
    } else {
      updateRow(id, { source: raw, rowError: null });
    }
  }

  function setRowOtherText(id: string, text: string) {
    updateRow(id, { source: OTHER_PREFIX + text, rowError: null });
  }

  async function uploadOne(row: FileRow): Promise<{ ok: boolean; error?: string }> {
    if (!supabase) return { ok: false, error: 'Supabase client not configured.' };
    try {
      // Path scheme: <YYYY>/<MM>/<uuid>/<original-filename>
      // Year/month grouping keeps the bucket browsable as it grows; the
      // UUID dir guarantees collisions are impossible even if two users
      // upload save.sav within the same minute.
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const cleaned = safeFilename(row.file.name);
      const filePath = `${yyyy}/${mm}/${randomToken()}/${cleaned}`;

      const { error: upErr } = await supabase.storage
        .from(SAVE_FILES_BUCKET)
        .upload(filePath, row.file, {
          contentType: row.file.type || 'application/octet-stream',
          cacheControl: '0',
          upsert: false,
        });
      if (upErr) throw upErr;

      // Parse optional numeric fields. Empty string / NaN -> null so the
      // research agent can distinguish "user didn't say" from "user said 0".
      // Note: if the Supabase project hasn't had the ritch_amount /
      // wizard_level columns migrated yet, the insert will 400 with
      // "column does not exist". Apply the migration in SUPABASE_SETUP.md
      // before the form goes live.
      const ritchParsed = row.ritch.trim() === '' ? null : Number.parseInt(row.ritch.trim(), 10);
      const wizardParsed = row.wizardLevel.trim() === '' ? null : Number.parseInt(row.wizardLevel.trim(), 10);
      const insertPayload = {
        filename: cleaned,
        file_path: filePath,
        file_size_bytes: row.file.size,
        save_source: row.source.trim().slice(0, 120),
        patch_version: row.patchVersion ? row.patchVersion.slice(0, 40) : null,
        ritch_amount: Number.isFinite(ritchParsed as number) ? ritchParsed : null,
        wizard_level: Number.isFinite(wizardParsed as number) ? wizardParsed : null,
        // submitter and debug_reason are admin-only columns now; the form
        // no longer collects them. Inserts always leave them null.
        debug_reason: null,
        submitter: null,
      };
      const { error: insErr } = await supabase.from('save_files').insert(insertPayload);
      if (insErr) throw insErr;

      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function uploadRowsByIds(ids: string[]) {
    setBusy(true);
    setBatchError(null);
    setBatchPosted(false);

    // Mark all targets as uploading up front so the user sees the queue light up.
    setRows(prev =>
      prev.map(r => (ids.includes(r.id) ? { ...r, status: 'uploading', error: null } : r))
    );

    // Snapshot the latest rows after the state update; we read from `rows`
    // closure but since uploads happen sequentially this is fine.
    const snapshot = rows
      .filter(r => ids.includes(r.id))
      .map(r => ({ ...r, status: 'uploading' as RowStatus }));

    let anyFailure = false;
    for (const row of snapshot) {
      const res = await uploadOne(row);
      if (res.ok) {
        setRows(prev =>
          prev.map(r => (r.id === row.id ? { ...r, status: 'done', error: null } : r))
        );
      } else {
        anyFailure = true;
        setRows(prev =>
          prev.map(r =>
            r.id === row.id
              ? { ...r, status: 'failed', error: res.error || 'Upload failed.' }
              : r
          )
        );
      }
    }

    setBusy(false);

    if (!anyFailure) {
      // Wait one tick so the user sees the green "done" state, then clear.
      setBatchPosted(true);
      window.setTimeout(() => {
        setRows(prev => prev.filter(r => !ids.includes(r.id)));
      }, 900);
      window.setTimeout(() => setBatchPosted(false), 8000);
    }
  }

  async function submitBatch(e: React.FormEvent) {
    e.preventDefault();
    setBatchError(null);
    if (honeypot) return; // bot

    if (rows.length === 0) {
      setBatchError('Add at least one save file first.');
      return;
    }
    if (!supabaseConfigured || !supabase) {
      setBatchError("Backend isn't configured yet. (Site owner: see SUPABASE_SETUP.md)");
      return;
    }

    // Validate every row. Only validate rows that haven't already succeeded.
    const targets = rows.filter(r => r.status !== 'done');
    let invalid = false;
    const updates: Record<string, string | null> = {};
    for (const r of targets) {
      const src = r.source.trim();
      if (!src || src === OTHER_PREFIX.trim() || src === OTHER_PREFIX) {
        updates[r.id] = 'Pick where this save came from.';
        invalid = true;
        continue;
      }
      if (!r.patchVersion) {
        updates[r.id] = 'Pick a patch version (or "Unsure").';
        invalid = true;
        continue;
      }
      updates[r.id] = null;
    }
    setRows(prev =>
      prev.map(r => (r.id in updates ? { ...r, rowError: updates[r.id] } : r))
    );
    if (invalid) {
      setBatchError('Some rows are missing required fields - fix the highlighted ones.');
      return;
    }

    await uploadRowsByIds(targets.map(r => r.id));
  }

  async function retryRow(id: string) {
    const row = rows.find(r => r.id === id);
    if (!row) return;
    const src = row.source.trim();
    if (!src || src === OTHER_PREFIX.trim() || src === OTHER_PREFIX) {
      updateRow(id, { rowError: 'Pick where this save came from.' });
      return;
    }
    if (!row.patchVersion) {
      updateRow(id, { rowError: 'Pick a patch version (or "Unsure").' });
      return;
    }
    if (!supabaseConfigured || !supabase) {
      setBatchError("Backend isn't configured yet.");
      return;
    }
    await uploadRowsByIds([id]);
  }

  if (!supabaseConfigured) {
    return (
      <div className="board-status">
        <p>
          The save-file submission backend isn't configured for this site
          yet. The site owner needs to add Supabase credentials - see{' '}
          <code>SUPABASE_SETUP.md</code> in the repo for the one-time
          setup.
        </p>
      </div>
    );
  }

  const dzClass = ['drop-zone', dragOver ? 'is-over' : '', rows.length > 0 ? 'has-files' : ''].join(' ').trim();
  const pendingCount = rows.filter(r => r.status !== 'done').length;

  // A row counts as "ready" only when BOTH dropdowns hold a real value.
  // This drives the badge label so it doesn't claim "Ready" before the
  // user has picked Source / Patch. Submit-time validation logic is
  // untouched - this is purely the badge surface.
  function rowReady(r: FileRow): boolean {
    const src = r.source.trim();
    const sourcePicked = !!src && src !== OTHER_PREFIX.trim() && src !== OTHER_PREFIX;
    const patchPicked = !!r.patchVersion;
    return sourcePicked && patchPicked;
  }

  return (
    <div className="save-wrap">
      <form className="save-batch" onSubmit={submitBatch}>
        {/* Honeypot - visually hidden, off-screen, tabIndex -1 */}
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

        <div
          className={dzClass}
          role="button"
          tabIndex={0}
          onClick={openPicker}
          onKeyDown={onDropZoneKey}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          aria-label="Add save files - click to choose, or drag and drop"
        >
          <div className="dz-icon" aria-hidden="true">⤓</div>
          <div className="dz-headline">
            <strong>Drop save files here</strong> or click to choose
          </div>
          <div className="dz-hint">
            Multiple files at once is fine. .sav, .dsv, .duc, .savn, .dat, .bin - up to 4 MB each.
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT_EXT}
            multiple
            onChange={onPickFiles}
            className="dz-input"
            tabIndex={-1}
          />
        </div>

        {rows.length > 0 && (
          <ul className="file-list" aria-label="Files queued for upload">
            {rows.map(row => {
              const isOther = row.source.startsWith(OTHER_PREFIX);
              const selectValue = isOther ? OTHER_SENTINEL : row.source;
              const otherText = isOther ? row.source.slice(OTHER_PREFIX.length) : '';
              const cls = ['file-row', `status-${row.status}`, row.rowError ? 'has-row-error' : ''].join(' ').trim();
              return (
                <li key={row.id} className={cls}>
                  <div className="row-main">
                    <div className="file-info">
                      <span className="file-name" title={row.file.name}>
                        {truncateMid(row.file.name)}
                      </span>
                      <span className="file-size">{bytesToHuman(row.file.size)}</span>
                    </div>
                    <div className="row-selects">
                      <label className="row-field">
                        <span className="row-field-label">Source</span>
                        <select
                          value={selectValue}
                          onChange={e => setRowSource(row.id, e.target.value)}
                          disabled={row.status === 'uploading' || row.status === 'done'}
                        >
                          <option value="">- Pick one -</option>
                          {SAVE_SOURCE_OPTIONS.map(group => (
                            <optgroup key={group.label} label={group.label}>
                              {group.items.map(item => (
                                <option key={item} value={item}>{item}</option>
                              ))}
                            </optgroup>
                          ))}
                          <option value={OTHER_SENTINEL}>Other (type your own)...</option>
                        </select>
                      </label>
                      <label className="row-field row-field-patch">
                        <span className="row-field-label">Patch</span>
                        <select
                          value={row.patchVersion}
                          onChange={e => updateRow(row.id, { patchVersion: e.target.value, rowError: null })}
                          disabled={row.status === 'uploading' || row.status === 'done'}
                        >
                          <option value="">- Pick one -</option>
                          {PATCH_VERSIONS.map(v => (
                            <option key={v} value={v}>{PATCH_VERSION_LABELS[v] || v}</option>
                          ))}
                        </select>
                      </label>
                      <label className="row-field row-field-num">
                        <span className="row-field-label">Ritch (optional)</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          step={1}
                          placeholder="e.g. 12345"
                          value={row.ritch}
                          onChange={e => updateRow(row.id, { ritch: e.target.value })}
                          disabled={row.status === 'uploading' || row.status === 'done'}
                        />
                      </label>
                      <label className="row-field row-field-num">
                        <span className="row-field-label">Wizard Level (optional)</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          /* min=1, max=99 are loose sanity bounds — the
                             actual in-game cap isn't confirmed yet. */
                          min={1}
                          max={99}
                          step={1}
                          placeholder="e.g. 24"
                          value={row.wizardLevel}
                          onChange={e => updateRow(row.id, { wizardLevel: e.target.value })}
                          disabled={row.status === 'uploading' || row.status === 'done'}
                        />
                      </label>
                    </div>
                    <div className="row-status-cell">
                      <StatusBadge status={row.status} ready={rowReady(row)} />
                      {row.status === 'failed' && (
                        <button
                          type="button"
                          className="retry-btn"
                          onClick={() => retryRow(row.id)}
                          disabled={busy}
                        >
                          Retry
                        </button>
                      )}
                      {row.status !== 'uploading' && (
                        <button
                          type="button"
                          className="remove-btn"
                          onClick={() => removeRow(row.id)}
                          aria-label={`Remove ${row.file.name}`}
                          title="Remove"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                  {isOther && row.status !== 'done' && (
                    <input
                      type="text"
                      className="row-other-input"
                      value={otherText}
                      placeholder="Type the emulator / flashcart / setup name"
                      maxLength={100}
                      onChange={e => setRowOtherText(row.id, e.target.value)}
                      disabled={row.status === 'uploading'}
                    />
                  )}
                  {row.rowError && <div className="row-error">{row.rowError}</div>}
                  {row.error && <div className="row-error">Upload failed: {row.error}</div>}
                </li>
              );
            })}
          </ul>
        )}

        {batchError && <div className="form-error">{batchError}</div>}
        {batchPosted && (
          <div className="form-posted">
            Thanks - your saves uploaded. They only show up in the admin
            tool, not on the public site. Add more or close this tab.
          </div>
        )}

        <div className="form-actions">
          <span className="batch-count">
            {rows.length === 0
              ? 'No files yet.'
              : pendingCount === 0
              ? `${rows.length} file${rows.length === 1 ? '' : 's'} uploaded.`
              : `${pendingCount} file${pendingCount === 1 ? '' : 's'} ready.`}
          </span>
          <button
            type="submit"
            className="submit-btn"
            disabled={busy || rows.length === 0 || pendingCount === 0}
          >
            {busy
              ? 'Uploading...'
              : `Submit ${pendingCount || ''} save${pendingCount === 1 ? '' : 's'}`.trim()}
          </button>
        </div>
      </form>

      <style>{`
        .board-status { padding: 60px 20px; text-align: center; color: var(--color-ink-soft); background: var(--surface-strong); border-radius: var(--radius-lg); border: 1px solid var(--color-pink-100); }
        .board-status code { background: var(--color-purple-50); padding: 2px 6px; border-radius: 4px; }

        .save-wrap { max-width: 860px; margin: 0 auto; }
        .save-batch {
          background: white;
          padding: 22px 24px;
          border-radius: var(--radius-lg);
          border: 1px solid var(--color-pink-100);
          box-shadow: var(--shadow-soft);
          display: flex; flex-direction: column; gap: 18px;
        }

        .drop-zone {
          position: relative;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 6px;
          padding: 36px 20px;
          border: 2px dashed var(--color-purple-100);
          border-radius: var(--radius-lg);
          background: linear-gradient(135deg, var(--color-purple-50), var(--color-pink-50));
          color: var(--color-ink);
          cursor: pointer;
          text-align: center;
          transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
        }
        .drop-zone:hover, .drop-zone:focus-visible {
          border-color: var(--color-purple-400);
          outline: none;
        }
        .drop-zone.is-over {
          border-color: var(--color-pink-400);
          background: linear-gradient(135deg, #fde6f1, #f0e6fb);
          transform: translateY(-1px);
        }
        .drop-zone.has-files { padding: 22px 20px; }
        .dz-icon {
          font-size: 1.8rem; color: var(--color-purple-400); line-height: 1;
        }
        .dz-headline { font-size: 1rem; color: var(--color-ink); }
        .dz-headline strong { color: var(--color-purple-600); }
        .dz-hint { color: var(--color-ink-soft); font-size: 0.82rem; }
        .dz-input {
          position: absolute; width: 1px; height: 1px;
          opacity: 0; pointer-events: none;
        }

        .file-list {
          list-style: none; padding: 0; margin: 0;
          display: flex; flex-direction: column; gap: 10px;
        }
        .file-row {
          border: 1px solid var(--color-purple-100);
          background: var(--color-purple-50);
          border-radius: var(--radius-md);
          padding: 10px 12px;
          display: flex; flex-direction: column; gap: 8px;
        }
        .file-row.status-done { border-color: #b9e2c4; background: #ecfaf0; }
        .file-row.status-failed { border-color: var(--color-pink-200); background: var(--color-pink-50); }
        .file-row.status-uploading { border-color: var(--color-purple-400); background: white; }
        .file-row.has-row-error { border-color: var(--color-pink-400); }
        .row-main {
          display: grid;
          grid-template-columns: minmax(180px, 1.2fr) minmax(420px, 3fr) auto;
          gap: 12px;
          align-items: center;
        }
        .file-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .file-name {
          font-weight: 600; color: var(--color-purple-600);
          font-size: 0.9rem;
          overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
        }
        .file-size { color: var(--color-ink-soft); font-size: 0.78rem; }
        .row-selects {
          display: grid;
          grid-template-columns: minmax(160px, 1.4fr) 110px minmax(90px, 0.7fr) minmax(110px, 0.8fr);
          gap: 8px;
          min-width: 0;
        }
        .row-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .row-field-label {
          font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em;
          color: var(--color-purple-600); font-weight: 600;
        }
        .row-field select,
        .row-field input[type="number"] {
          padding: 7px 10px; border-radius: var(--radius-md);
          border: 1px solid var(--color-purple-100); background: white;
          color: var(--color-ink); font: inherit; font-size: 0.85rem;
          min-width: 0; width: 100%;
        }
        .row-field select:focus,
        .row-field input[type="number"]:focus {
          outline: 2px solid var(--color-pink-200);
        }
        .row-field select:disabled,
        .row-field input[type="number"]:disabled { opacity: 0.7; cursor: not-allowed; }
        .row-other-input {
          padding: 7px 10px; border-radius: var(--radius-md);
          border: 1px solid var(--color-purple-100); background: white;
          color: var(--color-ink); font: inherit; font-size: 0.85rem;
        }
        .row-other-input:focus { outline: 2px solid var(--color-pink-200); }
        .row-status-cell {
          display: flex; align-items: center; gap: 6px;
        }
        .remove-btn {
          width: 26px; height: 26px; border-radius: 50%;
          border: 1px solid var(--color-purple-100);
          background: white; color: var(--color-purple-600);
          font-size: 1rem; line-height: 1; cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center;
        }
        .remove-btn:hover { background: var(--color-pink-50); color: var(--color-pink-600); border-color: var(--color-pink-200); }
        .retry-btn {
          padding: 4px 10px; border-radius: var(--radius-pill);
          border: 1px solid var(--color-purple-100);
          background: white; color: var(--color-purple-600);
          font: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer;
        }
        .retry-btn:hover { background: var(--color-purple-50); }
        .retry-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .row-error {
          color: var(--color-pink-600);
          font-size: 0.8rem;
          background: white;
          border: 1px solid var(--color-pink-200);
          border-radius: var(--radius-md);
          padding: 6px 10px;
        }

        .status-badge {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 3px 8px; border-radius: var(--radius-pill);
          font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .status-badge.pending { background: white; color: var(--color-ink-soft); border: 1px solid var(--color-purple-100); }
        .status-badge.pending.needs-info { background: var(--color-pink-50); color: var(--color-pink-600); border: 1px solid var(--color-pink-200); }
        .status-badge.uploading { background: var(--color-purple-50); color: var(--color-purple-600); border: 1px solid var(--color-purple-100); }
        .status-badge.done { background: #d9f3df; color: #2c8a4a; border: 1px solid #b9e2c4; }
        .status-badge.failed { background: var(--color-pink-50); color: var(--color-pink-600); border: 1px solid var(--color-pink-200); }

        /* Honeypot stays visually-hidden via the .field.hp class. */
        .field.hp { position: absolute; left: -9999px; }
        .field.hp input { position: absolute; left: -9999px; }

        .form-error {
          color: var(--color-pink-600);
          background: var(--color-pink-50);
          padding: 10px 14px;
          border-radius: var(--radius-md);
          font-size: 0.88rem;
          border: 1px solid var(--color-pink-100);
        }
        .form-posted {
          color: #2c8a4a;
          background: #d9f3df;
          padding: 10px 14px;
          border-radius: var(--radius-md);
          font-size: 0.9rem;
          font-weight: 600;
        }
        .form-actions {
          display: flex; gap: 12px; justify-content: space-between; align-items: center;
          flex-wrap: wrap;
        }
        .batch-count { color: var(--color-ink-soft); font-size: 0.85rem; }
        .submit-btn {
          padding: 10px 22px; border-radius: var(--radius-pill);
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; border: none; font-weight: 700; cursor: pointer;
          font-family: inherit; font-size: 0.95rem;
          box-shadow: 0 6px 16px rgba(155, 123, 217, 0.35);
        }
        .submit-btn:hover { transform: translateY(-1px); }
        .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

        @media (max-width: 680px) {
          .row-main {
            grid-template-columns: 1fr;
            align-items: stretch;
          }
          .row-selects {
            grid-template-columns: 1fr 1fr;
          }
          .row-status-cell { justify-content: flex-end; }
        }
      `}</style>
    </div>
  );
}

function StatusBadge({ status, ready }: { status: RowStatus; ready?: boolean }) {
  // For pending rows we differentiate between "Needs info" (Source / Patch
  // not yet picked) and "Ready" (both picked). For all other statuses the
  // `ready` flag is ignored.
  const label =
    status === 'pending' ? (ready ? 'Ready' : 'Needs info') :
    status === 'uploading' ? 'Uploading…' :
    status === 'done' ? 'Done' :
    'Failed';
  const cls =
    status === 'pending' && !ready
      ? `status-badge ${status} needs-info`
      : `status-badge ${status}`;
  return <span className={cls}>{label}</span>;
}
