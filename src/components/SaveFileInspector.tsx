import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FORMAT_MAGIC_EXPECTED,
  REGION_DESCRIPTORS,
  parseSaveFile,
} from '../lib/savefile/parser';
import {
  applyEdits,
  rewrapForDownload,
  suffixFilenameForEdit,
  CATALOG_TEXT_MAX_CHARS,
  MAIL_TEXT_MAX_CHARS,
  PLAYER_NAME_MAX_CHARS,
  RESIDENT_NAME_MAX_CHARS,
  type PendingEdit,
} from '../lib/savefile/editor';
import {
  loadSavefileLookups,
  lookupPlantName,
  resolveInventoryItem,
  type SavefileLookups,
} from '../lib/savefile/lookups';
import type {
  Confidence,
  SaveParse,
  SlotLabel,
  SlotParse,
} from '../lib/savefile/types';

// All parsing happens client-side. No bytes ever leave the browser.
// Persisted notes live in localStorage keyed by the wrapper-stripped
// payload SHA so flags carry across reloads.

const ACCEPT_EXT =
  '.sav,.dsv,.duc,.savn,.dat,.bin,.SAV,.DSV,.DUC,.SAVN,.DAT,.BIN,application/octet-stream';

const MAX_FILE_BYTES = 4 * 1024 * 1024;

const NOTES_STORAGE_KEY_PREFIX = 'tongari-saveinspect-notes-';

interface SectionNote {
  regionId: string;
  regionTitle: string;
  body: string;
  parsedSnapshot: string;
  createdAt: string;
}

type NotesByRegion = Record<string, SectionNote>;

function bytesToHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function hex(n: number, width = 4): string {
  return '0x' + n.toString(16).padStart(width, '0');
}

function loadNotes(sha: string): NotesByRegion {
  if (!sha || typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(NOTES_STORAGE_KEY_PREFIX + sha);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as NotesByRegion;
  } catch {
    /* ignore */
  }
  return {};
}

