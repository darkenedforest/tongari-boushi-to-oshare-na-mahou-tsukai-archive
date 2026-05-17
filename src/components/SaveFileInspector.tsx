import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FORMAT_MAGIC_EXPECTED,
  REGION_DESCRIPTORS,
  parseSaveFile,
} from '../lib/savefile/parser';
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
// Small UI primitives
// ---------------------------------------------------------------------------

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <span className={`conf-badge conf-${confidence}`}>
      {confidence === 'confirmed' ? 'Confirmed' : 'Candidate'}
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
}

function SlotView({ slot, notes, setNotes, fileLabel, payloadSha }: SlotViewProps) {
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
          <dt>Per-save fingerprint (body[0x14:0x16])</dt>
          <dd><code>{hex(slot.perSaveFingerprint)}</code></dd>
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
          <strong>{slot.eventFlags.setBits.toLocaleString()}</strong> bits set across{' '}
          <strong>{slot.eventFlags.totalBytes}</strong> bytes. First 64 bytes:
        </p>
        <HexPreview hex={slot.eventFlags.previewHex} max={192} />
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
      </Section>

      {/* Active inventory */}
      <Section
        regionId={`${slot.label}-inventory`}
        title={REGION_DESCRIPTORS.inventory.title}
        range={REGION_DESCRIPTORS.inventory.range}
        confidence={REGION_DESCRIPTORS.inventory.confidence}
        parsedSnapshot={`${slot.activeInventory.length} occupied slots`}
        {...labelArgs}
      >
        {slot.activeInventory.length === 0 ? (
          <p className="muted">No items in active inventory.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Body offset</th>
                <th>Category</th>
                <th>Sub-index</th>
                <th>Trailing 6 bytes</th>
              </tr>
            </thead>
            <tbody>
              {slot.activeInventory.map(slotRow => (
                <tr key={slotRow.bodyOffset}>
                  <td><code>{hex(slotRow.bodyOffset)}</code></td>
                  <td>{slotRow.category}</td>
                  <td>{slotRow.subIndex}</td>
                  <td><code className="hex-cell">{slotRow.trailingHex}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="note-text">
          Item-name lookup table isn&apos;t built yet — these are raw
          (category, sub-index) pairs from the packed u16.
        </p>
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
        <p className="note-text">
          {slot.activityLog.filter(r => !r.sentinel).length} non-sentinel records
          out of {slot.activityLog.length} slots. Semantics unconfirmed — showing
          first 16 non-empty rows.
        </p>
        {(() => {
          const rows = slot.activityLog.filter(r => !r.sentinel).slice(0, 16);
          if (rows.length === 0) return <p className="muted">No populated records.</p>;
          return (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Offset</th>
                  <th>Header (3 b)</th>
                  <th>Date/seq (u32 LE)</th>
                  <th>Count/state (u16 LE)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.bodyOffset}>
                    <td><code>{hex(r.bodyOffset)}</code></td>
                    <td><code className="hex-cell">{r.headerHex}</code></td>
                    <td>{r.dateOrSequence}</td>
                    <td>{r.countOrState}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Offset</th>
                <th>14 bytes (hex)</th>
              </tr>
            </thead>
            <tbody>
              {slot.collectionStats.map(r => (
                <tr key={r.bodyOffset}>
                  <td>{r.index}</td>
                  <td><code>{hex(r.bodyOffset)}</code></td>
                  <td><code className="hex-cell">{r.rawHex}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
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
        <p className="note-text">
          Sampling stride 0x500 across body[0x119C0:0x12400]. The real records
          have variable layout — this preview gives a rough roster.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Offset</th>
              <th>Name (UTF-16 LE, first 16 b)</th>
              <th>State</th>
              <th>Next 32 b hex</th>
            </tr>
          </thead>
          <tbody>
            {slot.npcRecords.map(r => (
              <tr key={r.bodyOffset}>
                <td>{r.index}</td>
                <td><code>{hex(r.bodyOffset)}</code></td>
                <td>{r.name || <span className="muted">{r.uninit ? '(uninit)' : r.vacant ? '(vacant)' : '(empty)'}</span>}</td>
                <td>{r.uninit ? 'uninit' : r.vacant ? 'vacant' : 'populated'}</td>
                <td><HexPreview hex={r.previewHex} max={64} /></td>
              </tr>
            ))}
          </tbody>
        </table>
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
            {slot.catalogEntries.map(e => (
              <li key={e.bodyOffset}>
                <div className="entry-meta">
                  <code>{hex(e.bodyOffset)}</code>
                  <span className="entry-header">hdr: <code>{e.headerHex}</code></span>
                </div>
                <div className="entry-text">{e.text}</div>
              </li>
            ))}
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
            {slot.mailEntries.map(e => (
              <li key={e.bodyOffset}>
                <div className="entry-meta">
                  <code>{hex(e.bodyOffset)}</code>
                  <span className="entry-header">hdr: <code>{e.headerHex}</code></span>
                </div>
                <div className="entry-text">{e.text}</div>
              </li>
            ))}
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
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Offset</th>
                <th>6 bytes (hex)</th>
              </tr>
            </thead>
            <tbody>
              {slot.bankLog.slice(0, 32).map(r => (
                <tr key={r.bodyOffset}>
                  <td>{r.index}</td>
                  <td><code>{hex(r.bodyOffset)}</code></td>
                  <td><code className="hex-cell">{r.rawHex}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
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
              <th>Slot</th>
              <th>Offset</th>
              <th>State</th>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            {slot.residents.map(r => (
              <tr key={r.bodyOffset} className={`resident-${r.state}`}>
                <td>{r.index}</td>
                <td><code>{hex(r.bodyOffset)}</code></td>
                <td>{r.state}</td>
                <td>{r.state === 'active' ? r.name : <span className="muted">—</span>}</td>
              </tr>
            ))}
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
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [activeSlotTab, setActiveSlotTab] = useState<SlotLabel>('A');
  const [notes, setNotes] = useState<NotesByRegion>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Reload notes whenever the parsed payload SHA changes.
  useEffect(() => {
    if (parse?.payloadSha256) {
      setNotes(loadNotes(parse.payloadSha256));
      if (parse.activeSlot) setActiveSlotTab(parse.activeSlot);
    } else {
      setNotes({});
    }
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
    setError(null);
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
              />
            )}
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
      `}</style>
    </div>
  );
}
