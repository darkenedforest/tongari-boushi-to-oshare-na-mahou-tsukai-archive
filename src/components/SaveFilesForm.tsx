import { useRef, useState } from 'react';
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
const MAX_REASON = 500;
const MAX_AUTHOR = 40;

const OTHER_SENTINEL = '__OTHER__';
const OTHER_PREFIX = 'Other: ';

const PATCH_VERSIONS = ['v2.31', 'v2.3', 'v2.2', 'v2.1', 'v2.0', 'Unsure'];

// Common DS save extensions. We don't enforce these strictly server-side
// (Supabase Storage doesn't care), but the accept attribute keeps the
// file picker filtered to plausible candidates on most OSes.
const ACCEPT_EXT =
  '.sav,.dsv,.duc,.savn,.dat,.bin,.SAV,.DSV,.DUC,.SAVN,.DAT,.BIN,application/octet-stream';

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

export default function SaveFilesForm() {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<string>('');
  const [patchVersion, setPatchVersion] = useState('');
  const [reason, setReason] = useState('');
  const [submitter, setSubmitter] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = (e.target.files || [])[0];
    if (!f) {
      setFile(null);
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setErr(
        `That file is ${bytesToHuman(f.size)}; the cap is ${bytesToHuman(MAX_FILE_BYTES)}. ` +
          "If your save is bigger than this, something's odd - check you didn't grab a ROM by accident."
      );
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    if (f.size === 0) {
      setErr('That file is empty (0 bytes). Did the file selector pick a stub?');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setErr(null);
    setFile(f);
  }

  function reset() {
    setFile(null);
    setSource('');
    setPatchVersion('');
    setReason('');
    setSubmitter('');
    if (fileInput.current) fileInput.current.value = '';
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (honeypot) return; // bot

    if (!file) {
      setErr('Pick a save file first.');
      return;
    }
    const sourceTrimmed = source.trim();
    if (!sourceTrimmed) {
      setErr('Tell me where the save came from (emulator name, hardware, etc).');
      return;
    }
    if (sourceTrimmed === OTHER_PREFIX.trim() || sourceTrimmed === OTHER_PREFIX) {
      setErr('You picked "Other" - please type the actual source.');
      return;
    }
    if (!supabaseConfigured || !supabase) {
      setErr("Backend isn't configured yet. (Site owner: see SUPABASE_SETUP.md)");
      return;
    }

    setBusy(true);
    try {
      // Path scheme: <YYYY>/<MM>/<uuid>/<original-filename>
      // Year/month grouping keeps the bucket browsable as it grows; the
      // UUID dir guarantees collisions are impossible even if two users
      // upload save.sav within the same minute.
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const cleaned = safeFilename(file.name);
      const filePath = `${yyyy}/${mm}/${randomToken()}/${cleaned}`;

      const { error: upErr } = await supabase.storage
        .from(SAVE_FILES_BUCKET)
        .upload(filePath, file, {
          contentType: file.type || 'application/octet-stream',
          cacheControl: '0',
          upsert: false,
        });
      if (upErr) throw upErr;

      const insertPayload = {
        filename: cleaned,
        file_path: filePath,
        file_size_bytes: file.size,
        save_source: sourceTrimmed.slice(0, 120),
        patch_version: patchVersion ? patchVersion.slice(0, 40) : null,
        debug_reason: reason.trim() ? reason.trim().slice(0, MAX_REASON) : null,
        submitter: submitter.trim() ? submitter.trim().slice(0, MAX_AUTHOR) : null,
      };
      const { error: insErr } = await supabase.from('save_files').insert(insertPayload);
      if (insErr) throw insErr;

      reset();
      setPosted(true);
      window.setTimeout(() => setPosted(false), 8000);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
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

  const isOtherSource = source.startsWith(OTHER_PREFIX);
  const sourceSelectValue = isOtherSource ? OTHER_SENTINEL : source;
  const otherSourceText = isOtherSource ? source.slice(OTHER_PREFIX.length) : '';

  return (
    <div className="save-wrap">
      <form className="save-form" onSubmit={submit}>
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

        <label className="field">
          <span className="field-label">Save file <span className="req">*</span></span>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT_EXT}
            onChange={pickFile}
            required
          />
          {file && (
            <span className="file-meta">
              <strong>{file.name}</strong> - {bytesToHuman(file.size)}
            </span>
          )}
          <span className="field-hint">
            Common DS save extensions: .sav, .dsv, .duc, .savn. Up to 4 MB.
          </span>
        </label>

        <label className="field">
          <span className="field-label">Where the save came from <span className="req">*</span></span>
          <select
            className="src-select"
            value={sourceSelectValue}
            onChange={e => {
              const v = e.target.value;
              if (v === OTHER_SENTINEL) setSource(OTHER_PREFIX);
              else setSource(v);
            }}
            required
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
          {isOtherSource && (
            <input
              type="text"
              className="src-other-input"
              value={otherSourceText}
              placeholder="Type the emulator / flashcart / setup name"
              maxLength={100}
              onChange={e => setSource(OTHER_PREFIX + e.target.value)}
              autoFocus
            />
          )}
        </label>

        <label className="field">
          <span className="field-label">Patch version used (optional)</span>
          <select
            value={patchVersion}
            onChange={e => setPatchVersion(e.target.value)}
          >
            <option value="">- Pick the patch version you ran the save on -</option>
            {PATCH_VERSIONS.map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">What does this save help debug? (optional)</span>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. 'Garbled text on the Charm-shop tab' or 'just sharing in case it's useful'."
            rows={4}
            maxLength={MAX_REASON}
          />
          <span className="field-hint counter">{reason.length} / {MAX_REASON}</span>
        </label>

        <label className="field">
          <span className="field-label">Your name / handle (optional)</span>
          <input
            type="text"
            value={submitter}
            onChange={e => setSubmitter(e.target.value)}
            placeholder="Anonymous"
            maxLength={MAX_AUTHOR}
          />
        </label>

        {err && <div className="form-error">{err}</div>}
        {posted && (
          <div className="form-posted">
            Thanks - your save uploaded. Submit another, or close this
            tab. It only shows up in my admin tool, not on the public site.
          </div>
        )}

        <div className="form-actions">
          <button type="submit" className="submit-btn" disabled={busy}>
            {busy ? 'Uploading...' : 'Submit save file'}
          </button>
        </div>
      </form>

      <style>{`
        .board-status { padding: 60px 20px; text-align: center; color: var(--color-ink-soft); background: var(--surface-strong); border-radius: var(--radius-lg); border: 1px solid var(--color-pink-100); }
        .board-status code { background: var(--color-purple-50); padding: 2px 6px; border-radius: 4px; }

        .save-wrap { max-width: 720px; margin: 0 auto; }
        .save-form {
          background: white;
          padding: 22px 24px;
          border-radius: var(--radius-lg);
          border: 1px solid var(--color-pink-100);
          box-shadow: var(--shadow-soft);
          display: flex; flex-direction: column; gap: 16px;
        }
        .field { display: flex; flex-direction: column; gap: 6px; }
        .field-label { font-weight: 600; color: var(--color-purple-600); font-size: 0.85rem; }
        .field .req { color: var(--color-pink-600); }
        .field-hint { color: var(--color-ink-soft); font-size: 0.78rem; }
        .field-hint.counter { align-self: flex-end; }
        .field input[type="text"], .field textarea, .field select, .src-other-input {
          padding: 10px 14px; border-radius: var(--radius-md);
          border: 1px solid var(--color-purple-100); background: var(--color-purple-50);
          color: var(--color-ink); font: inherit; resize: vertical;
        }
        .field input[type="file"] {
          padding: 8px 0; font: inherit; color: var(--color-ink);
        }
        .field input:focus, .field textarea:focus, .field select:focus, .src-other-input:focus {
          outline: 2px solid var(--color-pink-200); background: white;
        }
        .field.hp { position: absolute; left: -9999px; }
        .src-select { cursor: pointer; }
        .src-other-input { margin-top: 6px; background: white; }
        .file-meta { color: var(--color-ink); font-size: 0.88rem; padding-left: 2px; }
        .file-meta strong { color: var(--color-purple-600); }
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
        .form-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .submit-btn {
          padding: 10px 22px; border-radius: var(--radius-pill);
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; border: none; font-weight: 700; cursor: pointer;
          font-family: inherit; font-size: 0.95rem;
          box-shadow: 0 6px 16px rgba(155, 123, 217, 0.35);
        }
        .submit-btn:hover { transform: translateY(-1px); }
        .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
      `}</style>
    </div>
  );
}