function saveNotes(sha: string, notes: NotesByRegion) {
  if (!sha || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(NOTES_STORAGE_KEY_PREFIX + sha, JSON.stringify(notes));
  } catch {
    /* quota errors are non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Pending-edit state shared with SlotView
// ---------------------------------------------------------------------------

interface PendingEditMap {
  ritch?: { value: number };
  playerName?: { value: string };
  /** Keyed by entry's body offset within slot A. */
  catalog: Record<number, string>;
  mail: Record<number, string>;
  /** Keyed by resident slot's body offset. */
  residentName: Record<number, string>;
  /** Keyed by garden record's body offset. */
  gardenTile: Record<number, { plantId: number; growTime: number }>;
}

function makeEmptyEdits(): PendingEditMap {
  return {
    catalog: {},
    mail: {},
    residentName: {},
    gardenTile: {},
  };
}

interface EditCtx {
  edits: PendingEditMap;
  setEdits: React.Dispatch<React.SetStateAction<PendingEditMap>>;
}

function pendingEditCount(edits: PendingEditMap): number {
  let n = 0;
  if (edits.ritch !== undefined) n++;
  if (edits.playerName !== undefined) n++;
  n += Object.keys(edits.catalog).length;
  n += Object.keys(edits.mail).length;
  n += Object.keys(edits.residentName).length;
  n += Object.keys(edits.gardenTile).length;
  return n;
}

function editsToPendingList(edits: PendingEditMap): PendingEdit[] {
  const out: PendingEdit[] = [];
  if (edits.ritch !== undefined) {
    out.push({ kind: 'ritch', value: edits.ritch.value });
  }
  if (edits.playerName !== undefined) {
    out.push({ kind: 'player_name', value: edits.playerName.value });
  }
  for (const [k, v] of Object.entries(edits.catalog)) {
    out.push({ kind: 'catalog', entryOffset: Number(k), text: v });
  }
  for (const [k, v] of Object.entries(edits.mail)) {
    out.push({ kind: 'mail', entryOffset: Number(k), text: v });
  }
  for (const [k, v] of Object.entries(edits.residentName)) {
    out.push({ kind: 'resident_name', recordOffset: Number(k), name: v });
  }
  for (const [k, v] of Object.entries(edits.gardenTile)) {
    out.push({
      kind: 'garden_tile',
      recordOffset: Number(k),
      plantId: v.plantId,
      growTime: v.growTime,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline-edit primitive
// ---------------------------------------------------------------------------

interface InlineEditProps {
  label: string;
  pendingLabel?: string;
  beta?: boolean;
  // The currently-pending value, or null if no pending edit.
  pendingValue: string | null;
  // Default value shown in the input when the editor is opened with no
  // pending edit yet.
  initialDraft: string;
  /** Validation + commit handler. Return a string error to reject the
   *  edit, or null on success — the parent updates its edit state. */
  onCommit: (draft: string) => string | null;
  /** Remove any pending edit for this field. */
  onClear: () => void;
  /** Optional max chars for an <input>; if omitted renders a <textarea>. */
  maxChars?: number;
  multiline?: boolean;
}

function InlineEdit({
  label,
  pendingLabel,
  beta,
  pendingValue,
  initialDraft,
  onCommit,
  onClear,
  maxChars,
  multiline,
}: InlineEditProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(pendingValue ?? initialDraft);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(pendingValue ?? initialDraft);
  }, [pendingValue, initialDraft]);

  function commit() {
    const e = onCommit(draft);
    if (e) {
      setErr(e);
      return;
    }
    setErr(null);
    setOpen(false);
  }

  function clear() {
    onClear();
    setDraft(initialDraft);
    setErr(null);
  }

  return (
    <div className={`inline-edit ${pendingValue !== null ? 'has-pending' : ''}`}>
      {!open && (
        <button
          type="button"
          className="inline-edit-trigger"
          onClick={() => setOpen(true)}
        >
          {pendingValue !== null
            ? `Edit (pending: ${pendingLabel ?? pendingValue})`
            : `Edit ${label}`}
          {beta && <span className="beta-pill">BETA</span>}
        </button>
      )}
      {open && (
        <div className="inline-edit-body">
          {multiline ? (
            <textarea
              className="inline-edit-input"
              rows={3}
              maxLength={maxChars}
              value={draft}
              onChange={e => setDraft(e.target.value)}
            />
          ) : (
            <input
              className="inline-edit-input"
              type="text"
              maxLength={maxChars}
              value={draft}
              onChange={e => setDraft(e.target.value)}
            />
          )}
          {maxChars !== undefined && (
            <span className="inline-edit-counter">
              {draft.length}/{maxChars} chars
            </span>
          )}
          {err && <span className="inline-edit-error">{err}</span>}
          <div className="inline-edit-actions">
            <button type="button" className="inline-edit-save" onClick={commit}>
              Stage edit
            </button>
            <button
              type="button"
              className="inline-edit-cancel"
              onClick={() => {
                setDraft(pendingValue ?? initialDraft);
                setErr(null);
                setOpen(false);
              }}
            >
              Cancel
            </button>
            {pendingValue !== null && (
              <button type="button" className="inline-edit-clear" onClick={clear}>
                Drop pending
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Garden tile editor — slightly different layout (two numeric fields)
// ---------------------------------------------------------------------------

interface GardenTileEditorProps {
  currentPlantId: number;
  currentGrowTime: number;
  hasPending: boolean;
  onCommit: (plantId: number, growTime: number) => void;
  onClear: () => void;
}

function GardenTileEditor({
  currentPlantId,
  currentGrowTime,
  hasPending,
  onCommit,
  onClear,
}: GardenTileEditorProps) {
  const [open, setOpen] = useState(false);
  const [plantDraft, setPlantDraft] = useState(currentPlantId.toString());
  const [growDraft, setGrowDraft] = useState(currentGrowTime.toString());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setPlantDraft(currentPlantId.toString());
    setGrowDraft(currentGrowTime.toString());
  }, [currentPlantId, currentGrowTime]);

  if (!open) {
    return (
      <button
        type="button"
        className="inline-edit-trigger"
        onClick={() => setOpen(true)}
      >
        {hasPending ? 'Edit (pending)' : 'Edit'}
        <span className="beta-pill">BETA</span>
      </button>
    );
  }

  function commit() {
    const p = Number.parseInt(plantDraft, 10);
    const g = Number.parseInt(growDraft, 10);
    if (!Number.isFinite(p) || p < 0 || p > 255) {
      setErr('plant_id must be 0..255.');
      return;
    }
    if (!Number.isFinite(g) || g < 0 || g > 255) {
      setErr('grow_time must be 0..255.');
      return;
    }
    setErr(null);
    onCommit(p, g);
    setOpen(false);
  }

  return (
    <div className="inline-edit-body">
      <label className="inline-edit-label">
        plant_id
        <input
          className="inline-edit-input narrow"
          type="number"
          min={0}
          max={255}
          step={1}
          value={plantDraft}
          onChange={e => setPlantDraft(e.target.value)}
        />
      </label>
      <label className="inline-edit-label">
        grow_time
        <input
          className="inline-edit-input narrow"
          type="number"
          min={0}
          max={255}
          step={1}
          value={growDraft}
          onChange={e => setGrowDraft(e.target.value)}
        />
      </label>
      {err && <span className="inline-edit-error">{err}</span>}
      <div className="inline-edit-actions">
        <button type="button" className="inline-edit-save" onClick={commit}>
          Stage edit
        </button>
        <button
          type="button"
          className="inline-edit-cancel"
          onClick={() => {
            setOpen(false);
            setErr(null);
          }}
        >
          Cancel
        </button>
        {hasPending && (
          <button
            type="button"
            className="inline-edit-clear"
            onClick={() => {
              onClear();
              setOpen(false);
            }}
          >
            Drop pending
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small UI primitives
// ---------------------------------------------------------------------------

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const label =
    confidence === 'confirmed'
      ? 'Confirmed'
      : confidence === 'candidate'
        ? 'Candidate'
        : 'Disputed';
  return (
    <span className={`conf-badge conf-${confidence}`}>
      {label}
    </span>
  );
}

interface SectionProps {
  regionId: string;
  title: string;
  range: string;
  confidence: Confidence;
  parsedSnapshot: string;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
  children: React.ReactNode;
}

function Section({
  regionId,
  title,
  range,
  confidence,
  parsedSnapshot,
  notes,
  setNotes,
  fileLabel,
  payloadSha,
  children,
}: SectionProps) {
  const existing = notes[regionId];
  const [flagOpen, setFlagOpen] = useState(Boolean(existing));
  const [draft, setDraft] = useState(existing?.body ?? '');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    setDraft(existing?.body ?? '');
  }, [existing?.body]);

  function saveDraft() {
    const trimmed = draft.trim();
    if (!trimmed) {
      // Clearing the textarea removes the note.
      const next = { ...notes };
      delete next[regionId];
      setNotes(next);
      return;
    }
    const next: NotesByRegion = {
      ...notes,
      [regionId]: {
        regionId,
        regionTitle: title,
        body: trimmed,
        parsedSnapshot,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      },
    };
    setNotes(next);
  }

  async function copyBugReport() {
    const note = notes[regionId]?.body || draft.trim();
    const md = [
      `**Save file**: ${fileLabel} (SHA: ${payloadSha})`,
      `**Region**: ${title} — ${range}`,
      `**Issue**: ${note || '(write your note here)'}`,
      `**Parsed value**: ${parsedSnapshot || '(no value)'}`,
    ].join('\n');
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(md);
        setCopyState('copied');
        window.setTimeout(() => setCopyState('idle'), 1800);
        return;
      }
      throw new Error('clipboard unavailable');
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 2400);
    }
  }

  return (
    <section className={`region ${existing ? 'has-flag' : ''}`} id={`region-${regionId}`}>
      <header className="region-head">
        <div className="region-title-row">
          <h4 className="region-title">{title}</h4>
          <ConfidenceBadge confidence={confidence} />
          <button
            type="button"
            className="flag-btn"
            onClick={() => setFlagOpen(o => !o)}
            aria-expanded={flagOpen}
          >
            {existing ? 'Edit flag' : 'Flag issue'}
          </button>
        </div>
        <div className="region-range">{range}</div>
      </header>
      <div className="region-body">{children}</div>
      {flagOpen && (
        <div className="flag-area">
          <label className="flag-label" htmlFor={`note-${regionId}`}>
            Note (e.g. &quot;Ritch shows 0 but I have 50,000 in-game&quot;)
          </label>
          <textarea
            id={`note-${regionId}`}
            className="flag-textarea"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={saveDraft}
            rows={3}
            placeholder="What's wrong with this region?"
          />
          <div className="flag-actions">
            <button type="button" className="flag-save" onClick={saveDraft}>
              {existing ? 'Update note' : 'Save note'}
            </button>
            <button
              type="button"
              className="flag-copy"
              onClick={copyBugReport}
              disabled={!draft.trim() && !existing}
            >
              {copyState === 'copied'
                ? 'Copied!'
                : copyState === 'error'
                  ? 'Copy failed'
                  : 'Copy as bug report'}
            </button>
            {existing && (
              <button
                type="button"
                className="flag-clear"
                onClick={() => {
                  setDraft('');
                  const next = { ...notes };
                  delete next[regionId];
                  setNotes(next);
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Slot renderer
// ---------------------------------------------------------------------------

function HexPreview({ hex, max = 96 }: { hex: string; max?: number }) {
  if (!hex) return <span className="muted">(empty)</span>;
  const truncated = hex.length > max ? hex.slice(0, max) + '…' : hex;
  // Group into byte-pair tuples for readability.
  const groups = truncated.match(/.{1,2}/g) ?? [];
  return <code className="hex-preview">{groups.join(' ')}</code>;
}

interface SlotViewProps {
  slot: SlotParse;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
  editCtx: EditCtx;
  /** True iff this is the slot the user is currently inspecting AND the
   *  one we expose edit controls on. We only allow editing on slot A;
   *  every edit mirrors to both slots automatically. */
  editable: boolean;
  /** Lookup tables for ID -> EN-name cross-referencing. `null` until the
   *  fetch finishes; sections that need names should fall back gracefully. */
  lookups: SavefileLookups | null;
}

function SlotView({
  slot,
  notes,
  setNotes,
  fileLabel,
  payloadSha,
  editCtx,
  editable,
  lookups,
}: SlotViewProps) {
  if (slot.uninitialised) {
    return (
      <div className="slot-uninit">
        <p>
          <strong>Slot {slot.label}</strong> is uninitialised — the first 256 bytes are all
          0xFF, meaning this slot has never been written.
        </p>
      </div>
    );
  }

  const formatMagicOk = slot.formatVersionMagic === FORMAT_MAGIC_EXPECTED;
  const subcodeLabel =
    slot.formatVersionSubcode === 0x0900
      ? '0x0900 — v2.31 build'
      : slot.formatVersionSubcode === 0x102c
        ? '0x102C — 3DS GodMode9 dump'
        : `${hex(slot.formatVersionSubcode)} — unknown sub-code`;

  const labelArgs = { notes, setNotes, fileLabel, payloadSha };

  return (
    <div className="slot-view">
      {/* Checksum */}
      <Section
        regionId={`${slot.label}-checksum`}
        title={REGION_DESCRIPTORS.checksum.title}
        range={REGION_DESCRIPTORS.checksum.range}
        confidence={REGION_DESCRIPTORS.checksum.confidence}
        parsedSnapshot={`stored=${slot.checksum.storedHex} computed=${slot.checksum.computedHex} → ${slot.checksum.ok ? 'PASS' : 'FAIL'}`}
        {...labelArgs}
      >
        <div className={`csum-row ${slot.checksum.ok ? 'pass' : 'fail'}`}>
          <span className="csum-status">{slot.checksum.ok ? 'PASS' : 'FAIL'}</span>
          <div className="csum-detail">
            <span>Stored: <code>{slot.checksum.storedHex}</code></span>
            <span>Computed: <code>{slot.checksum.computedHex}</code></span>
          </div>
        </div>
        {!slot.checksum.ok && (
          <p className="csum-warn">
            The game will refuse to load this slot. Either the save was edited
            without recomputing the RFC1071 header checksum, or the file is
            corrupt.
          </p>
        )}
      </Section>

      {/* Body-level checksum — phase-7 / step-220 discovery, step-223 confirmed */}
      <Section
        regionId={`${slot.label}-bodyChecksum`}
        title={REGION_DESCRIPTORS.bodyChecksum.title}
        range={REGION_DESCRIPTORS.bodyChecksum.range}
        confidence={REGION_DESCRIPTORS.bodyChecksum.confidence}
        parsedSnapshot={`stored=${slot.bodyChecksum.storedHex} computed=${slot.bodyChecksum.computedHex} → ${slot.bodyChecksum.ok ? 'PASS' : 'FAIL'}`}
        {...labelArgs}
      >
        <div className={`csum-row ${slot.bodyChecksum.ok ? 'pass' : 'fail'}`}>
          <span className="csum-status">{slot.bodyChecksum.ok ? 'PASS' : 'FAIL'}</span>
          <div className="csum-detail">
            <span>Stored: <code>{slot.bodyChecksum.storedHex}</code></span>
            <span>Computed: <code>{slot.bodyChecksum.computedHex}</code></span>
          </div>
        </div>
        {!slot.bodyChecksum.ok && (
          <p className="csum-warn">
            Body-level checksum mismatch. This is the second integrity check
            the game performs after the slot-header csum; if it fails the
            game treats the slot as corrupt. Any editor that writes past
            body[0x14] must recompute this in addition to the header csum.
          </p>
        )}
        <p className="note-text">
          RFC1071 over body[0x14..0x14+0x1CDDC] with body[0x14:0x16] zeroed.
          Confirmed via 53/55 saves in our corpus.
        </p>
      </Section>

      {/* Extra[0] checksum — step-234 discovery, fixes Ritch-edit regression */}
      <Section
        regionId={`${slot.label}-extra0Checksum`}
        title={REGION_DESCRIPTORS.extra0Checksum.title}
        range={REGION_DESCRIPTORS.extra0Checksum.range}
        confidence={REGION_DESCRIPTORS.extra0Checksum.confidence}
        parsedSnapshot={`stored=${slot.extra0Checksum.storedHex} computed=${slot.extra0Checksum.computedHex} → ${slot.extra0Checksum.ok ? 'PASS' : 'FAIL'}`}
        {...labelArgs}
      >
        <div className={`csum-row ${slot.extra0Checksum.ok ? 'pass' : 'fail'}`}>
          <span className="csum-status">{slot.extra0Checksum.ok ? 'PASS' : 'FAIL'}</span>
          <div className="csum-detail">
            <span>Stored: <code>{slot.extra0Checksum.storedHex}</code></span>
            <span>Computed: <code>{slot.extra0Checksum.computedHex}</code></span>
          </div>
        </div>
        {!slot.extra0Checksum.ok && (
          <p className="csum-warn">
            Extra[0] checksum mismatch. This is the third integrity check
            the game performs (the per-slot Family-C meta record). Ritch
            (slot+0x1CFD0 = extra[0]+0x1E0) lives inside this region, so
            any Ritch edit must recompute this csum in addition to the
            body and header csums. Failing here is the most-likely cause
            of an in-game "save data is corrupt" message after a wallet
            edit.
          </p>
        )}
        <p className="note-text">
          RFC1071 over extra[0][0..0x22F8] with the first 2 bytes zeroed.
          Confirmed step-234 against 36/36 initialised extra[0] regions
          in our corpus.
        </p>
      </Section>

      {/* Version magic */}
      <Section
        regionId={`${slot.label}-versionMagic`}
        title={REGION_DESCRIPTORS.versionMagic.title}
        range={REGION_DESCRIPTORS.versionMagic.range}
        confidence={REGION_DESCRIPTORS.versionMagic.confidence}
        parsedSnapshot={`magic=${hex(slot.formatVersionMagic)} subcode=${hex(slot.formatVersionSubcode)}`}
        {...labelArgs}
      >
        <dl className="kv">
          <dt>Format magic (expect 0x0161)</dt>
          <dd>
            <code className={formatMagicOk ? 'ok' : 'bad'}>
              {hex(slot.formatVersionMagic)}
            </code>{' '}
            {formatMagicOk ? '✓' : '✗'}
          </dd>
          <dt>Format version sub-code</dt>
          <dd>{subcodeLabel}</dd>
          <dt>Per-slot save counter (body[0x00])</dt>
          <dd><code>{hex(slot.saveCounter, 2)}</code></dd>
          <dt>Active flag (body[0x06])</dt>
          <dd><code>{hex(slot.activeFlag, 2)}</code></dd>
          <dt>Other-slot byte (body[0x07])</dt>
          <dd><code>{hex(slot.otherSlotByte, 2)}</code></dd>
          <dt>Body-csum word (body[0x14:0x16])</dt>
          <dd>
            <code>{hex(slot.perSaveFingerprint)}</code>{' '}
            <span className="muted small">
              (this is the stored body-level checksum, not a fingerprint —
              see body checksum section above)
            </span>
          </dd>
        </dl>
      </Section>

      {/* Event flags */}
      <Section
        regionId={`${slot.label}-eventFlags`}
        title={REGION_DESCRIPTORS.eventFlags.title}
        range={REGION_DESCRIPTORS.eventFlags.range}
        confidence={REGION_DESCRIPTORS.eventFlags.confidence}
        parsedSnapshot={`${slot.eventFlags.setBits} bits set / ${slot.eventFlags.totalBytes} bytes`}
        {...labelArgs}
      >
        <p>
          <strong>{slot.eventFlags.setBits.toLocaleString()}</strong> event
          flags set out of ~{(slot.eventFlags.totalBytes * 8).toLocaleString()}{' '}
          total flag bits. Per-flag meanings (which quests are complete,
          which cutscenes have played, etc.) aren&apos;t individually mapped
          yet.
        </p>
        <details className="tile-details">
          <summary>Show raw bytes (first 64)</summary>
          <HexPreview hex={slot.eventFlags.previewHex} max={192} />
        </details>
      </Section>

      {/* Profile */}
      <Section
        regionId={`${slot.label}-profile`}
        title={REGION_DESCRIPTORS.profile.title}
        range={REGION_DESCRIPTORS.profile.range}
        confidence={REGION_DESCRIPTORS.profile.confidence}
        parsedSnapshot={`name=${JSON.stringify(slot.playerName)} last_save=${slot.lastSaveTimestamp.decoded} create=${slot.characterCreateTimestamp.decoded}`}
        {...labelArgs}
      >
        <dl className="kv">
          <dt>Player name (UTF-16 LE × 5)</dt>
          <dd>
            <strong className="player-name">
              {slot.playerName || <span className="muted">(empty)</span>}
            </strong>
            {editable && (
              <InlineEdit
                label="player name"
                pendingValue={editCtx.edits.playerName?.value ?? null}
                initialDraft={slot.playerName}
                maxChars={PLAYER_NAME_MAX_CHARS}
                onCommit={draft => {
                  if (draft.length > PLAYER_NAME_MAX_CHARS) {
                    return `Max ${PLAYER_NAME_MAX_CHARS} characters.`;
                  }
                  editCtx.setEdits(e => ({
                    ...e,
                    playerName: { value: draft },
                  }));
                  return null;
                }}
                onClear={() =>
                  editCtx.setEdits(e => {
                    const next = { ...e };
                    delete next.playerName;
                    return next;
                  })
                }
              />
            )}
          </dd>
        </dl>
      </Section>

      {/* Timestamps */}
      <Section
        regionId={`${slot.label}-timestamps`}
        title={REGION_DESCRIPTORS.timestamps.title}
        range={REGION_DESCRIPTORS.timestamps.range}
        confidence={REGION_DESCRIPTORS.timestamps.confidence}
        parsedSnapshot={`last_save=${slot.lastSaveTimestamp.decoded} char_create=${slot.characterCreateTimestamp.decoded}`}
        {...labelArgs}
      >
        <dl className="kv">
          <dt>Last save</dt>
          <dd>
            <span className="ts">{slot.lastSaveTimestamp.decoded}</span>{' '}
            <code className="muted">raw: {slot.lastSaveTimestamp.rawHex}</code>
          </dd>
          <dt>Character created</dt>
          <dd>
            <span className="ts">{slot.characterCreateTimestamp.decoded}</span>{' '}
            <code className="muted">raw: {slot.characterCreateTimestamp.rawHex}</code>
          </dd>
        </dl>
      </Section>

      {/* Wizard-level candidate — read-only, please test */}
      <Section
        regionId={`${slot.label}-wizardLevelCandidate`}
        title={REGION_DESCRIPTORS.wizardLevelCandidate.title}
        range={REGION_DESCRIPTORS.wizardLevelCandidate.range}
        confidence={REGION_DESCRIPTORS.wizardLevelCandidate.confidence}
        parsedSnapshot={`byte=0x${slot.wizardLevelCandidate.rawByte.toString(16).padStart(2, '0')} (${slot.wizardLevelCandidate.rawByte})`}
        {...labelArgs}
      >
        <dl className="kv">
          <dt>Raw byte value</dt>
          <dd>
            <code>0x{slot.wizardLevelCandidate.rawByte.toString(16).padStart(2, '0')}</code>{' '}
            ({slot.wizardLevelCandidate.rawByte})
          </dd>
        </dl>
        <p className="note-text">{slot.wizardLevelCandidate.note}</p>
        <p className="note-text">
          <strong>Read-only.</strong> No edit affordance until semantics are
          confirmed. If you can produce two saves at known different wizard
          ranks, that will pin this offset for the editor.
        </p>
      </Section>

      {/* Ritch */}
      <Section
        regionId={`${slot.label}-ritch`}
        title={REGION_DESCRIPTORS.ritch.title}
        range={REGION_DESCRIPTORS.ritch.range}
        confidence={REGION_DESCRIPTORS.ritch.confidence}
        parsedSnapshot={slot.ritch === null ? 'null (0xFFFFFFFF)' : `${slot.ritch} Ritch`}
        {...labelArgs}
      >
        {slot.ritch === null ? (
          <p className="muted">Wallet field is 0xFFFFFFFF — never written.</p>
        ) : (
          <p className="ritch-value">
            <strong>{slot.ritch.toLocaleString()}</strong> Ritch
          </p>
        )}
        {editable && (
          <InlineEdit
            label="Ritch"
            pendingValue={
              editCtx.edits.ritch !== undefined
                ? editCtx.edits.ritch.value.toString()
                : null
            }
            pendingLabel={
              editCtx.edits.ritch !== undefined
                ? editCtx.edits.ritch.value.toLocaleString()
                : undefined
            }
            initialDraft={slot.ritch?.toString() ?? '0'}
            onCommit={draft => {
              const v = Number.parseInt(draft, 10);
              if (!Number.isFinite(v) || v < 0 || v > 0xffffffff) {
                return 'Must be a whole number 0..4294967295.';
              }
              editCtx.setEdits(e => ({ ...e, ritch: { value: v } }));
              return null;
            }}
            onClear={() =>
              editCtx.setEdits(e => {
                const next = { ...e };
                delete next.ritch;
                return next;
              })
            }
          />
        )}
      </Section>

      {/* Region at body 0x4300 — semantics unconfirmed.
          Previously mis-labelled "Active inventory". Step-232 rejected
          that framework: no ARM9 accessor reads or writes body+0x4300,
          and the only previously-"confirmed" (cat,sub)->item mapping
          was an artifact of misreading a u16 LE item ID. We keep
          surfacing the raw bytes here READ-ONLY for ongoing research
          but no longer pretend they decode to inventory items. */}
      <Section
        regionId={`${slot.label}-inventory`}
        title={REGION_DESCRIPTORS.inventory.title}
        range={REGION_DESCRIPTORS.inventory.range}
        confidence={REGION_DESCRIPTORS.inventory.confidence}
        parsedSnapshot={`${slot.activeInventory.length} non-empty 8-byte records (raw — semantics unconfirmed)`}
        {...labelArgs}
      >
        <p className="note-text" style={{ marginTop: 0 }}>
          <strong>Previously misidentified as inventory slots.</strong> ARM9
          disassembly found no accessor touching this offset. The bytes
          shown below are real but their meaning is unknown — the
          (category, sub-index) &rarr; item_id decoding shipped through
          step-231 was an artifact of misreading a u16 LE item ID as a
          packed (cat&nbsp;&lt;&lt;&nbsp;8)|sub tuple, and the only save
          supposedly containing the &quot;confirmed&quot; Transmitter
          mapping does not contain that item ID anywhere in its payload.
          Inventory location is still being researched. Surfaced
          read-only as a research region; do not interpret the byte
          values as items.
        </p>
        {slot.activeInventory.length === 0 ? (
          <p className="muted">No non-empty 8-byte records at body[0x4300:0x4480].</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Body offset</th>
                <th className="col-right">First u16 LE</th>
                <th className="col-right">Trailing 6 bytes</th>
                <th>Corpus recurrence</th>
              </tr>
            </thead>
            <tbody>
              {slot.activeInventory.map(slotRow => {
                const u16 = ((slotRow.category << 8) | slotRow.subIndex) & 0xffff;
                const seenInSaves = lookups
                  ? resolveInventoryItem(lookups, slotRow.category, slotRow.subIndex).seenInSaves
                  : 0;
                return (
                  <tr key={slotRow.bodyOffset}>
                    <td>
                      <code>{hex(slotRow.bodyOffset, 4)}</code>
                    </td>
                    <td className="col-right">
                      <code>
                        {hex(u16, 4)}
                      </code>{' '}
                      <span className="muted small">({u16})</span>
                    </td>
                    <td className="col-right">
                      <code className="muted">{slotRow.trailingHex}</code>
                    </td>
                    <td>
                      {seenInSaves > 0 ? (
                        <span className="muted small">
                          first u16 byte-pattern recurs in {seenInSaves}{' '}
                          {seenInSaves === 1 ? 'save' : 'saves'} in our
                          corpus (byte-pattern stat only, not an item
                          decoding)
                        </span>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      {/* Activity log */}
      <Section
        regionId={`${slot.label}-activityLog`}
        title={REGION_DESCRIPTORS.activityLog.title}
        range={REGION_DESCRIPTORS.activityLog.range}
        confidence={REGION_DESCRIPTORS.activityLog.confidence}
        parsedSnapshot={`${slot.activityLog.filter(r => !r.sentinel).length} non-sentinel records / ${slot.activityLog.length} total slots`}
        {...labelArgs}
      >
        <p>
          <strong>{slot.activityLog.filter(r => !r.sentinel).length}</strong>{' '}
          populated records out of {slot.activityLog.length} total slots.
          Field semantics (date / sequence / count) aren&apos;t pinned yet, so
          the underlying bytes are surfaced as labelled integers rather than
          named events.
        </p>
        {(() => {
          const rows = slot.activityLog.filter(r => !r.sentinel).slice(0, 16);
          if (rows.length === 0) return <p className="muted">No populated records.</p>;
          return (
            <details className="tile-details">
              <summary>Show first {rows.length} populated record{rows.length === 1 ? '' : 's'} (raw fields)</summary>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Date or sequence</th>
                    <th>Count or state</th>
                    <th>Header bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.bodyOffset}>
                      <td>{i + 1}</td>
                      <td>{r.dateOrSequence.toLocaleString()}</td>
                      <td>{r.countOrState.toLocaleString()}</td>
                      <td><code className="muted hex-cell">{r.headerHex}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          );
        })()}
      </Section>

      {/* Collection stats */}
      <Section
        regionId={`${slot.label}-collectionStats`}
        title={REGION_DESCRIPTORS.collectionStats.title}
        range={REGION_DESCRIPTORS.collectionStats.range}
        confidence={REGION_DESCRIPTORS.collectionStats.confidence}
        parsedSnapshot={`${slot.collectionStats.length} records`}
        {...labelArgs}
      >
        {slot.collectionStats.length === 0 ? (
          <p className="muted">No records in this region.</p>
        ) : (
          <>
            <p>
              <strong>{slot.collectionStats.length}</strong> fixed-size
              collection-stat slots tracked. Per-field semantics
              (creature counts, set bits, etc.) haven&apos;t been pinned
              down yet — raw bytes are kept behind a toggle for debugging.
            </p>
            <details className="tile-details">
              <summary>Show raw bytes (14 per slot)</summary>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th>Raw bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {slot.collectionStats.map(r => (
                    <tr key={r.bodyOffset}>
                      <td>{r.index + 1}</td>
                      <td><code className="hex-cell muted">{r.rawHex}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </Section>

      {/* NPC records */}
      <Section
        regionId={`${slot.label}-npcRecords`}
        title={REGION_DESCRIPTORS.npcRecords.title}
        range={REGION_DESCRIPTORS.npcRecords.range}
        confidence={REGION_DESCRIPTORS.npcRecords.confidence}
        parsedSnapshot={`${slot.npcRecords.filter(r => !r.uninit && !r.vacant).length} populated records (sampled)`}
        {...labelArgs}
      >
        <p>
          Sampled roster of NPCs your player has interacted with. Names
          decode directly from the record header (UTF-16 LE) — no ID
          lookup needed. Per-NPC heart level / gift history fields
          haven&apos;t been pinned yet.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>NPC name</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {slot.npcRecords.map((r, i) => (
              <tr key={r.bodyOffset}>
                <td>{i + 1}</td>
                <td>
                  {r.name
                    ? <strong>{r.name}</strong>
                    : <span className="muted">{r.uninit ? '(never met)' : r.vacant ? '(record cleared)' : '(empty)'}</span>}
                </td>
                <td>{r.uninit ? 'never met' : r.vacant ? 'cleared' : 'known'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {slot.npcRecords.some(r => !r.uninit && !r.vacant) && (
          <details className="tile-details">
            <summary>Show raw record-header bytes (debug)</summary>
            <table className="data-table">
              <thead>
                <tr>
                  <th>NPC name</th>
                  <th>Next 32 bytes after name</th>
                </tr>
              </thead>
              <tbody>
                {slot.npcRecords.filter(r => !r.uninit && !r.vacant).map(r => (
                  <tr key={r.bodyOffset}>
                    <td>{r.name}</td>
                    <td><HexPreview hex={r.previewHex} max={64} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </Section>

      {/* Garden */}
      <Section
        regionId={`${slot.label}-garden`}
        title={REGION_DESCRIPTORS.garden.title}
        range={REGION_DESCRIPTORS.garden.range}
        confidence={REGION_DESCRIPTORS.garden.confidence}
        parsedSnapshot={`${slot.garden.populatedTiles}/${slot.garden.totalTiles} populated tiles`}
        {...labelArgs}
      >
        <p>
          <strong>{slot.garden.populatedTiles.toLocaleString()}</strong>{' '}
          populated tiles out of <strong>{slot.garden.totalTiles.toLocaleString()}</strong> slots.
        </p>
        {slot.garden.tiles.length > 0 && (
          <details className="tile-details">
            <summary>
              Show {slot.garden.tiles.length} populated tile
              {slot.garden.tiles.length === 1 ? '' : 's'}
            </summary>
            <p className="note-text">
              plant_id &rarr; name mapping isn&apos;t built yet, so each
              tile shows &quot;Plant ID NN (mapping pending)&quot; rather
              than a guessed name. grow_time is a small 0..255 counter
              the game advances as the plant matures.
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Plant</th>
                  <th>Grow time</th>
                  {editable && <th>Edit (beta)</th>}
                </tr>
              </thead>
              <tbody>
                {slot.garden.tiles.slice(0, 64).map((tile, i) => {
                  const pending = editCtx.edits.gardenTile[tile.bodyOffset];
                  const currentPlantId =
                    pending !== undefined ? pending.plantId : tile.plantId;
                  const currentGrow =
                    pending !== undefined ? pending.growTime : tile.growTime;
                  const plantName = lookups
                    ? lookupPlantName(lookups, currentPlantId)
                    : null;
                  const plantLabel =
                    plantName ?? `Plant ID ${currentPlantId} (mapping pending)`;
                  return (
                    <tr key={tile.bodyOffset}>
                      <td>{i + 1}</td>
                      <td>
                        {pending !== undefined ? (
                          <>
                            <span className="muted strike">
                              Plant ID {tile.plantId}
                            </span>{' '}
                            <strong>{plantLabel}</strong>
                          </>
                        ) : (
                          <strong>{plantLabel}</strong>
                        )}
                      </td>
                      <td>
                        {pending !== undefined ? (
                          <>
                            <span className="muted strike">{tile.growTime}</span>{' '}
                            <strong>{currentGrow}</strong>
                          </>
                        ) : (
                          currentGrow
                        )}
                      </td>
                      {editable && (
                        <td>
                          <GardenTileEditor
                            currentPlantId={currentPlantId}
                            currentGrowTime={currentGrow}
                            hasPending={pending !== undefined}
                            onCommit={(plantId, growTime) => {
                              editCtx.setEdits(prev => ({
                                ...prev,
                                gardenTile: {
                                  ...prev.gardenTile,
                                  [tile.bodyOffset]: { plantId, growTime },
                                },
                              }));
                            }}
                            onClear={() =>
                              editCtx.setEdits(prev => {
                                const next = { ...prev.gardenTile };
                                delete next[tile.bodyOffset];
                                return { ...prev, gardenTile: next };
                              })
                            }
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
                {slot.garden.tiles.length > 64 && (
                  <tr>
                    <td colSpan={editable ? 4 : 3}>
                      <span className="muted">
                        … {slot.garden.tiles.length - 64} more tile
                        {slot.garden.tiles.length - 64 === 1 ? '' : 's'} not shown
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </details>
        )}
      </Section>

      {/* Catalog */}
      <Section
        regionId={`${slot.label}-catalog`}
        title={REGION_DESCRIPTORS.catalog.title}
        range={REGION_DESCRIPTORS.catalog.range}
        confidence={REGION_DESCRIPTORS.catalog.confidence}
        parsedSnapshot={`${slot.catalogEntries.length} entries decoded`}
        {...labelArgs}
      >
        {slot.catalogEntries.length === 0 ? (
          <p className="muted">No catalog entries decoded.</p>
        ) : (
          <ol className="entries-list">
            {slot.catalogEntries.map((e, i) => {
              const pending = editCtx.edits.catalog[e.bodyOffset];
              return (
                <li key={e.bodyOffset}>
                  <div className="entry-meta">
                    <span>Announcement #{i + 1}</span>
                  </div>
                  <div className="entry-text">{e.text}</div>
                  {editable && (
                    <InlineEdit
                      label="catalog text"
                      beta
                      multiline
                      pendingValue={pending ?? null}
                      initialDraft={e.text}
                      maxChars={CATALOG_TEXT_MAX_CHARS}
                      onCommit={draft => {
                        if (draft.length > CATALOG_TEXT_MAX_CHARS) {
                          return `Max ${CATALOG_TEXT_MAX_CHARS} characters.`;
                        }
                        editCtx.setEdits(prev => ({
                          ...prev,
                          catalog: { ...prev.catalog, [e.bodyOffset]: draft },
                        }));
                        return null;
                      }}
                      onClear={() =>
                        editCtx.setEdits(prev => {
                          const next = { ...prev.catalog };
                          delete next[e.bodyOffset];
                          return { ...prev, catalog: next };
                        })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      {/* Mail */}
      <Section
        regionId={`${slot.label}-mail`}
        title={REGION_DESCRIPTORS.mail.title}
        range={REGION_DESCRIPTORS.mail.range}
        confidence={REGION_DESCRIPTORS.mail.confidence}
        parsedSnapshot={`${slot.mailEntries.length} mail bodies decoded`}
        {...labelArgs}
      >
        {slot.mailEntries.length === 0 ? (
          <p className="muted">No mail bodies decoded.</p>
        ) : (
          <ol className="entries-list">
            {slot.mailEntries.map((e, i) => {
              const pending = editCtx.edits.mail[e.bodyOffset];
              return (
                <li key={e.bodyOffset}>
                  <div className="entry-meta">
                    <span>Letter #{i + 1}</span>
                  </div>
                  <div className="entry-text">{e.text}</div>
                  {editable && (
                    <InlineEdit
                      label="mail text"
                      beta
                      multiline
                      pendingValue={pending ?? null}
                      initialDraft={e.text}
                      maxChars={MAIL_TEXT_MAX_CHARS}
                      onCommit={draft => {
                        if (draft.length > MAIL_TEXT_MAX_CHARS) {
                          return `Max ${MAIL_TEXT_MAX_CHARS} characters.`;
                        }
                        editCtx.setEdits(prev => ({
                          ...prev,
                          mail: { ...prev.mail, [e.bodyOffset]: draft },
                        }));
                        return null;
                      }}
                      onClear={() =>
                        editCtx.setEdits(prev => {
                          const next = { ...prev.mail };
                          delete next[e.bodyOffset];
                          return { ...prev, mail: next };
                        })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      {/* Bank log */}
      <Section
        regionId={`${slot.label}-bankLog`}
        title={REGION_DESCRIPTORS.bankLog.title}
        range={REGION_DESCRIPTORS.bankLog.range}
        confidence={REGION_DESCRIPTORS.bankLog.confidence}
        parsedSnapshot={`${slot.bankLog.length} populated records`}
        {...labelArgs}
      >
        {slot.bankLog.length === 0 ? (
          <p className="muted">No populated bank records.</p>
        ) : (
          <>
            <p>
              <strong>{slot.bankLog.length}</strong> bank transaction
              record{slot.bankLog.length === 1 ? '' : 's'} on file. Per-field
              decoding (deposit / withdraw / balance) isn&apos;t mapped yet,
              so the raw 6-byte payload is available behind a toggle for
              future analysis.
            </p>
            <details className="tile-details">
              <summary>Show raw transaction bytes</summary>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Txn</th>
                    <th>Raw bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {slot.bankLog.slice(0, 32).map((r, i) => (
                    <tr key={r.bodyOffset}>
                      <td>{i + 1}</td>
                      <td><code className="hex-cell muted">{r.rawHex}</code></td>
                    </tr>
                  ))}
                  {slot.bankLog.length > 32 && (
                    <tr>
                      <td colSpan={2}>
                        <span className="muted">
                          … {slot.bankLog.length - 32} more transaction
                          {slot.bankLog.length - 32 === 1 ? '' : 's'} not shown
                        </span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </details>
          </>
        )}
      </Section>

      {/* Residents */}
      <Section
        regionId={`${slot.label}-residents`}
        title={REGION_DESCRIPTORS.residents.title}
        range={REGION_DESCRIPTORS.residents.range}
        confidence={REGION_DESCRIPTORS.residents.confidence}
        parsedSnapshot={`${slot.residents.filter(r => r.state === 'active').length} active / ${slot.residents.length} slots`}
        {...labelArgs}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th>House</th>
              <th>Resident name</th>
              <th>State</th>
              {editable && <th>Edit name (beta)</th>}
            </tr>
          </thead>
          <tbody>
            {slot.residents.map(r => {
              const pending = editCtx.edits.residentName[r.bodyOffset];
              const stateLabel =
                r.state === 'active'
                  ? 'occupied'
                  : r.state === 'vacant'
                    ? 'vacant'
                    : 'never built';
              return (
                <tr key={r.bodyOffset} className={`resident-${r.state}`}>
                  <td>{r.index + 1}</td>
                  <td>
                    {r.state === 'active' ? (
                      <strong>{r.name}</strong>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{stateLabel}</td>
                  {editable && (
                    <td>
                      {r.state === 'active' ? (
                        <InlineEdit
                          label="resident name"
                          beta
                          pendingValue={pending ?? null}
                          initialDraft={r.name}
                          maxChars={RESIDENT_NAME_MAX_CHARS}
                          onCommit={draft => {
                            if (draft.length > RESIDENT_NAME_MAX_CHARS) {
                              return `Max ${RESIDENT_NAME_MAX_CHARS} characters.`;
                            }
                            editCtx.setEdits(e => ({
                              ...e,
                              residentName: { ...e.residentName, [r.bodyOffset]: draft },
                            }));
                            return null;
                          }}
                          onClear={() =>
                            editCtx.setEdits(e => {
                              const next = { ...e.residentName };
                              delete next[r.bodyOffset];
                              return { ...e, residentName: next };
                            })
                          }
                        />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SaveFileInspector() {
  const [fileMeta, setFileMeta] = useState<{ name: string; size: number } | null>(null);
  const [parse, setParse] = useState<SaveParse | null>(null);
  /** The raw bytes of the originally-supplied file, retained so we can
   *  preserve the .dsv footer when downloading edited saves. */
  const [originalFile, setOriginalFile] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [activeSlotTab, setActiveSlotTab] = useState<SlotLabel>('A');
  const [notes, setNotes] = useState<NotesByRegion>({});
  const [edits, setEdits] = useState<PendingEditMap>(makeEmptyEdits);
  const [betaBackedUp, setBetaBackedUp] = useState(false);
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle');
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Lookup tables (item / NPC / UCC names) loaded once on mount from
  // /data/savefile_lookups.json. While unloaded, the inspector renders
  // raw IDs with an honest "(loading names…)" caveat instead of fake names.
  const [lookups, setLookups] = useState<SavefileLookups | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSavefileLookups().then(result => {
      if (!cancelled) setLookups(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const editCtx = useMemo<EditCtx>(() => ({ edits, setEdits }), [edits]);
  const editCount = pendingEditCount(edits);

  // Reload notes whenever the parsed payload SHA changes.
  useEffect(() => {
    if (parse?.payloadSha256) {
      setNotes(loadNotes(parse.payloadSha256));
      if (parse.activeSlot) setActiveSlotTab(parse.activeSlot);
    } else {
      setNotes({});
    }
    // Each new file resets the pending-edit slate and the backup checkbox.
    setEdits(makeEmptyEdits());
    setBetaBackedUp(false);
    setDownloadState('idle');
    setDownloadMsg(null);
  }, [parse?.payloadSha256, parse?.activeSlot]);

  // Persist notes back to localStorage whenever they change.
  useEffect(() => {
    if (parse?.payloadSha256) saveNotes(parse.payloadSha256, notes);
  }, [parse?.payloadSha256, notes]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setParse(null);
    setFileMeta({ name: file.name, size: file.size });

    if (file.size === 0) {
      setError('File is empty (0 bytes).');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`File ${bytesToHuman(file.size)} exceeds the ${bytesToHuman(MAX_FILE_BYTES)} cap.`);
      return;
    }

    setParsing(true);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const result = await parseSaveFile(buf);
      setParse(result);
      setOriginalFile(buf);
      if (result.wrapper.error) {
        setError(result.wrapper.error);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setParsing(false);
    }
  }, []);

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    if (fileInput.current) fileInput.current.value = '';
  }

  function openPicker() {
    fileInput.current?.click();
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }

  function clearFile() {
    setFileMeta(null);
    setParse(null);
    setOriginalFile(null);
    setError(null);
    setEdits(makeEmptyEdits());
    setBetaBackedUp(false);
    setDownloadState('idle');
    setDownloadMsg(null);
  }

  function discardAllEdits() {
    setEdits(makeEmptyEdits());
    setDownloadState('idle');
    setDownloadMsg(null);
  }

  async function applyAndDownload() {
    if (!parse?.wrapper.payload || !originalFile || !fileMeta) return;
    setDownloadState('downloading');
    setDownloadMsg(null);
    try {
      const editList = editsToPendingList(edits);
      const result = applyEdits(parse.wrapper.payload, editList);
      const wrapperKind: 'dsv' | 'raw' =
        parse.wrapper.kind === 'dsv' ? 'dsv' : 'raw';
      const finalBytes = rewrapForDownload(result.payload, wrapperKind, originalFile);
      const outName = suffixFilenameForEdit(fileMeta.name);
      // Coerce to a fresh ArrayBuffer so Blob is happy in strict envs.
      const ab = new ArrayBuffer(finalBytes.byteLength);
      new Uint8Array(ab).set(finalBytes);
      const blob = new Blob([ab], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setDownloadState('done');
      setDownloadMsg(
        `Wrote ${outName} (${finalBytes.byteLength.toLocaleString()} bytes). ` +
          `New header csums: slot A ${result.slotAChecksumHex}, slot B ${result.slotBChecksumHex}. ` +
          `New body csums: slot A ${result.slotABodyChecksumHex}, slot B ${result.slotBBodyChecksumHex}. ` +
          `New extra[0] csums: slot A ${result.slotAExtra0ChecksumHex}, slot B ${result.slotBExtra0ChecksumHex}.`,
      );
    } catch (e: any) {
      setDownloadState('error');
      setDownloadMsg(e?.message || String(e));
    }
  }

  const slotForTab = activeSlotTab === 'A' ? parse?.slotA : parse?.slotB;
  const noteCount = Object.keys(notes).length;
  const payloadSha = parse?.payloadSha256 ?? '';
  const fileLabel = fileMeta?.name ?? 'unknown';

  return (
    <div className="inspector-wrap">
      <div className="inspector-card">
        <p className="privacy-pill">
          <strong>100% client-side.</strong> Your save bytes never leave this
          browser tab. Notes are stored locally and keyed by save hash.
        </p>

        {!fileMeta && (
          <div
            className={`drop-zone ${dragOver ? 'is-over' : ''}`}
            role="button"
            tabIndex={0}
            onClick={openPicker}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openPicker();
              }
            }}
            onDragOver={e => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={e => {
              e.preventDefault();
              setDragOver(false);
            }}
            onDrop={onDrop}
            aria-label="Drop a save file here, or click to choose."
          >
            <div className="dz-icon" aria-hidden>⌕</div>
            <div className="dz-headline">
              <strong>Drop a save file to inspect</strong> or click to choose
            </div>
            <div className="dz-hint">
              .sav, .dsv, .duc, .savn, .dat, .bin — nothing is uploaded.
            </div>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT_EXT}
              onChange={onPickFile}
              className="dz-input"
              tabIndex={-1}
            />
          </div>
        )}

        {fileMeta && (
          <div className="file-meta">
            <div className="file-meta-info">
              <strong>{fileMeta.name}</strong>
              <span className="muted">{bytesToHuman(fileMeta.size)}</span>
              {parsing && <span className="parsing">parsing…</span>}
              {parse && (
                <span className="muted small">
                  payload SHA: <code title={payloadSha}>{payloadSha.slice(0, 12)}…</code>
                </span>
              )}
              {noteCount > 0 && (
                <span className="note-count">
                  {noteCount} flagged region{noteCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <button type="button" className="clear-btn" onClick={clearFile}>
              Inspect a different file
            </button>
          </div>
        )}

        {error && <div className="inspector-error">{error}</div>}

        {parse && parse.wrapper.payload && (
          <>
            <Section
              regionId="wrapper"
              title={REGION_DESCRIPTORS.wrapper.title}
              range={REGION_DESCRIPTORS.wrapper.range}
              confidence={REGION_DESCRIPTORS.wrapper.confidence}
              parsedSnapshot={`kind=${parse.wrapper.kind} originalSize=${parse.wrapper.originalSize}`}
              notes={notes}
              setNotes={setNotes}
              fileLabel={fileLabel}
              payloadSha={payloadSha}
            >
              <dl className="kv">
                <dt>Original size</dt>
                <dd>{parse.wrapper.originalSize.toLocaleString()} bytes</dd>
                <dt>Wrapper kind</dt>
                <dd>
                  {parse.wrapper.kind === 'dsv'
                    ? 'DeSmuME .dsv (122-byte footer stripped)'
                    : parse.wrapper.kind === 'raw'
                      ? 'Raw 524288-byte EEPROM'
                      : 'Unknown'}
                </dd>
                {parse.wrapper.footerHex && (
                  <>
                    <dt>Footer bytes</dt>
                    <dd><HexPreview hex={parse.wrapper.footerHex} max={256} /></dd>
                  </>
                )}
                <dt>File SHA-256</dt>
                <dd><code className="hex-cell">{parse.fileSha256}</code></dd>
                <dt>Payload SHA-256</dt>
                <dd><code className="hex-cell">{parse.payloadSha256}</code></dd>
              </dl>
            </Section>

            {parse.preamble && (
              <Section
                regionId="preamble"
                title={REGION_DESCRIPTORS.preamble.title}
                range={REGION_DESCRIPTORS.preamble.range}
                confidence={REGION_DESCRIPTORS.preamble.confidence}
                parsedSnapshot={`title=${JSON.stringify(parse.preamble.titleMagic)} ctr=${parse.preamble.saveGenCounter}/${parse.preamble.saveGenCounterMirror}`}
                notes={notes}
                setNotes={setNotes}
                fileLabel={fileLabel}
                payloadSha={payloadSha}
              >
                <dl className="kv">
                  <dt>Title magic (UTF-16 LE × 8)</dt>
                  <dd>
                    <strong className={parse.preamble.titleMagicOk ? 'ok' : 'bad'}>
                      {parse.preamble.titleMagic || '(empty)'}
                    </strong>{' '}
                    {parse.preamble.titleMagicOk ? '✓ matches expected' : '✗ does not match とんがり　２．５'}
                  </dd>
                  <dt>Save-generation counter (0x10 / 0x11)</dt>
                  <dd>
                    <code>{hex(parse.preamble.saveGenCounter, 2)}</code> /{' '}
                    <code>{hex(parse.preamble.saveGenCounterMirror, 2)}</code>{' '}
                    {parse.preamble.counterPaired ? '✓ paired' : '✗ mismatch'}
                  </dd>
                  <dt>Active slot guess</dt>
                  <dd>
                    {parse.activeSlot ?? '(none)'} — {parse.activeSlotReason}
                  </dd>
                </dl>
              </Section>
            )}

            <div className="slot-tabs" role="tablist" aria-label="Save slots">
              <button
                role="tab"
                type="button"
                aria-selected={activeSlotTab === 'A'}
                className={`slot-tab ${activeSlotTab === 'A' ? 'active' : ''} ${parse.activeSlot === 'A' ? 'is-primary' : ''}`}
                onClick={() => setActiveSlotTab('A')}
              >
                Slot A {parse.activeSlot === 'A' && <span className="primary-tag">active</span>}
              </button>
              <button
                role="tab"
                type="button"
                aria-selected={activeSlotTab === 'B'}
                className={`slot-tab ${activeSlotTab === 'B' ? 'active' : ''} ${parse.activeSlot === 'B' ? 'is-primary' : ''}`}
                onClick={() => setActiveSlotTab('B')}
              >
                Slot B {parse.activeSlot === 'B' && <span className="primary-tag">active</span>}
              </button>
            </div>

            {slotForTab && (
              <SlotView
                slot={slotForTab}
                notes={notes}
                setNotes={setNotes}
                fileLabel={fileLabel}
                payloadSha={payloadSha}
                editCtx={editCtx}
                editable={activeSlotTab === 'A' && !slotForTab.uninitialised}
                lookups={lookups}
              />
            )}

            <section className="editor-footer">
              <div className="editor-banner">
                <strong>BETA — back up your original save first.</strong>{' '}
                Editing fields beyond Ritch and player name has not been
                tested in-game yet. If the modified save breaks something,
                you&apos;ll want the original to fall back to. Edits are
                applied to both slot A and slot B, with the 20-byte header
                checksum recomputed.
              </div>
              <label className="backup-check">
                <input
                  type="checkbox"
                  checked={betaBackedUp}
                  onChange={e => setBetaBackedUp(e.target.checked)}
                />
                <span>I have backed up my save.</span>
              </label>
              <div className="editor-actions">
                <span className="editor-count">
                  {editCount === 0
                    ? 'No pending edits.'
                    : `${editCount} pending edit${editCount === 1 ? '' : 's'}.`}
                </span>
                <button
                  type="button"
                  className="editor-discard"
                  onClick={discardAllEdits}
                  disabled={editCount === 0}
                >
                  Discard all pending edits
                </button>
                <button
                  type="button"
                  className="editor-save"
                  onClick={applyAndDownload}
                  disabled={
                    editCount === 0 ||
                    !betaBackedUp ||
                    downloadState === 'downloading'
                  }
                >
                  {downloadState === 'downloading'
                    ? 'Writing…'
                    : 'Save & download'}
                </button>
              </div>
              {downloadMsg && (
                <div
                  className={`download-msg ${downloadState === 'error' ? 'is-error' : downloadState === 'done' ? 'is-done' : ''}`}
                >
                  {downloadMsg}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <style>{`
        .inspector-wrap { max-width: 920px; margin: 0 auto; }
        .inspector-card {
          background: white;
          padding: 22px 24px;
          border-radius: var(--radius-lg);
          border: 1px solid var(--color-purple-100);
          box-shadow: var(--shadow-soft);
          display: flex; flex-direction: column; gap: 18px;
        }
        .privacy-pill {
          margin: 0;
          padding: 10px 14px;
          background: linear-gradient(135deg, var(--color-purple-50), var(--color-pink-50));
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
          color: var(--color-ink);
          font-size: 0.88rem;
          line-height: 1.5;
        }
        .privacy-pill strong { color: var(--color-purple-600); }

        .drop-zone {
          position: relative;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 6px; padding: 36px 20px;
          border: 2px dashed var(--color-purple-100);
          border-radius: var(--radius-lg);
          background: linear-gradient(135deg, var(--color-purple-50), var(--color-pink-50));
          color: var(--color-ink); cursor: pointer; text-align: center;
          transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
        }
        .drop-zone:hover, .drop-zone:focus-visible {
          border-color: var(--color-purple-400); outline: none;
        }
        .drop-zone.is-over {
          border-color: var(--color-pink-400);
          background: linear-gradient(135deg, #fde6f1, #f0e6fb);
          transform: translateY(-1px);
        }
        .dz-icon { font-size: 1.8rem; color: var(--color-purple-400); line-height: 1; }
        .dz-headline strong { color: var(--color-purple-600); }
        .dz-hint { color: var(--color-ink-soft); font-size: 0.82rem; }
        .dz-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

        .file-meta {
          display: flex; justify-content: space-between; align-items: center;
          gap: 14px; flex-wrap: wrap;
          padding: 12px 14px;
          background: var(--color-purple-50);
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
        }
        .file-meta-info {
          display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
          color: var(--color-ink); font-size: 0.92rem;
        }
        .file-meta-info strong { color: var(--color-purple-600); }
        .file-meta-info .muted { color: var(--color-ink-soft); font-size: 0.82rem; }
        .file-meta-info .small { font-size: 0.78rem; }
        .file-meta-info .parsing {
          color: var(--color-pink-600); font-size: 0.82rem; font-style: italic;
        }
        .note-count {
          padding: 2px 10px; border-radius: var(--radius-pill);
          background: var(--color-pink-50); color: var(--color-pink-600);
          border: 1px solid var(--color-pink-200);
          font-size: 0.78rem; font-weight: 600;
        }
        .clear-btn {
          padding: 6px 14px; border-radius: var(--radius-pill);
          background: white; border: 1px solid var(--color-purple-100);
          color: var(--color-purple-600); font-weight: 600;
          font: inherit; font-size: 0.85rem; cursor: pointer;
        }
        .clear-btn:hover { background: var(--color-purple-50); }

        .inspector-error {
          color: var(--color-pink-600);
          background: var(--color-pink-50);
          padding: 10px 14px;
          border-radius: var(--radius-md);
          font-size: 0.88rem;
          border: 1px solid var(--color-pink-100);
        }

        .slot-tabs {
          display: flex; gap: 6px; border-bottom: 1px solid var(--color-purple-100);
          margin-top: 6px;
        }
        .slot-tab {
          padding: 8px 16px;
          border: 1px solid var(--color-purple-100); border-bottom: none;
          border-top-left-radius: var(--radius-md);
          border-top-right-radius: var(--radius-md);
          background: white; color: var(--color-ink-soft);
          font: inherit; font-size: 0.88rem; font-weight: 600;
          cursor: pointer;
          position: relative; top: 1px;
        }
        .slot-tab.active {
          background: var(--color-purple-50);
          color: var(--color-purple-600);
          border-color: var(--color-purple-400);
        }
        .primary-tag {
          margin-left: 6px; padding: 1px 8px;
          background: var(--color-pink-50);
          color: var(--color-pink-600);
          border-radius: var(--radius-pill);
          font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em;
        }

        .region {
          background: white;
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
          padding: 14px 16px;
          display: flex; flex-direction: column; gap: 8px;
        }
        .region.has-flag { border-color: var(--color-pink-400); }
        .region-head { display: flex; flex-direction: column; gap: 2px; }
        .region-title-row {
          display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        }
        .region-title {
          margin: 0; font-size: 1rem; color: var(--color-purple-600); font-weight: 700;
        }
        .region-range {
          color: var(--color-ink-soft); font-size: 0.78rem; font-family: var(--font-mono, monospace);
        }
        .region-body { font-size: 0.9rem; color: var(--color-ink); }
        .region-body p { margin: 4px 0; }

        .conf-badge {
          padding: 2px 8px; border-radius: var(--radius-pill);
          font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em;
          font-weight: 600;
        }
        .conf-confirmed {
          background: #d9f3df; color: #2c8a4a; border: 1px solid #b9e2c4;
        }
        .conf-candidate {
          background: var(--color-pink-50); color: var(--color-pink-600);
          border: 1px solid var(--color-pink-200);
        }
        .conf-disputed {
          background: #fde4d2; color: #a64a1a; border: 1px solid #f5c69e;
        }

        .flag-btn {
          margin-left: auto;
          padding: 4px 12px; border-radius: var(--radius-pill);
          background: white; border: 1px solid var(--color-purple-100);
          color: var(--color-purple-600); font-weight: 600;
          font: inherit; font-size: 0.78rem; cursor: pointer;
        }
        .flag-btn:hover { background: var(--color-pink-50); border-color: var(--color-pink-200); color: var(--color-pink-600); }

        .flag-area {
          margin-top: 4px;
          padding: 10px 12px;
          background: var(--color-pink-50);
          border: 1px solid var(--color-pink-100);
          border-radius: var(--radius-md);
          display: flex; flex-direction: column; gap: 8px;
        }
        .flag-label {
          font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em;
          color: var(--color-pink-600); font-weight: 600;
        }
        .flag-textarea {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid var(--color-pink-200);
          border-radius: var(--radius-md);
          background: white;
          font: inherit;
          font-size: 0.88rem;
          color: var(--color-ink);
          resize: vertical;
        }
        .flag-textarea:focus { outline: 2px solid var(--color-pink-200); }
        .flag-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .flag-save, .flag-copy, .flag-clear {
          padding: 6px 14px; border-radius: var(--radius-pill);
          font: inherit; font-size: 0.82rem; font-weight: 600; cursor: pointer;
        }
        .flag-save {
          background: white; border: 1px solid var(--color-purple-100);
          color: var(--color-purple-600);
        }
        .flag-save:hover { background: var(--color-purple-50); }
        .flag-copy {
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; border: none;
        }
        .flag-copy:hover { transform: translateY(-1px); }
        .flag-copy:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .flag-clear {
          background: white; border: 1px solid var(--color-pink-200);
          color: var(--color-pink-600);
        }
        .flag-clear:hover { background: var(--color-pink-50); }

        .slot-view { display: flex; flex-direction: column; gap: 12px; }
        .slot-uninit {
          padding: 12px 16px;
          background: var(--color-purple-50);
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
          color: var(--color-ink-soft);
        }

        .csum-row {
          display: flex; align-items: center; gap: 16px;
          padding: 10px 14px; border-radius: var(--radius-md);
        }
        .csum-row.pass {
          background: #d9f3df; border: 1px solid #b9e2c4;
        }
        .csum-row.fail {
          background: var(--color-pink-50); border: 1px solid var(--color-pink-200);
        }
        .csum-status {
          font-size: 1.1rem; font-weight: 800; letter-spacing: 0.04em;
        }
        .csum-row.pass .csum-status { color: #2c8a4a; }
        .csum-row.fail .csum-status { color: var(--color-pink-600); }
        .csum-detail { display: flex; flex-direction: column; gap: 2px; font-size: 0.85rem; color: var(--color-ink); }
        .csum-warn {
          margin-top: 6px; padding: 8px 12px;
          background: white;
          border-left: 4px solid var(--color-pink-400);
          border-radius: var(--radius-md);
          color: var(--color-ink);
          font-size: 0.85rem;
        }

        dl.kv {
          margin: 0;
          display: grid;
          grid-template-columns: minmax(180px, max-content) 1fr;
          gap: 6px 16px;
          font-size: 0.88rem;
        }
        dl.kv dt {
          color: var(--color-purple-600);
          font-weight: 600;
          font-size: 0.82rem;
        }
        dl.kv dd { margin: 0; color: var(--color-ink); }
        dl.kv code { background: var(--color-purple-50); padding: 1px 6px; border-radius: 4px; font-size: 0.85rem; }
        dl.kv code.ok { background: #d9f3df; color: #2c8a4a; }
        dl.kv code.bad { background: var(--color-pink-50); color: var(--color-pink-600); }
        dl.kv code.muted { background: transparent; color: var(--color-ink-soft); padding: 0; }

        .player-name {
          font-size: 1.05rem; color: var(--color-purple-600);
        }
        .ritch-value strong { font-size: 1.1rem; color: var(--color-purple-600); }
        .ts { font-variant-numeric: tabular-nums; }

        .data-table {
          width: 100%; border-collapse: collapse; margin-top: 6px;
          font-size: 0.82rem;
        }
        .data-table th, .data-table td {
          text-align: left; padding: 5px 8px;
          border-bottom: 1px solid var(--color-purple-50);
        }
        .data-table th {
          color: var(--color-purple-600); font-weight: 600;
          font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.04em;
        }
        .data-table tr.resident-active { background: rgba(217, 243, 223, 0.4); }
        .data-table tr.resident-uninit { color: var(--color-ink-soft); }
        .data-table tr.resident-vacant { color: var(--color-ink-soft); font-style: italic; }
        .data-table .col-right { text-align: right; }
        .data-table .small { font-size: 0.74rem; }
        .hex-cell, .hex-preview {
          font-family: var(--font-mono, monospace);
          font-size: 0.78rem;
          color: var(--color-ink);
          word-break: break-all;
        }

        .entries-list {
          margin: 0; padding: 0; list-style: none;
          display: flex; flex-direction: column; gap: 8px;
          max-height: 320px; overflow-y: auto;
        }
        .entries-list li {
          background: var(--color-purple-50);
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
          padding: 8px 10px;
        }
        .entry-meta {
          display: flex; gap: 12px; flex-wrap: wrap;
          color: var(--color-ink-soft); font-size: 0.74rem;
          margin-bottom: 4px;
        }
        .entry-text { font-size: 0.9rem; color: var(--color-ink); white-space: pre-wrap; }

        .note-text {
          font-size: 0.8rem; color: var(--color-ink-soft); font-style: italic;
        }
        .muted { color: var(--color-ink-soft); }
        .strike { text-decoration: line-through; }

        .tile-details summary {
          cursor: pointer;
          color: var(--color-purple-600);
          font-size: 0.85rem;
          font-weight: 600;
          padding: 4px 0;
        }
        .tile-details summary:hover { color: var(--color-pink-600); }

        /* Inline-edit primitives */
        .inline-edit { display: inline-block; margin-top: 4px; }
        .inline-edit-trigger {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 3px 10px; border-radius: var(--radius-pill);
          background: white; border: 1px solid var(--color-purple-100);
          color: var(--color-purple-600);
          font: inherit; font-size: 0.78rem; font-weight: 600;
          cursor: pointer;
        }
        .inline-edit-trigger:hover {
          background: var(--color-purple-50);
        }
        .inline-edit.has-pending .inline-edit-trigger {
          background: #fffbe6;
          border-color: #f3d774;
          color: #8a6a14;
        }
        .beta-pill {
          font-size: 0.62rem; font-weight: 700; letter-spacing: 0.06em;
          padding: 1px 6px; border-radius: var(--radius-pill);
          background: var(--color-pink-50); color: var(--color-pink-600);
          border: 1px solid var(--color-pink-200);
        }
        .inline-edit-body {
          margin-top: 6px;
          padding: 8px 10px;
          background: white;
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
          display: flex; flex-direction: column; gap: 6px;
          max-width: 420px;
        }
        .inline-edit-input {
          width: 100%;
          padding: 6px 10px;
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
          background: white;
          font: inherit; font-size: 0.88rem;
          color: var(--color-ink);
        }
        .inline-edit-input.narrow { width: 90px; }
        .inline-edit-input:focus { outline: 2px solid var(--color-purple-100); }
        .inline-edit-label {
          display: inline-flex; gap: 6px; align-items: center;
          font-size: 0.78rem; color: var(--color-purple-600); font-weight: 600;
        }
        .inline-edit-counter {
          font-size: 0.72rem; color: var(--color-ink-soft);
          align-self: flex-end;
        }
        .inline-edit-error {
          font-size: 0.78rem; color: var(--color-pink-600);
        }
        .inline-edit-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .inline-edit-save, .inline-edit-cancel, .inline-edit-clear {
          padding: 4px 10px; border-radius: var(--radius-pill);
          font: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer;
        }
        .inline-edit-save {
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; border: none;
        }
        .inline-edit-save:hover { transform: translateY(-1px); }
        .inline-edit-cancel {
          background: white; border: 1px solid var(--color-purple-100);
          color: var(--color-purple-600);
        }
        .inline-edit-cancel:hover { background: var(--color-purple-50); }
        .inline-edit-clear {
          background: white; border: 1px solid var(--color-pink-200);
          color: var(--color-pink-600);
        }
        .inline-edit-clear:hover { background: var(--color-pink-50); }

        /* Editor footer */
        .editor-footer {
          margin-top: 10px;
          padding: 14px 16px;
          background: white;
          border: 2px solid #f3d774;
          border-radius: var(--radius-lg);
          display: flex; flex-direction: column; gap: 10px;
        }
        .editor-banner {
          padding: 10px 14px;
          background: #fff7d6;
          border-left: 4px solid #d99e1f;
          border-radius: var(--radius-md);
          color: #5c4413;
          font-size: 0.88rem;
          line-height: 1.5;
        }
        .editor-banner strong { color: #b3700c; }
        .backup-check {
          display: inline-flex; align-items: center; gap: 8px;
          color: var(--color-ink); font-size: 0.9rem;
        }
        .backup-check input { width: 16px; height: 16px; }
        .editor-actions {
          display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
        }
        .editor-count {
          color: var(--color-ink); font-size: 0.9rem;
          margin-right: auto;
        }
        .editor-discard {
          padding: 6px 14px; border-radius: var(--radius-pill);
          background: white; border: 1px solid var(--color-purple-100);
          color: var(--color-purple-600); font-weight: 600;
          font: inherit; font-size: 0.85rem; cursor: pointer;
        }
        .editor-discard:hover { background: var(--color-purple-50); }
        .editor-discard:disabled { opacity: 0.4; cursor: not-allowed; }
        .editor-save {
          padding: 8px 18px; border-radius: var(--radius-pill);
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; border: none; font-weight: 700;
          font: inherit; font-size: 0.95rem; cursor: pointer;
          box-shadow: 0 6px 16px rgba(155, 123, 217, 0.35);
        }
        .editor-save:hover { transform: translateY(-1px); }
        .editor-save:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }
        .download-msg {
          padding: 8px 12px;
          background: var(--color-purple-50);
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
          color: var(--color-ink);
          font-size: 0.85rem;
          word-break: break-word;
        }
        .download-msg.is-done {
          background: #d9f3df; color: #2c8a4a; border-color: #b9e2c4;
        }
        .download-msg.is-error {
          background: var(--color-pink-50); color: var(--color-pink-600); border-color: var(--color-pink-200);
        }
      `}</style>
    </div>
  );
}
