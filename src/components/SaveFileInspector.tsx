import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, SAVE_FILES_BUCKET } from '../lib/supabase';
import {
  FORMAT_MAGIC_EXPECTED,
  REGION_DESCRIPTORS,
  parseSaveFile,
} from '../lib/savefile/parser';
import {
  applyEdits,
  rewrapForDownload,
  suffixFilenameForEdit,
  LETTER_TEXT_MAX_CHARS,
  PLAYER_NAME_MAX_CHARS,
  SHOP_NAME_MAX_CHARS,
  TOWN_NAME_MAX_CHARS,
  INVENTORY_BAG_COUNT,
  INVENTORY_QUANTITY_MIN,
  INVENTORY_QUANTITY_MAX,
  type PendingEdit,
} from '../lib/savefile/editor';
import {
  BANK_MAX,
  NPC_AFFINITY_MAX,
  WALLET_MAX,
  WIZARD_LEVEL_MAX,
  WIZARD_RANK_MAX,
  WIZARD_RANK_NAMES,
} from '../lib/savefile/regions';
import {
  loadInventoryEncoding,
  loadNpcEncoding,
  loadSavefileLookups,
  lookupIidFromStored,
  lookupItemName,
  lookupNpcByStored,
  lookupStoredFromIid,
  type InventoryEncoding,
  type NpcEncoding,
  type SavefileLookups,
} from '../lib/savefile/lookups';
import {
  assessBoard,
  buildBoardRecords,
  formatBoardDate,
  loadBoardPostIndex,
  nameForId,
  splitPost,
  validatePostText,
  TEXT_PACKED_MAX_BYTES,
  TEXT_PLAIN_MAX,
  type BoardAction,
  type BoardAssessment,
  type BoardPostIndex,
  type BoardRecord,
  type BoardStatus,
} from '../lib/savefile/board';
import type {
  Confidence,
  Game1Decode,
  SaveParse,
  SlotLabel,
  SlotParse,
} from '../lib/savefile/types';

// Parsing and editing happen client-side; dropped files also fire a silent
// background upload to the save_files Supabase backend (best-effort, errors
// land in console.error only — the editor stays functional regardless of
// upload outcome). Persisted notes live in localStorage keyed by the
// wrapper-stripped payload SHA so flags carry across reloads.

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

// ---------------------------------------------------------------------------
// Silent background upload to Supabase save_files
// ---------------------------------------------------------------------------
//
// The save-file editor used to share its page with a separate "submit your
// save" form that collected save uploads via the same Supabase backend the
// admin tool (translator/_admin_save_files.py) reads from. As of step-255
// the two widgets are consolidated: dropping a file into the editor also
// fires a silent best-effort upload to the same backend. No UI surface, no
// confirmation, no progress indicator — failures land in console.error
// only, and the editor keeps working locally regardless of upload outcome.
//
// Bucket path matches the prior submission-form scheme so existing admin
// tooling continues to work unchanged: <YYYY>/<MM>/<uuid>/<safe-filename>.
//
// The save_files DB row carries minimal metadata since the unified flow
// asks the user for nothing. save_source is hardcoded to identify the
// origin as the editor's silent capture path; patch_version stays null.

function randomToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'x' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function safeFilename(name: string): string {
  // Strip path separators, shell glob chars, quotes, whitespace; keep the
  // extension intact. Mirrors the prior submission-form helper so bucket
  // keys remain shaped the way _admin_save_files.py expects.
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').trim();
  return cleaned.slice(0, 120) || 'save.sav';
}

async function silentBackgroundUpload(file: File): Promise<void> {
  // Fire-and-forget. Any failure is logged to console.error and swallowed —
  // the user never sees an error toast or status indicator, the editor's
  // local parse/edit/download flow is never interrupted.
  if (!supabase) {
    console.error('[savefile silent upload] Supabase client not configured; skipping background upload.');
    return;
  }
  try {
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
      // Tagged so admin triage can tell editor-captured saves apart from
      // saves that came in via the old submission form (when historical
      // rows are still relevant). The user supplied no source info, so we
      // attribute the path itself.
      save_source: 'save-file editor (silent capture)',
      patch_version: null,
      ritch_amount: null,
      wizard_level: null,
      debug_reason: null,
      submitter: null,
    };
    const { error: insErr } = await supabase.from('save_files').insert(insertPayload);
    if (insErr) throw insErr;
  } catch (e: any) {
    console.error('[savefile silent upload] failed:', e?.message || e);
  }
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
  shopName?: { value: string };
  townName?: { value: string };
  /** Keyed by board record index 0..13. One staged action per post:
   *  remove it, bring it up to the current translation, or give it new
   *  text. The whole 14-record block is rebuilt on apply. */
  board: Record<number, BoardAction>;
  /** Keyed by letter record's body offset. New plain text (≤ 67 chars). */
  letter: Record<number, string>;
  bank?: { value: number };
  wizardLevel?: { value: number };
  wizardRank?: { value: number };
  /** Keyed by NPC record index 0..139: new affinity 0..100. */
  npcAffinity: Record<number, number>;
  /** Keyed by inventory slot index (0..14). `storedValue===null` stages
   *  the empty sentinel; a number stages an occupied record at that
   *  stored_value (the u16 game-internal item-ID written to +0..2) with
   *  the given quantity (written to +5). */
  inventorySlot: Record<number, { storedValue: number | null; quantity: number }>;
}

function makeEmptyEdits(): PendingEditMap {
  return {
    board: {},
    letter: {},
    npcAffinity: {},
    inventorySlot: {},
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
  if (edits.shopName !== undefined) n++;
  if (edits.townName !== undefined) n++;
  n += Object.keys(edits.board).length;
  n += Object.keys(edits.letter).length;
  if (edits.bank !== undefined) n++;
  if (edits.wizardLevel !== undefined) n++;
  if (edits.wizardRank !== undefined) n++;
  n += Object.keys(edits.npcAffinity).length;
  n += Object.keys(edits.inventorySlot).length;
  return n;
}

/** The board records + their assessments for the slot being edited; the
 *  staged board actions are resolved against these on apply. */
interface BoardEditContext {
  records: BoardRecord[];
  assessments: BoardAssessment[];
}

function editsToPendingList(
  edits: PendingEditMap,
  board: BoardEditContext | null,
  playerIndex: number,
): PendingEdit[] {
  const out: PendingEdit[] = [];
  if (edits.ritch !== undefined) {
    out.push({ kind: 'ritch', value: edits.ritch.value, playerIndex });
  }
  if (edits.bank !== undefined) {
    out.push({ kind: 'bank', value: edits.bank.value, playerIndex });
  }
  if (edits.wizardLevel !== undefined) {
    out.push({ kind: 'wizard_level', value: edits.wizardLevel.value, playerIndex });
  }
  if (edits.wizardRank !== undefined) {
    out.push({ kind: 'wizard_rank', value: edits.wizardRank.value, playerIndex });
  }
  for (const [k, v] of Object.entries(edits.npcAffinity)) {
    out.push({ kind: 'npc_affinity', npcIndex: Number(k), value: v });
  }
  if (edits.playerName !== undefined) {
    out.push({ kind: 'player_name', value: edits.playerName.value });
  }
  if (edits.shopName !== undefined) {
    out.push({ kind: 'shop_name', value: edits.shopName.value });
  }
  if (edits.townName !== undefined) {
    out.push({ kind: 'town_name', value: edits.townName.value });
  }
  if (Object.keys(edits.board).length > 0) {
    if (!board) {
      throw new Error('Board edits are staged but the board could not be read from the active slot.');
    }
    out.push({
      kind: 'board',
      records: buildBoardRecords(board.records, board.assessments, edits.board),
    });
  }
  for (const [k, v] of Object.entries(edits.letter)) {
    out.push({ kind: 'letter', recordOffset: Number(k), text: v });
  }
  for (const [k, v] of Object.entries(edits.inventorySlot)) {
    out.push({
      kind: 'inventory_slot',
      slotIndex: Number(k),
      storedValue: v.storedValue,
      quantity: v.quantity,
      playerIndex,
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
// Inventory bag — 15-slot typeahead + quantity editor
// ---------------------------------------------------------------------------

interface ItemOption {
  iid: number;
  name: string;
}

interface ItemComboboxProps {
  /** All selectable items (already sorted by name). Does NOT include the
   *  "(empty)" sentinel — that is rendered separately as a permanent
   *  top entry in the popover listbox. */
  options: ItemOption[];
  /** Currently selected iid, or null = "(empty)". */
  value: number | null;
  /** Display name for the currently-selected iid; used to populate the
   *  input's value when the popover is closed. null when value=null. */
  currentName: string | null;
  onSelect: (iid: number | null) => void;
  disabled?: boolean;
}

/**
 * Inline typeahead/combobox for inventory item selection.
 *
 * Behavior:
 *   - Closed state: input shows the current item's display name (or
 *     "(empty)").
 *   - Focus / click / type: opens a popover listbox below the input
 *     filtered by a case-insensitive substring match against the option
 *     list. "(empty)" is always the first row so the user can clear the
 *     slot regardless of what they've typed.
 *   - ArrowUp/Down moves the highlighted row, Enter selects it, Escape
 *     closes the popover without committing.
 *   - Clicking outside the component closes the popover and reverts the
 *     input text to the current selection's name (no commit).
 *
 * Custom rather than pulling a library because the requirement is a
 * ~40-line addition and we don't want to add downshift/headlessui just
 * for one widget.
 */
function ItemCombobox({
  options,
  value,
  currentName,
  onSelect,
  disabled,
}: ItemComboboxProps) {
  // The input field's draft. When closed: equals the display name of the
  // current selection. When open: user-controlled filter string.
  const [draft, setDraft] = useState<string>(currentName ?? '');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLUListElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Sync the draft back to the current item's name whenever the external
  // selection changes (e.g. when the user discards pending edits) and the
  // popover isn't open. We deliberately do NOT clobber the draft while
  // the popover is open or the user would lose their in-flight filter
  // text on every render.
  useEffect(() => {
    if (!open) {
      setDraft(currentName ?? '');
    }
  }, [currentName, open]);

  // Filter the options against the draft. When the popover is open with
  // an empty draft, show the full list (capped) so the user gets a sense
  // of the alphabetical neighborhood.
  const filtered = useMemo(() => {
    if (!open) return [] as ItemOption[];
    const q = draft.trim().toLowerCase();
    if (q === '') return options;
    return options.filter(o => o.name.toLowerCase().includes(q));
  }, [open, draft, options]);

  // Reset the highlight whenever the filtered list shape changes.
  useEffect(() => {
    setHighlight(0);
  }, [open, draft]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setDraft(currentName ?? '');
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open, currentName]);

  // Keep the highlighted row scrolled into view as the user arrow-keys
  // through the list.
  useEffect(() => {
    if (!open || !popoverRef.current) return;
    // +1 to highlight index because index 0 is the "(empty)" row that
    // sits above the filtered options block.
    const row = popoverRef.current.children[highlight + 1] as
      | HTMLElement
      | undefined;
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [open, highlight]);

  function commit(iid: number | null) {
    onSelect(iid);
    setOpen(false);
    // Force the draft back to whatever the post-commit name will be.
    // We can't read `currentName` from props synchronously because the
    // parent only updates on next render; instead clear the draft and let
    // the useEffect re-sync next render.
    setDraft('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      // -1 represents the "(empty)" sentinel row. We let highlight cycle
      // through [-1 .. filtered.length - 1].
      const max = filtered.length - 1;
      setHighlight(h => Math.min(max, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setHighlight(h => Math.max(-1, h - 1));
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      if (highlight === -1) {
        commit(null);
      } else if (filtered[highlight]) {
        commit(filtered[highlight].iid);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setDraft(currentName ?? '');
      }
    }
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDraft(e.target.value);
    if (!open) setOpen(true);
  }

  function onFocus() {
    if (disabled) return;
    setOpen(true);
    // Select-all on focus so the user can start typing immediately
    // without having to clear the previous selection's name first.
    if (inputRef.current) {
      window.setTimeout(() => inputRef.current?.select(), 0);
    }
  }

  // Use placeholder='(empty)' to convey "no item" when the slot is
  // unfilled, and a muted italic style via CSS for that placeholder.
  const placeholder = value === null ? '(empty)' : 'Type to search…';

  return (
    <div className="inventory-combobox" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        className="inventory-item-input"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={draft}
        onChange={onInputChange}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
      />
      {open && !disabled && (
        <ul
          className="inventory-item-popover"
          role="listbox"
          ref={popoverRef}
          onMouseDown={e => {
            // Prevent the input from blurring (which would close the
            // popover) when the user clicks an option.
            e.preventDefault();
          }}
        >
          <li
            role="option"
            aria-selected={highlight === -1}
            className={
              'inventory-item-option is-empty-option ' +
              (highlight === -1 ? 'is-highlighted' : '')
            }
            onMouseEnter={() => setHighlight(-1)}
            onClick={() => commit(null)}
          >
            (empty)
          </li>
          {filtered.length === 0 ? (
            <li className="inventory-item-empty-state">No matches.</li>
          ) : (
            filtered.map((opt, i) => (
              <li
                key={opt.iid}
                role="option"
                aria-selected={highlight === i}
                className={
                  'inventory-item-option ' +
                  (highlight === i ? 'is-highlighted' : '')
                }
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commit(opt.iid)}
              >
                {opt.name}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** Build a sorted list of (iid, name) pairs for the "(empty) + every game
 *  item" dropdown. Lookups + encoding are loaded async, so on the first
 *  render the array is empty and the dropdown shows only "(empty)" — the
 *  effective inventory_encoding.json fetch is fast (~70KB) so this is a
 *  brief transitional state. */
function buildItemOptions(
  lookups: SavefileLookups | null,
  inventoryEncoding: InventoryEncoding | null,
): { iid: number; name: string }[] {
  if (!lookups || !inventoryEncoding) return [];
  // Only include iids that are BOTH in the items table (have an EN name)
  // AND in the inventory_encoding bijection (have a stored_value the
  // game knows about). The intersection is ~3322 entries.
  const out: { iid: number; name: string }[] = [];
  for (const iidStr of Object.keys(inventoryEncoding.iidToStored)) {
    const iid = Number(iidStr);
    const name = lookupItemName(lookups, iid);
    if (name === null) continue;
    out.push({ iid, name });
  }
  // Sort alphabetically by EN name for usability — the iid order would
  // be a random-looking jumble (it's sorted by internal-ID, not by
  // name).
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

interface InventoryBagSectionProps {
  slot: SlotParse;
  editable: boolean;
  editCtx: EditCtx;
  lookups: SavefileLookups | null;
  inventoryEncoding: InventoryEncoding | null;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
}

function InventoryBagSection({
  slot,
  editable,
  editCtx,
  lookups,
  inventoryEncoding,
  notes,
  setNotes,
  fileLabel,
  payloadSha,
}: InventoryBagSectionProps) {
  // Build the dropdown's item options once per (lookups, encoding) pair.
  const itemOptions = useMemo(
    () => buildItemOptions(lookups, inventoryEncoding),
    [lookups, inventoryEncoding],
  );

  // Compute the per-slot "current view" — pending edit if staged, else
  // the parsed on-disk value. The "(empty)" sentinel is represented by
  // iid=null + quantity=0; an occupied slot has a real iid + quantity.
  function getSlotView(slotIndex: number): {
    iid: number | null;
    quantity: number;
    isPending: boolean;
    originalIid: number | null;
    originalQuantity: number;
  } {
    const onDisk = slot.inventoryBag[slotIndex];
    const onDiskEmpty = !onDisk || onDisk.empty;
    const originalIid =
      onDiskEmpty || !inventoryEncoding
        ? null
        : lookupIidFromStored(inventoryEncoding, onDisk.storedValue);
    const originalQuantity = onDiskEmpty ? 0 : onDisk.quantity;

    const pending = editCtx.edits.inventorySlot[slotIndex];
    if (pending !== undefined) {
      // Pending: storedValue=null means "stage empty". Otherwise we need
      // to convert stored→iid for display.
      const pendingIid =
        pending.storedValue === null || !inventoryEncoding
          ? null
          : lookupIidFromStored(inventoryEncoding, pending.storedValue);
      return {
        iid: pendingIid,
        quantity: pending.quantity,
        isPending: true,
        originalIid,
        originalQuantity,
      };
    }
    return {
      iid: originalIid,
      quantity: originalQuantity,
      isPending: false,
      originalIid,
      originalQuantity,
    };
  }

  function stageEdit(
    slotIndex: number,
    iid: number | null,
    quantity: number,
  ) {
    if (!inventoryEncoding) return;
    if (iid === null) {
      // Stage empty sentinel.
      editCtx.setEdits(prev => ({
        ...prev,
        inventorySlot: {
          ...prev.inventorySlot,
          [slotIndex]: { storedValue: null, quantity: 0 },
        },
      }));
      return;
    }
    const stored = lookupStoredFromIid(inventoryEncoding, iid);
    if (stored === null) return;
    editCtx.setEdits(prev => ({
      ...prev,
      inventorySlot: {
        ...prev.inventorySlot,
        [slotIndex]: { storedValue: stored, quantity },
      },
    }));
  }

  function clearEdit(slotIndex: number) {
    editCtx.setEdits(prev => {
      const next = { ...prev.inventorySlot };
      delete next[slotIndex];
      return { ...prev, inventorySlot: next };
    });
  }

  // Snapshot for the Section's collapsible "what is parsed here" panel.
  const populatedCount = slot.inventoryBag.filter(s => !s.empty).length;
  const parsedSnapshot = `${populatedCount}/${INVENTORY_BAG_COUNT} populated slots`;

  const encodingReady =
    inventoryEncoding !== null &&
    inventoryEncoding.ok &&
    lookups !== null &&
    lookups.ok;

  return (
    <Section
      regionId={`${slot.label}-inventoryBag`}
      title={REGION_DESCRIPTORS.inventoryBag.title}
      range={REGION_DESCRIPTORS.inventoryBag.range}
      confidence={REGION_DESCRIPTORS.inventoryBag.confidence}
      parsedSnapshot={parsedSnapshot}
      notes={notes}
      setNotes={setNotes}
      fileLabel={fileLabel}
      payloadSha={payloadSha}
    >
      <p className="note-text" style={{ marginTop: 0 }}>
        Player inventory bag — 15 fixed slots at body 0x1D9B6 (stride 6
        bytes). Each occupied record stores a u16 LE{' '}
        <code>stored_value</code> (the game&apos;s internal item-ID),
        three 0x00 padding bytes, and a u8 quantity. Empty slots use the
        sentinel <code>ff ff ff ff ff 00</code>. The iid↔stored_value
        bijection was cracked in translation-repo step-260 via ARM9
        lookup function 0x0200BB2C plus the per-category base/count
        tables at RAM 0x0209CCC4 / 0x0209CD14 / 0x0209CC9C (3346
        items across 39 disjoint internal-ID ranges).
      </p>
      {!encodingReady && (
        <p className="muted small">
          Loading item-name and stored-value tables…
        </p>
      )}
      <table className="data-table inventory-bag-table">
        <thead>
          <tr>
            <th>Slot</th>
            <th>Item</th>
            <th className="col-right">Qty</th>
            <th>
              <code className="muted small">body offset</code>
            </th>
          </tr>
        </thead>
        <tbody>
          {slot.inventoryBag.map(bagSlot => {
            const view = getSlotView(bagSlot.index);
            const isEmpty = view.iid === null;
            const itemName =
              view.iid !== null && lookups
                ? lookupItemName(lookups, view.iid)
                : null;
            const displayLabel = isEmpty
              ? '(empty)'
              : itemName ??
                `iid ${view.iid} (name unavailable)`;
            const offsetHex = '0x' + bagSlot.bodyOffset.toString(16).toUpperCase();
            // Don't allow editing until the encoding has loaded — the
            // dropdown would only show "(empty)" otherwise.
            const canEditThisRow = editable && encodingReady;
            return (
              <tr
                key={bagSlot.index}
                className={view.isPending ? 'is-pending' : ''}
              >
                <td>{bagSlot.index + 1}</td>
                <td>
                  {canEditThisRow ? (
                    <ItemCombobox
                      options={itemOptions}
                      value={view.iid}
                      currentName={isEmpty ? null : itemName ?? null}
                      onSelect={iid => {
                        if (iid === null) {
                          stageEdit(bagSlot.index, null, 0);
                        } else {
                          // When transitioning empty -> occupied, seed
                          // quantity to the on-disk value if there was
                          // one, else default to 1.
                          const seedQty =
                            view.quantity > 0 ? view.quantity : 1;
                          stageEdit(bagSlot.index, iid, seedQty);
                        }
                      }}
                    />
                  ) : (
                    <span className={isEmpty ? 'muted' : ''}>
                      {displayLabel}
                    </span>
                  )}
                  {view.isPending && view.originalIid !== view.iid && (
                    <div className="muted small">
                      {view.originalIid === null
                        ? '(was empty)'
                        : `was ${lookups ? lookupItemName(lookups, view.originalIid) ?? `iid ${view.originalIid}` : `iid ${view.originalIid}`}`}
                    </div>
                  )}
                </td>
                <td className="col-right">
                  {canEditThisRow && !isEmpty ? (
                    <input
                      type="number"
                      className="inventory-qty-input"
                      min={INVENTORY_QUANTITY_MIN}
                      max={INVENTORY_QUANTITY_MAX}
                      step={1}
                      value={view.quantity}
                      onChange={e => {
                        const v = Number.parseInt(e.target.value, 10);
                        if (!Number.isFinite(v)) return;
                        const clamped = Math.max(
                          INVENTORY_QUANTITY_MIN,
                          Math.min(INVENTORY_QUANTITY_MAX, v),
                        );
                        // iid won't be null here because the input only
                        // renders when isEmpty is false.
                        stageEdit(bagSlot.index, view.iid, clamped);
                      }}
                    />
                  ) : (
                    <span className={isEmpty ? 'muted' : ''}>
                      {isEmpty ? '—' : view.quantity}
                    </span>
                  )}
                  {view.isPending &&
                    !isEmpty &&
                    view.originalQuantity !== view.quantity && (
                      <div className="muted small">
                        was {view.originalQuantity === 0 ? '—' : view.originalQuantity}
                      </div>
                    )}
                </td>
                <td>
                  <code className="muted small">{offsetHex}</code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editable && (
        <div className="inventory-bag-actions">
          {Object.keys(editCtx.edits.inventorySlot).length > 0 && (
            <button
              type="button"
              className="inline-edit-clear"
              onClick={() => {
                editCtx.setEdits(prev => ({
                  ...prev,
                  inventorySlot: {},
                }));
              }}
            >
              Drop all pending inventory edits
            </button>
          )}
        </div>
      )}
      {!editable && (
        <p className="muted small">
          Edit affordance is exposed on the active-slot tab (the
          most-recently-written slot, marked &quot;active&quot; in the
          tab strip). Edits mirror to both slot A and slot B
          automatically when applied.
        </p>
      )}
      <p className="note-text">
        Edits are mirrored to both slot A (body 0x1D9B6) and slot B
        (body 0x1D9B6 in slot B&apos;s body) so the next ping-pong save
        write picks up the change regardless of which slot the game
        considers current. All three checksum levels (header, body,
        extra[0]) are recomputed automatically.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Player characters — the four extra records (§58.3)
// ---------------------------------------------------------------------------

interface PlayerRecordsSectionProps {
  slot: SlotParse;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
}

function PlayerRecordsSection({ slot, notes, setNotes, fileLabel, payloadSha }: PlayerRecordsSectionProps) {
  const recs = slot.playerRecords;
  const present = recs.filter(r => r.exists && !r.blank);
  return (
    <Section
      regionId={`${slot.label}-playerRecords`}
      title={REGION_DESCRIPTORS.playerRecords.title}
      range={REGION_DESCRIPTORS.playerRecords.range}
      confidence={REGION_DESCRIPTORS.playerRecords.confidence}
      parsedSnapshot={`${present.length} of 4 player slots used; editing record ${slot.activePlayer}`}
      notes={notes}
      setNotes={setNotes}
      fileLabel={fileLabel}
      payloadSha={payloadSha}
    >
      <p style={{ marginTop: 0 }}>
        A cartridge holds up to four characters. Each has a 0x22F8-byte record
        after the body (what earlier versions of this page called &quot;town
        residents&quot;), with its own checksum, wallet, bank, inventory bag,
        room tiles and Wi-Fi profile. The header says which slots exist and
        which character was played last — the wallet, bank and bag shown on
        this page belong to <strong>record {slot.activePlayer}</strong>.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Record</th>
            <th>Status</th>
            <th>Name</th>
            <th className="col-right">Ritch</th>
            <th className="col-right">Bank</th>
            <th>Last save</th>
            <th>Created</th>
            <th>Body</th>
            <th>Bag</th>
            <th>Checksum</th>
          </tr>
        </thead>
        <tbody>
          {recs.map(r => (
            <tr key={r.index} className={r.index === slot.activePlayer ? 'resident-active' : r.blank ? 'resident-uninit' : ''}>
              <td>{r.index}{r.index === slot.activePlayer && <span className="primary-tag" style={{ marginLeft: 6 }}>current</span>}</td>
              <td>{r.blank ? <span className="muted">never used</span> : r.exists ? 'in use' : <span className="muted">not flagged</span>}</td>
              <td>{r.blank ? '—' : r.name || <span className="muted">(name not stored here)</span>}</td>
              <td className="col-right">{r.blank ? '—' : r.wallet.toLocaleString()}</td>
              <td className="col-right">{r.blank ? '—' : r.bank.toLocaleString()}</td>
              <td>{r.blank ? '—' : r.lastSaveDate.text}</td>
              <td>{r.blank ? '—' : r.creationDate.text}</td>
              <td>{r.blank ? '—' : r.bodyType === 0 ? 'type 0' : `type ${r.bodyType}`}</td>
              <td>{r.blank ? '—' : `${r.bagUsed}/15`}</td>
              <td>
                {r.blank ? <span className="muted">—</span> : (
                  <code className={r.checksumOk ? 'ok' : 'bad'}>
                    {r.checksumOk ? 'PASS' : `FAIL ${hex(r.checksumStored)}≠${hex(r.checksumComputed)}`}
                  </code>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note-text">
        Checksum = RFC1071 over the whole record with its first two bytes zeroed
        (translation repo notes/savefile_format.md §58.3). Every edit this page
        makes inside a record recomputes that record&apos;s checksum. The name
        column is the record&apos;s own 16-byte name field, which the Japanese
        3DS build fills and the English builds leave empty — the player name
        shown above comes from the body.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// NPC affinity — 140 per-NPC records at 0x1257C (§58.2)
// ---------------------------------------------------------------------------

interface NpcAffinitySectionProps {
  slot: SlotParse;
  editable: boolean;
  editCtx: EditCtx;
  npcEncoding: NpcEncoding | null;
  lookups: SavefileLookups | null;
  inventoryEncoding: InventoryEncoding | null;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
}

function itemNameFor(
  stored: number,
  lookups: SavefileLookups | null,
  inventoryEncoding: InventoryEncoding | null,
): string | null {
  if (stored === 0xffff || stored === 0) return null;
  if (!lookups || !inventoryEncoding) return `item ${stored}`;
  const iid = lookupIidFromStored(inventoryEncoding, stored);
  if (iid === null) return `item ${stored}`;
  return lookupItemName(lookups, iid) ?? `item ${stored}`;
}

function NpcAffinitySection({
  slot,
  editable,
  editCtx,
  npcEncoding,
  lookups,
  inventoryEncoding,
  notes,
  setNotes,
  fileLabel,
  payloadSha,
}: NpcAffinitySectionProps) {
  const [showAll, setShowAll] = useState(false);
  const recs = slot.npcRecords;
  const touched = recs.filter(r => !r.untouched);
  const rows = showAll ? recs : touched;
  const pending = editCtx.edits.npcAffinity;

  function stage(i: number, v: number) {
    editCtx.setEdits(prev => ({ ...prev, npcAffinity: { ...prev.npcAffinity, [i]: v } }));
  }
  function unstage(i: number) {
    editCtx.setEdits(prev => {
      const next = { ...prev.npcAffinity };
      delete next[i];
      return { ...prev, npcAffinity: next };
    });
  }

  return (
    <Section
      regionId={`${slot.label}-npcRecords`}
      title={REGION_DESCRIPTORS.npcRecords.title}
      range={REGION_DESCRIPTORS.npcRecords.range}
      confidence={REGION_DESCRIPTORS.npcRecords.confidence}
      parsedSnapshot={`${touched.length}/140 NPC records in use`}
      notes={notes}
      setNotes={setNotes}
      fileLabel={fileLabel}
      payloadSha={payloadSha}
    >
      <p style={{ marginTop: 0 }}>
        One 112-byte record per main character (speaker ids 1000–1139). Byte +7
        is a 0–100 value the game moves with a fixed table (−10, −10, +15, +100,
        +30, +20) and tests as a probability (random 1–100 ≤ value) — the closest
        thing to a friendship meter in the file. Byte +0 is the item the character
        last took from your shop. This replaces the earlier &quot;friends met&quot;
        list, which was reading mushroom ids out of the map grid.
      </p>
      <div className="board-actions" style={{ marginBottom: 6 }}>
        <button type="button" className="board-btn" onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Show only records in use' : `Show all 140 (${recs.length - touched.length} untouched)`}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No NPC records are in use.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>NPC</th>
              <th className="col-right">Affinity</th>
              <th>Raised</th>
              <th>Item from shop</th>
              <th>Counters</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const info = npcEncoding ? lookupNpcByStored(npcEncoding, 500 + r.index) : null;
              const pendingVal = pending[r.index];
              return (
                <tr key={r.index} className={pendingVal !== undefined ? 'is-pending' : r.untouched ? 'resident-uninit' : ''}>
                  <td><code className="muted">{1000 + r.index}</code></td>
                  <td>{info ? <strong>{info.enName || '(no EN name)'}</strong> : <span className="muted">loading…</span>}</td>
                  <td className="col-right">
                    {editable ? (
                      <input
                        type="number"
                        className="inventory-qty-input"
                        min={0}
                        max={NPC_AFFINITY_MAX}
                        step={1}
                        value={pendingVal ?? r.affinity}
                        onChange={e => {
                          const v = Number.parseInt(e.target.value, 10);
                          if (!Number.isFinite(v)) return;
                          const clamped = Math.max(0, Math.min(NPC_AFFINITY_MAX, v));
                          if (clamped === r.affinity) unstage(r.index);
                          else stage(r.index, clamped);
                        }}
                      />
                    ) : (
                      r.affinity
                    )}
                    {pendingVal !== undefined && <div className="muted small">was {r.affinity}</div>}
                  </td>
                  <td>{r.raised ? 'yes' : <span className="muted">—</span>}</td>
                  <td>{itemNameFor(r.itemStored, lookups, inventoryEncoding) ?? <span className="muted">—</span>}</td>
                  <td><code className="muted small">{r.counters.join(' ')}</code></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editable && Object.keys(pending).length > 0 && (
        <div className="inventory-bag-actions">
          <button
            type="button"
            className="inline-edit-clear"
            onClick={() => editCtx.setEdits(prev => ({ ...prev, npcAffinity: {} }))}
          >
            Drop all pending affinity edits
          </button>
        </div>
      )}
      <p className="note-text">
        The 0–100 mechanics are read from the code (clamp, delta table, probability
        test); calling it &quot;affinity&quot; is the reading of that code, not a label
        the game exposes. Edits write byte +7 of the record in both slots and
        recompute the body checksum. BETA.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Player's shop + sales ledger (§58.2, region notes B/C)
// ---------------------------------------------------------------------------

interface ShopSectionProps {
  slot: SlotParse;
  lookups: SavefileLookups | null;
  inventoryEncoding: InventoryEncoding | null;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
}

function ShopSection({ slot, lookups, inventoryEncoding, notes, setNotes, fileLabel, payloadSha }: ShopSectionProps) {
  const shop = slot.playerShop;
  const ledger = slot.shopLedger;
  const stocked = shop.shelves.filter(sh => sh.itemStored !== 0xffff && sh.itemStored !== 0);
  const sold = ledger.entries.filter(e => e.itemRef !== 0xff && (e.unitsSold > 0 || e.moneyTaken > 0 || e.stock > 0));
  const rankLabel = shop.rankRaw < 2 ? 'tier 0' : shop.rankRaw < 5 ? 'tier 1' : 'tier 2';
  return (
    <Section
      regionId={`${slot.label}-shop`}
      title={REGION_DESCRIPTORS.playerShop.title}
      range={REGION_DESCRIPTORS.playerShop.range}
      confidence={REGION_DESCRIPTORS.playerShop.confidence}
      parsedSnapshot={`${stocked.length}/16 shelves stocked; rank byte ${shop.rankRaw} (${rankLabel}); lifetime sales ${ledger.lifetimeTotal.toLocaleString()}`}
      notes={notes}
      setNotes={setNotes}
      fileLabel={fileLabel}
      payloadSha={payloadSha}
    >
      <p style={{ marginTop: 0 }}>
        <strong>{stocked.length}</strong> of 16 shelf records hold an item. The
        shop rank byte is <code>{shop.rankRaw}</code> (the game buckets it at 2 and
        5 → {rankLabel}). Lifetime sales total{' '}
        <strong>{ledger.lifetimeTotal.toLocaleString()}</strong> Ritch (an
        achievement flag is set at 1,000,000).
      </p>
      {stocked.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Shelf</th>
              <th>Item</th>
              <th className="col-right">Price</th>
              <th className="col-right">Price 2</th>
              <th className="col-right">Discount %</th>
              <th>Slot</th>
            </tr>
          </thead>
          <tbody>
            {stocked.map(sh => (
              <tr key={sh.index}>
                <td>{sh.index + 1}</td>
                <td>{itemNameFor(sh.itemStored, lookups, inventoryEncoding)}</td>
                <td className="col-right">{sh.price1}</td>
                <td className="col-right">{sh.price2}</td>
                <td className="col-right">{sh.discountPct}</td>
                <td>{sh.slot}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h5 className="subsection-head">Display ledger ({sold.length} slots with sales)</h5>
      {sold.length === 0 ? (
        <p className="muted">No sales recorded in either display set.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Set</th>
              <th>Slot</th>
              <th>Item</th>
              <th className="col-right">Money taken</th>
              <th className="col-right">Units sold</th>
              <th className="col-right">Stock</th>
            </tr>
          </thead>
          <tbody>
            {sold.map(e => (
              <tr key={`${e.set}-${e.slot}`}>
                <td>{e.set}</td>
                <td>{e.slot}{e.fixed ? ' (fixed)' : ''}</td>
                <td>
                  {e.itemStored !== null
                    ? itemNameFor(e.itemStored, lookups, inventoryEncoding)
                    : <span className="muted">ref {e.itemRef}</span>}
                </td>
                <td className="col-right">{e.moneyTaken.toLocaleString()}</td>
                <td className="col-right">{e.unitsSold}</td>
                <td className="col-right">{e.stock}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="note-text">
        Shelf records: item, discount % (clamped 10–100), slot index, two prices
        (the sale price is price × discount / 100). Ledger entries: money taken
        (cap 9,999,999), units sold (cap 999), stock left, item reference (free
        slots 0–14 point at the shop&apos;s display list, fixed slots 15–21 at the
        record&apos;s own 7-item set). Read-only.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Custom-named items (0x1AECA) and world objects (0x4AC / 0x9AB0)
// ---------------------------------------------------------------------------

interface ReadOnlySectionProps {
  slot: SlotParse;
  lookups: SavefileLookups | null;
  inventoryEncoding: InventoryEncoding | null;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
}

function CustomItemsSection({ slot, lookups, inventoryEncoding, notes, setNotes, fileLabel, payloadSha }: ReadOnlySectionProps) {
  const items = slot.customItems.filter(c => c.name || (c.itemStored !== 0xffff && c.itemStored !== 0));
  return (
    <Section
      regionId={`${slot.label}-customItems`}
      title={REGION_DESCRIPTORS.customItems.title}
      range={REGION_DESCRIPTORS.customItems.range}
      confidence={REGION_DESCRIPTORS.customItems.confidence}
      parsedSnapshot={`${items.length}/8 named`}
      notes={notes}
      setNotes={setNotes}
      fileLabel={fileLabel}
      payloadSha={payloadSha}
    >
      {items.length === 0 ? (
        <p className="muted" style={{ marginTop: 0 }}>No custom-named items.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Base item</th>
            </tr>
          </thead>
          <tbody>
            {items.map(c => (
              <tr key={c.index}>
                <td>{c.index + 1}</td>
                <td><strong>{c.name || <span className="muted">(no name)</span>}</strong></td>
                <td>{itemNameFor(c.itemStored, lookups, inventoryEncoding) ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="note-text">
        Sweets, accessories and clothes the player named (44-character UTF-16 name
        + the item it was made from). Read-only.
      </p>
    </Section>
  );
}

function WorldObjectsSection({ slot, lookups, inventoryEncoding, notes, setNotes, fileLabel, payloadSha }: ReadOnlySectionProps) {
  const w = slot.worldObjects;
  const top = Array.from(w.outdoorCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const lists = w.lists.filter(l => l.used > 0);
  return (
    <Section
      regionId={`${slot.label}-worldObjects`}
      title={REGION_DESCRIPTORS.worldObjects.title}
      range={REGION_DESCRIPTORS.worldObjects.range}
      confidence={REGION_DESCRIPTORS.worldObjects.confidence}
      parsedSnapshot={`${w.outdoorCellsUsed} outdoor cells occupied; ${lists.length} placed-object lists in use`}
      notes={notes}
      setNotes={setNotes}
      fileLabel={fileLabel}
      payloadSha={payloadSha}
    >
      <p style={{ marginTop: 0 }}>
        Most of the save body is the game world: a 6-area × 16 × 80 grid of
        5-byte cells for everything standing outdoors (trees, flowers,
        mushrooms, weeds, buried bones, snow, scenery), then one placed-object
        list per room and shop. <strong>{w.outdoorCellsUsed.toLocaleString()}</strong>{' '}
        outdoor cells are occupied.
      </p>
      <details className="tile-details">
        <summary>Most common outdoor objects</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="col-right">Cells</th>
            </tr>
          </thead>
          <tbody>
            {top.map(([stored, n]) => (
              <tr key={stored}>
                <td>{itemNameFor(stored, lookups, inventoryEncoding)}</td>
                <td className="col-right">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details className="tile-details">
        <summary>Placed-object lists ({lists.length} in use)</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th>List</th>
              <th>Owner</th>
              <th className="col-right">Objects</th>
              <th>Examples</th>
            </tr>
          </thead>
          <tbody>
            {lists.map(l => (
              <tr key={l.index}>
                <td>{l.index}</td>
                <td>{l.owner}</td>
                <td className="col-right">{l.used}/32</td>
                <td className="muted small">
                  {l.sample.map(v => itemNameFor(v, lookups, inventoryEncoding)).filter(Boolean).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <p className="note-text">
        Layout from translation repo notes/save_analysis/_trace_region_A_middle_body.md.
        Read-only: moving objects needs the per-area grids and the game&apos;s
        occupancy rules.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Bulletin board — 14 post records at body 0x162BC (step-408)
// ---------------------------------------------------------------------------
//
// The v2.6.3 patch stores a long post as 0xFFFF + UTF-8 inside the same
// field the game used to overflow; this section reads both forms, shows
// each post's title, text, author and date, and classifies it with the
// same rules as the translation repo's _board_save_repair.py: posts whose
// text overran the fields behind it are recognised from the text and can
// be brought up to the current translation; posts whose author name
// overran the message number hold another message's text and are flagged
// for removal. Actions are staged per record and the whole block is
// rebuilt on apply (removed posts drop out, the rest close up).

const BOARD_STATUS_LABEL: Record<BoardStatus, string> = {
  empty: 'Empty',
  player: 'Player post',
  unfilled: 'Waiting for text',
  current: 'Current',
  outdated: 'Older wording',
  damaged: 'Damaged',
  unrecoverable: 'Corrupt',
  unknown: 'Not recognised',
};

function BoardStatusPill({ status }: { status: BoardStatus }) {
  return <span className={`board-pill board-pill-${status}`}>{BOARD_STATUS_LABEL[status]}</span>;
}

function boardActionLabel(action: BoardAction, assessment: BoardAssessment | undefined): string {
  if (action.kind === 'remove') return 'staged for removal';
  if (action.kind === 'text') return 'staged: new text';
  if (assessment?.fix?.kind === 'write') return 'staged: current text written in';
  return 'staged: game rewrites it with the current text';
}

function authorLabel(
  r: BoardRecord,
  index: BoardPostIndex | null,
  playerName: string,
): string {
  if (r.authorOverran) return `${r.author}… (name overran its field)`;
  if (r.author) return r.author;
  if (index) {
    const n = nameForId(index, r.authorId, playerName);
    if (n) return `${n} (from id)`;
  }
  if (r.authorId === 0xffff) return '—';
  return `id ${r.authorId}`;
}

interface BulletinBoardSectionProps {
  slot: SlotParse;
  editable: boolean;
  editCtx: EditCtx;
  boardIndex: BoardPostIndex | null;
  assessments: BoardAssessment[];
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
}

function BulletinBoardSection({
  slot,
  editable,
  editCtx,
  boardIndex,
  assessments,
  notes,
  setNotes,
  fileLabel,
  payloadSha,
}: BulletinBoardSectionProps) {
  const records = slot.boardRecords;
  const actions = editCtx.edits.board;
  const posts = records.filter(r => !r.empty).length;

  const tally: Partial<Record<BoardStatus, number>> = {};
  assessments.forEach(a => {
    tally[a.status] = (tally[a.status] ?? 0) + 1;
  });
  const recommended = records
    .map((_, i) => i)
    .filter(i => assessments[i] && assessments[i].recommendation !== 'keep' && !actions[i]);
  const outdated = records
    .map((_, i) => i)
    .filter(i => assessments[i]?.status === 'outdated' || assessments[i]?.status === 'damaged');

  function stage(i: number, action: BoardAction) {
    editCtx.setEdits(prev => ({ ...prev, board: { ...prev.board, [i]: action } }));
  }
  function unstage(i: number) {
    editCtx.setEdits(prev => {
      const next = { ...prev.board };
      delete next[i];
      return { ...prev, board: next };
    });
  }
  function stageRecommended() {
    editCtx.setEdits(prev => {
      const next = { ...prev.board };
      recommended.forEach(i => {
        const a = assessments[i];
        next[i] = a.recommendation === 'remove' ? { kind: 'remove' } : { kind: 'update' };
      });
      return { ...prev, board: next };
    });
  }

  const snapshot =
    `${posts}/${records.length} posts` +
    (boardIndex
      ? `; ${tally.damaged ?? 0} damaged, ${tally.unrecoverable ?? 0} corrupt, ${tally.outdated ?? 0} older wording, ${tally.unknown ?? 0} not recognised`
      : '');

  return (
    <Section
      regionId={`${slot.label}-board`}
      title={REGION_DESCRIPTORS.board.title}
      range={REGION_DESCRIPTORS.board.range}
      confidence={REGION_DESCRIPTORS.board.confidence}
      parsedSnapshot={snapshot}
      notes={notes}
      setNotes={setNotes}
      fileLabel={fileLabel}
      payloadSha={payloadSha}
    >
      <p style={{ marginTop: 0 }}>
        <strong>{posts}</strong> of {records.length} board slots hold a post. Before patch
        v2.6.3 the game wrote every post into a field with room for {TEXT_PLAIN_MAX} characters,
        and an English post that ran longer overwrote the author&apos;s name, the ids behind it
        and finally the date — the garbled authors and blank posts people reported. v2.6.3
        stores long posts compactly and retranslated all 233 of them. This section shows what
        is on your board now, flags the posts the overflow damaged, and can bring every
        system post up to the current translation.
      </p>
      {!boardIndex && (
        <p className="muted small">Loading the post index (current and earlier texts)…</p>
      )}
      {boardIndex && posts > 0 && (
        <div className="board-summary">
          <div className="board-summary-counts">
            {(['current', 'outdated', 'damaged', 'unrecoverable', 'unknown', 'unfilled', 'player'] as BoardStatus[])
              .filter(s => tally[s])
              .map(s => (
                <span key={s} className="board-summary-item">
                  <BoardStatusPill status={s} /> {tally[s]}
                </span>
              ))}
          </div>
          {editable && (
            <div className="board-actions">
              <button
                type="button"
                className="board-btn board-btn-primary"
                disabled={recommended.length === 0}
                onClick={stageRecommended}
                title="Updates every damaged or older-wording post and removes the corrupt ones."
              >
                Stage all recommended fixes ({recommended.length})
              </button>
            </div>
          )}
          {editable && outdated.length > 0 && (
            <p className="muted small" style={{ margin: 0 }}>
              &quot;Update&quot; clears a post&apos;s text and leaves its ids and date in place, so the
              game writes the current translation the next time you open the board. That needs
              patch <strong>v2.6.3 or later</strong> — an older patch would rewrite the old text
              and overflow again.
            </p>
          )}
        </div>
      )}
      {posts === 0 ? (
        <p className="muted">No posts on this board.</p>
      ) : (
        <ol className="entries-list board-list">
          {records.map((r, i) => {
            if (r.empty && !actions[i]) return null;
            const a = assessments[i];
            const action = actions[i];
            const { title, rows } = splitPost(r.text);
            const canUpdate = Boolean(a?.fix) && a.status !== 'current' && a.status !== 'unfilled';
            return (
              <li
                key={r.bodyOffset}
                className={`board-post status-${a?.status ?? 'unknown'} ${action ? 'is-staged' : ''} ${action?.kind === 'remove' ? 'is-pending-remove' : ''}`}
              >
                <div className="entry-meta">
                  <span>Post #{i + 1}</span>
                  {a && <BoardStatusPill status={a.status} />}
                  <span>{formatBoardDate(r)}</span>
                  <span>by {authorLabel(r, boardIndex, slot.playerName)}</span>
                  {r.msg > 0 && r.msg < 10000 && <code className="muted small">msg {r.msg}</code>}
                  {r.textPacked && <span className="muted small">v2.6.3 form</span>}
                  {action && <span className="entry-remove-tag">{boardActionLabel(action, a)}</span>}
                </div>
                <div className={`board-title ${action?.kind === 'remove' ? 'entry-text-removed' : ''}`}>
                  {title || <span className="muted">(no title)</span>}
                </div>
                {rows.length > 0 && (
                  <div className={`entry-text ${action?.kind === 'remove' ? 'entry-text-removed' : ''}`}>
                    {rows.join('\n')}
                  </div>
                )}
                {a && a.status !== 'empty' && <p className="board-detail">{a.detail}</p>}
                {a?.currentText && a.status !== 'current' && (
                  <details className="tile-details">
                    <summary>Current translation of this post</summary>
                    <div className="entry-text board-current">{a.currentText}</div>
                  </details>
                )}
                {editable && !r.empty && (
                  <div className="entry-edit-row">
                    {action ? (
                      <button
                        type="button"
                        className="entry-remove-btn entry-remove-undo"
                        onClick={() => unstage(i)}
                      >
                        Undo
                      </button>
                    ) : (
                      <>
                        {canUpdate && (
                          <button
                            type="button"
                            className="board-btn"
                            onClick={() => stage(i, { kind: 'update' })}
                            title={
                              a.fix?.kind === 'write'
                                ? 'Writes the current text into the post; the author stays blank.'
                                : 'Clears the text so the game (v2.6.3+) writes the current translation.'
                            }
                          >
                            Update to current translation
                          </button>
                        )}
                        <button
                          type="button"
                          className="entry-remove-btn"
                          onClick={() => stage(i, { kind: 'remove' })}
                          title="Takes the post off the board; the posts below move up."
                        >
                          Remove post
                        </button>
                        <InlineEdit
                          label="text"
                          beta
                          multiline
                          pendingValue={null}
                          initialDraft={r.text}
                          maxChars={TEXT_PACKED_MAX_BYTES}
                          onCommit={draft => {
                            const err = validatePostText(draft);
                            if (err) return err;
                            stage(i, { kind: 'text', text: draft });
                            return null;
                          }}
                          onClear={() => unstage(i)}
                        />
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="note-text">
        A post is title, line break, then up to three rows. Up to {TEXT_PLAIN_MAX} characters it
        is stored as UTF-16, as every version of the game does; longer text is stored in the
        v2.6.3 compact form (0xFFFF + UTF-8, {TEXT_PACKED_MAX_BYTES} bytes) that only v2.6.3 and
        later can read. Removing a post closes the gap the way the game&apos;s own remove routine
        does. Classification follows the translation repo&apos;s{' '}
        <code>_board_save_repair.py</code>, checked in the emulator against bug report #17&apos;s
        save on the v2.6.3 ROM.
      </p>
      {!editable && (
        <p className="muted small">
          Edit controls appear on the active-slot tab; edits are written to both slots.
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Letter queues — 10 + 12 records after the board, same layout
// ---------------------------------------------------------------------------

interface LettersSectionProps {
  slot: SlotParse;
  editable: boolean;
  editCtx: EditCtx;
  boardIndex: BoardPostIndex | null;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
}

function LettersSection({
  slot,
  editable,
  editCtx,
  boardIndex,
  notes,
  setNotes,
  fileLabel,
  payloadSha,
}: LettersSectionProps) {
  const records = slot.letterRecords;
  const populated = records.filter(r => !r.empty);
  return (
    <Section
      regionId={`${slot.label}-letters`}
      title={REGION_DESCRIPTORS.letters.title}
      range={REGION_DESCRIPTORS.letters.range}
      confidence={REGION_DESCRIPTORS.letters.confidence}
      parsedSnapshot={`${populated.length}/${records.length} records populated`}
      notes={notes}
      setNotes={setNotes}
      fileLabel={fileLabel}
      payloadSha={payloadSha}
    >
      <p style={{ marginTop: 0 }}>
        <strong>{populated.length}</strong> of {records.length} letter records are in use. The
        two queues (10 then 12 records) use the board&apos;s record layout and are filled by a
        separate routine the v2.6.3 board patch does not touch, so text here stays plain UTF-16
        with the {LETTER_TEXT_MAX_CHARS}-character limit. Before step-408 this region was shown
        as &quot;per-NPC mail&quot; from a misaligned offset.
      </p>
      {populated.length === 0 ? (
        <p className="muted">No letters queued.</p>
      ) : (
        <ol className="entries-list">
          {populated.map(r => {
            const pending = editCtx.edits.letter[r.bodyOffset];
            const { title, rows } = splitPost(r.text);
            return (
              <li key={r.bodyOffset}>
                <div className="entry-meta">
                  <span>Record #{r.index + 1}</span>
                  <span>{formatBoardDate(r)}</span>
                  <span>by {authorLabel(r, boardIndex, slot.playerName)}</span>
                  {r.flag === 0 && <span className="muted small">not filled yet</span>}
                  <code className="muted small">body {hex(r.bodyOffset, 5)}</code>
                </div>
                {r.text ? (
                  <>
                    <div className="board-title">{title}</div>
                    {rows.length > 0 && <div className="entry-text">{rows.join('\n')}</div>}
                  </>
                ) : (
                  <div className="entry-text muted">(no text)</div>
                )}
                {editable && (
                  <div className="entry-edit-row">
                    <InlineEdit
                      label="letter text"
                      beta
                      multiline
                      pendingValue={pending ?? null}
                      initialDraft={r.text}
                      maxChars={LETTER_TEXT_MAX_CHARS}
                      onCommit={draft => {
                        if (draft.length === 0) return 'Text cannot be empty.';
                        if (draft.length > LETTER_TEXT_MAX_CHARS) {
                          return `Max ${LETTER_TEXT_MAX_CHARS} characters.`;
                        }
                        editCtx.setEdits(prev => ({
                          ...prev,
                          letter: { ...prev.letter, [r.bodyOffset]: draft },
                        }));
                        return null;
                      }}
                      onClear={() =>
                        editCtx.setEdits(prev => {
                          const next = { ...prev.letter };
                          delete next[r.bodyOffset];
                          return { ...prev, letter: next };
                        })
                      }
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Section>
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

// ---------------------------------------------------------------------------
// Game 1 (Magician's Quest / Enchanted Folk) panel — DORMANT for Game 3
// ---------------------------------------------------------------------------
//
// Rendered ONLY when parse.game1 is non-null, i.e. when the file magic
// at 0x00 matches Game 1's documented value (0x0DCEAB8906593DA2). Every
// offset shown here is sourced from LaytonLoztew's mqreader.js (see
// translation repo notes/_external_mqreader.js). None of Tongari
// Boushi's (Game 3) saves trigger this panel — it's structural
// foundation for if a Magician's Quest cartridge ever shows up.

interface Game1PanelProps {
  decode: Game1Decode;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
}

function Game1Panel({ decode, notes, setNotes, fileLabel, payloadSha }: Game1PanelProps) {
  const labelArgs = { notes, setNotes, fileLabel, payloadSha };
  const enrolledPlayers = decode.players.filter(p => p.enrolled);

  return (
    <div className="game1-panel">
      <Section
        regionId="game1-header"
        title="Game 1 detected — Magician's Quest / Enchanted Folk"
        range="file[0x00..0x80000], offsets from LaytonLoztew mqreader.js"
        confidence="confirmed"
        parsedSnapshot={`${enrolledPlayers.length} player(s) enrolled; school=${JSON.stringify(decode.schoolName)}`}
        {...labelArgs}
      >
        <p className="note-text" style={{ marginTop: 0 }}>
          The file magic at offset 0x00 matches Game 1
          (<code>0x0DCEAB8906593DA2</code>). Every section below is a
          direct port of <a href="https://laytonloztew.neocities.org/mqreader" target="_blank" rel="noreferrer">LaytonLoztew&apos;s
          Magician&apos;s Quest Save File Reader</a> — offsets and
          decoding tables came verbatim from the JavaScript source. The
          Tongari Boushi (Game 3) inspector sections below this panel
          will be empty because Game 1 and Game 3 use different slot
          layouts.
        </p>
        <dl className="kv">
          <dt>School</dt>
          <dd>
            <strong>{decode.schoolName || <span className="muted">(empty)</span>}</strong>
            <span className="muted small">{' '}(file 0x8FBC, 10 bytes)</span>
          </dd>
          <dt>Enrolment bitmap (file 0x1C)</dt>
          <dd>
            <code>0x{decode.enrolmentByte.toString(16).padStart(2, '0')}</code>
            <span className="muted small">{' '}— bit n set ⇒ player n enrolled</span>
          </dd>
          <dt>Game date/time</dt>
          <dd>
            20{decode.date.year.toString().padStart(2, '0')}-
            {decode.date.month.toString().padStart(2, '0')}-
            {decode.date.day.toString().padStart(2, '0')}{' '}
            {decode.date.hour.toString().padStart(2, '0')}:
            {decode.date.minute.toString().padStart(2, '0')}
            <span className="muted small">{' '}(file 0x2E8..0x2ED)</span>
          </dd>
        </dl>
      </Section>

      <Section
        regionId="game1-checksum"
        title="Game 1 file-level checksum (Konami custom sum)"
        range="file 0x20 (u16 BE), covers first 64 KiB"
        confidence="confirmed"
        parsedSnapshot={`stored=${decode.checksum.storedHex} computed=${decode.checksum.computedHex} → ${decode.checksum.ok ? 'PASS' : 'FAIL'}`}
        {...labelArgs}
      >
        <div className={`csum-row ${decode.checksum.ok ? 'pass' : 'fail'}`}>
          <span className="csum-status">{decode.checksum.ok ? 'PASS' : 'FAIL'}</span>
          <div className="csum-detail">
            <span>Stored: <code>{decode.checksum.storedHex}</code></span>
            <span>Computed: <code>{decode.checksum.computedHex}</code></span>
          </div>
        </div>
        <p className="note-text">
          Algorithm (NOT RFC1071): seed = 6825 (0x1AA9); for i in
          0..32768, add u16 BE at file[i*2], treat the word at i==16
          (= file 0x20, the stored slot itself) as zero, accumulate
          modulo 65535, return <code>65535 - sum</code>. Source:
          mqreader.js <code>calcChecksum()</code>.
        </p>
      </Section>

      <Section
        regionId="game1-mysteries"
        title="Game 1 mysteries solved"
        range="file 0x8FA4..0x8FAA (52 bits)"
        confidence="confirmed"
        parsedSnapshot={`${decode.mysteries.filter(m => m.set).length} / ${decode.mysteries.length} solved`}
        {...labelArgs}
      >
        {decode.mysteries.filter(m => m.set).length === 0 ? (
          <p className="muted">No mysteries solved.</p>
        ) : (
          <ul className="game1-flag-list">
            {decode.mysteries.filter(m => m.set).map(m => (
              <li key={m.index}>{m.name}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        regionId="game1-classmates"
        title="Game 1 active classmate pool"
        range="file 0x64D8, 11 slots × 164 bytes"
        confidence="confirmed"
        parsedSnapshot={`${decode.classmates.filter(c => c.classmateId > 0).length} / 11 slots occupied`}
        {...labelArgs}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Classmate ID</th>
              <th>Name</th>
              <th className="col-right">Friendship P1</th>
              <th className="col-right">Friendship P2</th>
            </tr>
          </thead>
          <tbody>
            {decode.classmates.map(c => (
              <tr key={c.slotIndex} className={c.classmateId === 0 ? 'resident-vacant' : ''}>
                <td>{c.slotIndex + 1}</td>
                <td>
                  <code className="muted">
                    {c.classmateId.toString().padStart(3, '0')}
                  </code>
                </td>
                <td>
                  {c.classmateId > 0
                    ? <strong>{c.name}</strong>
                    : <span className="muted">(empty)</span>}
                </td>
                <td className="col-right">{c.classmateId > 0 ? c.friendshipP1 : '—'}</td>
                <td className="col-right">{c.classmateId > 0 ? c.friendshipP2 : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {decode.players.map(p => p.enrolled && (
        <Game1PlayerSection key={p.playerIndex} player={p} {...labelArgs} />
      ))}
    </div>
  );
}

interface Game1PlayerSectionProps {
  player: import('../lib/savefile/types').Game1Player;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
}

function Game1PlayerSection({ player, notes, setNotes, fileLabel, payloadSha }: Game1PlayerSectionProps) {
  const labelArgs = { notes, setNotes, fileLabel, payloadSha };
  const learnedSpells = player.magicSpells.filter(s => s.set);
  const learnedIncants = player.incantations.filter(s => s.set);
  const earnedTitles = player.titles.filter(t => t.set);

  return (
    <Section
      regionId={`game1-player-${player.playerIndex}`}
      title={`Game 1 Player ${player.playerIndex + 1}: ${player.name || '(unnamed)'} — ${player.wizardLevelName}`}
      range={`file 0x${(0x9df8 + 0x17e4 * player.playerIndex).toString(16).toUpperCase()}+, stride 0x17E4`}
      confidence="confirmed"
      parsedSnapshot={`name=${JSON.stringify(player.name)} level=${player.wizardLevelName} stars=${player.stars} ritch=${player.ritch}`}
      {...labelArgs}
    >
      <dl className="kv">
        <dt>Player name <span className="muted small">(code+0x00, 20 bytes UTF-16 LE)</span></dt>
        <dd><strong className="player-name">{player.name || <span className="muted">(empty)</span>}</strong></dd>
        <dt>Magician Level <span className="muted small">(code+0x41, u8)</span></dt>
        <dd>{player.wizardLevelName} <code className="muted">({player.wizardLevel})</code></dd>
        <dt>Stars <span className="muted small">(code+0x40, u8)</span></dt>
        <dd>{player.stars}</dd>
        <dt>Gender <span className="muted small">(code+0x20D)</span></dt>
        <dd>{player.gender === 0 ? 'Male' : player.gender === 1 ? 'Female' : `(${player.gender})`}</dd>
        <dt>Birthday <span className="muted small">(code+0x20E day, +0x20F month)</span></dt>
        <dd>{player.birthdayMonth}/{player.birthdayDay}</dd>
        <dt>Ritch (carried) <span className="muted small">(code+0x208, u32 LE)</span></dt>
        <dd><strong>{player.ritch.toLocaleString()}</strong> Ritch</dd>
        <dt>Bank balance <span className="muted small">(code+0x1348, u32 LE)</span></dt>
        <dd><strong>{player.bankBalance.toLocaleString()}</strong> Ritch</dd>
      </dl>

      <h5 className="subsection-head">Inventory (15 slots + equipment)</h5>
      <p className="note-text" style={{ marginTop: 0 }}>
        Each slot is a u16 LE item ID. Item names from mqreader.js&apos;s
        embedded <code>items</code> dictionary aren&apos;t mirrored
        here yet — raw IDs only.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Slot</th>
            <th className="col-right">Item ID</th>
          </tr>
        </thead>
        <tbody>
          {player.inventory.slots.map((id, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td className="col-right">
                {id === 0 ? <span className="muted">(empty)</span> :
                  <code>0x{id.toString(16).padStart(4, '0')}</code>}
              </td>
            </tr>
          ))}
          {(['shirt', 'pants', 'shoes', 'headwear', 'eyewear', 'wizardHat'] as const).map(slot => {
            const id = player.inventory.equipped[slot];
            return (
              <tr key={slot}>
                <td>{slot}</td>
                <td className="col-right">
                  {id === 0 ? <span className="muted">(empty)</span> :
                    <code>0x{id.toString(16).padStart(4, '0')}</code>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h5 className="subsection-head">Magic learned ({learnedSpells.length} / {player.magicSpells.length})</h5>
      {learnedSpells.length === 0 ? (
        <p className="muted">No spells learned.</p>
      ) : (
        <ul className="game1-flag-list">
          {learnedSpells.map(s => <li key={s.name}>{s.name}</li>)}
        </ul>
      )}

      <h5 className="subsection-head">Incantations learned ({learnedIncants.length} / {player.incantations.length})</h5>
      {learnedIncants.length === 0 ? (
        <p className="muted">No incantations learned.</p>
      ) : (
        <ul className="game1-flag-list">
          {learnedIncants.map(s => <li key={s.name}>{s.name}</li>)}
        </ul>
      )}

      <h5 className="subsection-head">Titles earned ({earnedTitles.length} / {player.titles.length})</h5>
      {earnedTitles.length === 0 ? (
        <p className="muted">No titles earned.</p>
      ) : (
        <ul className="game1-flag-list">
          {earnedTitles.map(t => <li key={t.name}>{t.name}</li>)}
        </ul>
      )}
    </Section>
  );
}

interface SlotViewProps {
  slot: SlotParse;
  notes: NotesByRegion;
  setNotes: (n: NotesByRegion) => void;
  fileLabel: string;
  payloadSha: string;
  editCtx: EditCtx;
  /** True iff this is the slot the user is currently inspecting AND the
   *  one we expose edit controls on. The active-slot tab (the
   *  most-recently-written valid slot per chooseActiveSlot) is the only
   *  one with edit affordances exposed — pre-step-254 this was hardcoded
   *  to slot A and produced the wrong UI for saves whose last write
   *  landed in slot B. Every edit mirrors to both slots automatically. */
  editable: boolean;
  /** Lookup tables for ID -> EN-name cross-referencing. `null` until the
   *  fetch finishes; sections that need names should fall back gracefully. */
  lookups: SavefileLookups | null;
  /** Inventory iid↔stored_value bijection. `null` until the fetch
   *  finishes; the inventory bag section falls back to raw stored_value
   *  hex when this isn't yet loaded. */
  inventoryEncoding: InventoryEncoding | null;
  /** NPC stored_value ↔ NpcInfo encoding (translation-repo step-346).
   *  `null` until the fetch finishes; the Friends-Met section falls
   *  back to showing raw stored_value hex when this isn't yet loaded. */
  npcEncoding: NpcEncoding | null;
  /** Current + historical bulletin-board post texts, fair names and NPC
   *  names (public/data/board_posts.json). `null` until fetched. */
  boardIndex: BoardPostIndex | null;
  /** Per-record verdicts for this slot's board, computed by the parent. */
  boardAssessments: BoardAssessment[];
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
  inventoryEncoding,
  npcEncoding,
  boardIndex,
  boardAssessments,
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

      {/* Profile — step-258 re-resolution:
            Three INDEPENDENT fields, not three mirrors. step-252 had
            written player_name edits to all three of 0x47E + 0x1149C +
            0x114BA on the assumption they were mirror copies; submission
            #16 (player="WEASLEY" shop="Shop Weasleys" town="HOGSMEADE")
            proved each offset holds a different field. The
            pre-step-258 editor was clobbering town name + shop name
            on every player rename.
              * Player name @ body 0x1149C (character-record copy)
              * Shop name   @ body 0x114B2
              * Town name   @ body 0x47E
            Each renders + edits independently; writes mirror to slot B
            automatically inside applyEdits. */}
      <Section
        regionId={`${slot.label}-profile`}
        title={REGION_DESCRIPTORS.profile.title}
        range={REGION_DESCRIPTORS.profile.range}
        confidence={REGION_DESCRIPTORS.profile.confidence}
        parsedSnapshot={`player=${JSON.stringify(slot.playerName)} shop=${JSON.stringify(slot.shopName)} town=${JSON.stringify(slot.townName)}`}
        {...labelArgs}
      >
        <dl className="kv">
          <dt>
            Player name{' '}
            <span className="muted small">
              (body 0x1149C, UTF-16 LE × 5 chars max)
            </span>
          </dt>
          <dd>
            <strong className="player-name">
              {slot.playerName || <span className="muted">(empty)</span>}
            </strong>
            {editable && (
              <InlineEdit
                label="player name"
                beta
                pendingValue={
                  editCtx.edits.playerName !== undefined
                    ? editCtx.edits.playerName.value
                    : null
                }
                initialDraft={slot.playerName}
                maxChars={PLAYER_NAME_MAX_CHARS}
                onCommit={draft => {
                  if (draft.length === 0) {
                    return 'Player name cannot be empty.';
                  }
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
          <dt>
            Shop name{' '}
            <span className="muted small">
              (body 0x114B2, UTF-16 LE × 6 chars max)
            </span>
          </dt>
          <dd>
            <strong className="player-name">
              {slot.shopName || <span className="muted">(empty)</span>}
            </strong>
            {editable && (
              <InlineEdit
                label="shop name"
                beta
                pendingValue={
                  editCtx.edits.shopName !== undefined
                    ? editCtx.edits.shopName.value
                    : null
                }
                initialDraft={slot.shopName}
                maxChars={SHOP_NAME_MAX_CHARS}
                onCommit={draft => {
                  if (draft.length > SHOP_NAME_MAX_CHARS) {
                    return `Max ${SHOP_NAME_MAX_CHARS} characters.`;
                  }
                  editCtx.setEdits(e => ({
                    ...e,
                    shopName: { value: draft },
                  }));
                  return null;
                }}
                onClear={() =>
                  editCtx.setEdits(e => {
                    const next = { ...e };
                    delete next.shopName;
                    return next;
                  })
                }
              />
            )}
          </dd>
          <dt>
            Town name{' '}
            <span className="muted small">
              (body 0x47E, UTF-16 LE × 5 chars max)
            </span>
          </dt>
          <dd>
            <strong className="player-name">
              {slot.townName || <span className="muted">(empty)</span>}
            </strong>
            {editable && (
              <InlineEdit
                label="town name"
                beta
                pendingValue={
                  editCtx.edits.townName !== undefined
                    ? editCtx.edits.townName.value
                    : null
                }
                initialDraft={slot.townName}
                maxChars={TOWN_NAME_MAX_CHARS}
                onCommit={draft => {
                  if (draft.length > TOWN_NAME_MAX_CHARS) {
                    return `Max ${TOWN_NAME_MAX_CHARS} characters.`;
                  }
                  editCtx.setEdits(e => ({
                    ...e,
                    townName: { value: draft },
                  }));
                  return null;
                }}
                onClear={() =>
                  editCtx.setEdits(e => {
                    const next = { ...e };
                    delete next.townName;
                    return next;
                  })
                }
              />
            )}
          </dd>
        </dl>
        <p className="note-text" style={{ marginTop: 8 }}>
          <strong>step-258 re-resolution.</strong> step-252 had treated
          body 0x47E, body 0x1149C, and body 0x114BA as three "mirror
          copies" of the player name, mirroring every player-name edit
          to all three. Submission #16 (player &quot;WEASLEY&quot;, shop
          &quot;Shop Weasleys&quot;, town &quot;HOGSMEADE&quot;) proved
          that&apos;s wrong: body 0x47E holds the TOWN name, body 0x114B2
          holds the SHOP name, and body 0x114BA is a misread offset
          inside the same shop-name field. The fields are independent —
          the editor now writes to each one in isolation. (No automatic
          repair of previously-corrupted saves; if your town or shop
          name got overwritten with your player name by the
          pre-step-258 editor, re-edit those fields manually now that
          they&apos;re individually exposed.)
        </p>
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
        parsedSnapshot={`wallet=${slot.ritch ?? 'null'} bank=${slot.bank ?? 'null'} (player record ${slot.activePlayer})`}
        {...labelArgs}
      >
        {slot.ritch === null ? (
          <p className="muted">Wallet field is 0xFFFFFFFF — never written.</p>
        ) : (
          <p className="ritch-value">
            <strong>{slot.ritch.toLocaleString()}</strong> Ritch in the wallet
            <span className="muted small"> (cap {WALLET_MAX.toLocaleString()})</span>
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
              if (!Number.isFinite(v) || v < 0 || v > WALLET_MAX) {
                return `Must be a whole number 0..${WALLET_MAX.toLocaleString()} (the game caps the wallet there).`;
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
        <p className="ritch-value" style={{ marginTop: 10 }}>
          <strong>{(slot.bank ?? 0).toLocaleString()}</strong> Ritch in the bank
          <span className="muted small"> (cap {BANK_MAX.toLocaleString()}; player record +0x1E4)</span>
        </p>
        {editable && (
          <InlineEdit
            label="bank balance"
            pendingValue={editCtx.edits.bank !== undefined ? editCtx.edits.bank.value.toString() : null}
            pendingLabel={editCtx.edits.bank !== undefined ? editCtx.edits.bank.value.toLocaleString() : undefined}
            initialDraft={slot.bank?.toString() ?? '0'}
            onCommit={draft => {
              const v = Number.parseInt(draft, 10);
              if (!Number.isFinite(v) || v < 0 || v > BANK_MAX) {
                return `Must be a whole number 0..${BANK_MAX.toLocaleString()} (the game caps the bank there).`;
              }
              editCtx.setEdits(e => ({ ...e, bank: { value: v } }));
              return null;
            }}
            onClear={() =>
              editCtx.setEdits(e => {
                const next = { ...e };
                delete next.bank;
                return next;
              })
            }
          />
        )}
        <p className="note-text">
          Both live in player record {slot.activePlayer} (the one the header says
          was played last); the record&apos;s own checksum is recomputed on download.
          The bank balance was identified in the 2026-10-06 trace (translation
          repo notes/savefile_format.md §58.3).
        </p>
      </Section>

      {/* Inventory bag — 15-slot player inventory @ body 0x1D9B6 (step-260
          cracked the iid↔stored bijection via ARM9 lookup function
          0x0200BB2C). Each 6-byte record stores `u16 LE stored_value | 3B
          pad | u8 quantity` for occupied slots, or the sentinel
          `ff ff ff ff ff 00` for empty slots. Edits mirror to both slot A
          and slot B following the same write-both pattern every other
          edit kind uses. */}
      <InventoryBagSection
        slot={slot}
        editable={editable}
        editCtx={editCtx}
        lookups={lookups}
        inventoryEncoding={inventoryEncoding}
        notes={notes}
        setNotes={setNotes}
        fileLabel={fileLabel}
        payloadSha={payloadSha}
      />


      {/* Wizard level + rank — script variables 0x1002 / 0x1003 in the
          player record (translation repo notes/savefile_format.md §58.4;
          license overlay ov091). */}
      {(() => {
        const rec = slot.playerRecords[slot.activePlayer];
        if (!rec || rec.blank) return null;
        const lvl = editCtx.edits.wizardLevel?.value ?? rec.wizardLevel;
        const rank = editCtx.edits.wizardRank?.value ?? rec.rankIndex;
        const badge = Math.min(5, Math.floor(lvl / 10));
        const stars = lvl >= 50 ? 9 : Math.max(0, (lvl % 10) - 1);
        const titleName = itemNameFor(rec.titleItem, lookups, inventoryEncoding);
        return (
          <Section
            regionId={`${slot.label}-wizard`}
            title={REGION_DESCRIPTORS.wizard.title}
            range={REGION_DESCRIPTORS.wizard.range}
            confidence={REGION_DESCRIPTORS.wizard.confidence}
            parsedSnapshot={`level=${rec.wizardLevel} rank=${rec.rankIndex} (${WIZARD_RANK_NAMES[rec.rankIndex] ?? '?'}) title item=${rec.titleItem} wand token=0x${rec.wandToken.toString(16)}`}
            {...labelArgs}
          >
            <dl className="kv">
              <dt>Wizard level <span className="muted small">(1..50)</span></dt>
              <dd>
                <strong>{lvl}</strong>{' '}
                <span className="muted small">
                  → the license card shows {stars} star{stars === 1 ? '' : 's'}{badge > 0 ? ` and badge tier ${badge}` : ''}
                </span>
                {editable && (
                  <InlineEdit
                    label="wizard level"
                    beta
                    pendingValue={editCtx.edits.wizardLevel !== undefined ? String(editCtx.edits.wizardLevel.value) : null}
                    initialDraft={String(rec.wizardLevel)}
                    onCommit={draft => {
                      const v = Number.parseInt(draft, 10);
                      if (!Number.isInteger(v) || v < 1 || v > WIZARD_LEVEL_MAX) return `Must be 1..${WIZARD_LEVEL_MAX}.`;
                      editCtx.setEdits(e => ({ ...e, wizardLevel: { value: v } }));
                      return null;
                    }}
                    onClear={() => editCtx.setEdits(e => { const n = { ...e }; delete n.wizardLevel; return n; })}
                  />
                )}
              </dd>
              <dt>Rank <span className="muted small">(0..5)</span></dt>
              <dd>
                <strong>{WIZARD_RANK_NAMES[rank] ?? `rank ${rank}`}</strong>{' '}
                <span className="muted small">(index {rank})</span>
                {editable && (
                  <InlineEdit
                    label="rank"
                    beta
                    pendingValue={editCtx.edits.wizardRank !== undefined ? String(editCtx.edits.wizardRank.value) : null}
                    pendingLabel={editCtx.edits.wizardRank !== undefined ? WIZARD_RANK_NAMES[editCtx.edits.wizardRank.value] : undefined}
                    initialDraft={String(rec.rankIndex)}
                    onCommit={draft => {
                      const v = Number.parseInt(draft, 10);
                      if (!Number.isInteger(v) || v < 0 || v > WIZARD_RANK_MAX) return `Must be 0..${WIZARD_RANK_MAX} (${WIZARD_RANK_NAMES.join(', ')}).`;
                      editCtx.setEdits(e => ({ ...e, wizardRank: { value: v } }));
                      return null;
                    }}
                    onClear={() => editCtx.setEdits(e => { const n = { ...e }; delete n.wizardRank; return n; })}
                  />
                )}
              </dd>
              <dt>Title</dt>
              <dd>{titleName ?? <span className="muted">(none equipped)</span>} <span className="muted small">— the item in equipped slot 7; the six Magus titles are items 3284..3289</span></dd>
              <dt>Wand</dt>
              <dd><code className="muted">token 0x{rec.wandToken.toString(16)}</code> <span className="muted small">— equipped slot 8 (wand tokens encode type and a grade; shown raw)</span></dd>
            </dl>
            <p className="note-text">
              Level and rank are separate bytes the game never derives from one
              another; the game raises both as you progress. Setting a level
              without the matching rank (or title item) gives a card that shows,
              say, nine stars next to &quot;Apprentice&quot;. BETA — the write is
              a single byte each in player record {slot.activePlayer} (checksum
              recomputed), checked only by reading the code, not yet in the game.
            </p>
          </Section>
        );
      })()}

      <PlayerRecordsSection slot={slot} {...labelArgs} />

      <NpcAffinitySection
        slot={slot}
        editable={editable}
        editCtx={editCtx}
        npcEncoding={npcEncoding}
        lookups={lookups}
        inventoryEncoding={inventoryEncoding}
        {...labelArgs}
      />

      <ShopSection slot={slot} lookups={lookups} inventoryEncoding={inventoryEncoding} {...labelArgs} />

      <CustomItemsSection slot={slot} lookups={lookups} inventoryEncoding={inventoryEncoding} {...labelArgs} />

      <WorldObjectsSection slot={slot} lookups={lookups} inventoryEncoding={inventoryEncoding} {...labelArgs} />

      {/* Collection bitmaps — 10-bitmap family at slot+0x1CDF0 surfaced
          for diagnostics (translation-repo notes/savefile_format.md §57,
          step-364). Only the first member (0x1CDF2 / 173 bits) has
          confirmed semantics — that's the §53 clothing+garden inventory
          and it's editable via the Inventory Bag section above. The
          other nine are surfaced read-only with their offsets, widths,
          populated-bit counts, raw hex, and (semantics TBD) labels so
          users can spot-correlate counts against in-game features while
          the caller-of-setters trace (step-365) pins their meanings. */}
      <Section
        regionId={`${slot.label}-collectionBitmaps`}
        title={REGION_DESCRIPTORS.collectionBitmaps.title}
        range={REGION_DESCRIPTORS.collectionBitmaps.range}
        confidence={REGION_DESCRIPTORS.collectionBitmaps.confidence}
        parsedSnapshot={`${slot.collectionBitmaps.length} bitmaps; ${slot.collectionBitmaps.reduce((n, b) => n + b.populatedBits, 0)} bits populated across the family`}
        {...labelArgs}
      >
        <p>
          Ten same-shape collection bitmaps packed back-to-back at{' '}
          <code>slot+0x1CDF2..0x1D0BD</code> (459 bytes total). All ten
          are serviced by the bit-set/bit-test primitive at ARM9{' '}
          <code>0x0201BCB0</code> — each row below is one bitmap and the{' '}
          <em>setter</em> column is the ARM9 wrapper that owns it.
        </p>
        <p className="note-text">
          Read-only diagnostic view. The first bitmap (<code>0x1CDF2</code>,
          173 bits) is the §53 Clothing + Garden inventory and is editable
          via the Inventory Bag section above. The other nine
          (<em>semantics TBD</em>) are documented in translation-repo{' '}
          <code>notes/savefile_format.md</code> §57; the caller-of-setters
          trace (translation-repo step-365) is the work that pins them.
          An eleventh setter at <code>0x0201B6A8</code> uses the same bit
          primitive against a separate BSS buffer that is{' '}
          <em>not</em> mirrored into the save file, so it is intentionally
          absent from this list.
        </p>
        {slot.collectionBitmaps.length === 0 ? (
          <p className="muted">No bitmap data — slot is uninitialised or too short.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Offset</th>
                <th>Max bits</th>
                <th>Populated</th>
                <th>Setter (ARM9)</th>
                <th>Label / semantic note</th>
              </tr>
            </thead>
            <tbody>
              {slot.collectionBitmaps.map(bm => (
                <tr key={bm.offset}>
                  <td>
                    <code>0x{bm.offset.toString(16).toUpperCase().padStart(5, '0')}</code>
                  </td>
                  <td>{bm.maxBits.toLocaleString()}</td>
                  <td>
                    <strong>{bm.populatedBits.toLocaleString()}</strong>
                    <span className="muted"> / {bm.maxBits.toLocaleString()}</span>
                  </td>
                  <td>
                    <code>0x{bm.setterAddr.toString(16).toUpperCase().padStart(8, '0')}</code>
                  </td>
                  <td>
                    {bm.label ? (
                      <strong>{bm.label}</strong>
                    ) : (
                      <span className="muted"><em>semantics TBD</em></span>
                    )}
                    <div className="note-text">{bm.semanticNote}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <details className="tile-details">
          <summary>Show raw hex per bitmap (debugging)</summary>
          <table className="data-table">
            <thead>
              <tr>
                <th>Offset</th>
                <th>Bytes</th>
              </tr>
            </thead>
            <tbody>
              {slot.collectionBitmaps.map(bm => (
                <tr key={bm.offset}>
                  <td>
                    <code>0x{bm.offset.toString(16).toUpperCase().padStart(5, '0')}</code>
                  </td>
                  <td><code className="hex-cell muted">{bm.rawHex}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </Section>

      {/* Bulletin board — 14 records at body 0x162BC. step-408: the
          region previously labelled "catalog announcements" (scanned from
          0x162B6) is the board; the v2.6.3 patch changed how long posts
          are stored, and the editor now understands both forms, flags
          posts the pre-v2.6.3 overflow damaged, and can bring every
          system post up to the current translation. */}
      <BulletinBoardSection
        slot={slot}
        editable={editable}
        editCtx={editCtx}
        boardIndex={boardIndex}
        assessments={boardAssessments}
        notes={notes}
        setNotes={setNotes}
        fileLabel={fileLabel}
        payloadSha={payloadSha}
      />

      {/* Letter queues — 10 + 12 records right after the board, same
          168-byte layout. Filled by a routine the board patch does not
          touch, so text stays plain UTF-16 (67 chars). */}
      <LettersSection
        slot={slot}
        editable={editable}
        editCtx={editCtx}
        boardIndex={boardIndex}
        notes={notes}
        setNotes={setNotes}
        fileLabel={fileLabel}
        payloadSha={payloadSha}
      />

      {/* Note: the "Town residents" section was previously placed here
          (below the catalog section). It now lives above the Garden
          section so the player-relevant data (player name, school, ritch,
          inventory, residents, garden, catalog) cluster together near the
          top of the editor, ahead of the lower-confidence diagnostic
          regions. */}
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
  const [inventoryEncoding, setInventoryEncoding] =
    useState<InventoryEncoding | null>(null);
  // step-NNN-friends-met: NPC encoding cracked in translation-repo
  // step-346. Loaded once on mount; the Friends-Met section falls back to
  // showing raw stored_value hex when this hasn't loaded yet.
  const [npcEncoding, setNpcEncoding] = useState<NpcEncoding | null>(null);
  // step-408: bulletin-board post index (current + historical texts) so
  // the board section can recognise damaged posts and offer the current
  // translation. null until fetched; the section degrades to read-only.
  const [boardIndex, setBoardIndex] = useState<BoardPostIndex | null>(null);
  const [boardIndexFailed, setBoardIndexFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadSavefileLookups().then(result => {
      if (!cancelled) setLookups(result);
    });
    loadInventoryEncoding().then(result => {
      if (!cancelled) setInventoryEncoding(result);
    });
    loadNpcEncoding().then(result => {
      if (!cancelled) setNpcEncoding(result);
    });
    loadBoardPostIndex().then(result => {
      if (cancelled) return;
      if (result) setBoardIndex(result);
      else setBoardIndexFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const editCtx = useMemo<EditCtx>(() => ({ edits, setEdits }), [edits]);
  const editCount = pendingEditCount(edits);

  // Board verdicts for whichever slot is on screen, and separately for
  // the editable (active) slot — the latter is what staged board actions
  // are resolved against when the file is written.
  const slotForTab = activeSlotTab === 'A' ? parse?.slotA : parse?.slotB;
  const activeSlotParse =
    parse?.activeSlot === 'A' ? parse?.slotA : parse?.activeSlot === 'B' ? parse?.slotB : undefined;
  const boardAssessments = useMemo<BoardAssessment[]>(
    () => (slotForTab ? assessBoard(slotForTab.boardRecords, boardIndex, slotForTab.playerName) : []),
    [slotForTab, boardIndex],
  );
  const boardEditContext = useMemo<BoardEditContext | null>(() => {
    if (!activeSlotParse || activeSlotParse.uninitialised) return null;
    return {
      records: activeSlotParse.boardRecords,
      assessments: assessBoard(activeSlotParse.boardRecords, boardIndex, activeSlotParse.playerName),
    };
  }, [activeSlotParse, boardIndex]);

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

    // Fire the silent background upload in parallel with parsing. We
    // deliberately do NOT await it — the local editor flow proceeds on its
    // own clock and never blocks on the network round-trip. The function
    // swallows any error internally (console.error only).
    void silentBackgroundUpload(file);

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
      const editList = editsToPendingList(edits, boardEditContext, activeSlotParse?.activePlayer ?? 0);
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

  const noteCount = Object.keys(notes).length;
  const payloadSha = parse?.payloadSha256 ?? '';
  const fileLabel = fileMeta?.name ?? 'unknown';

  return (
    <div className="inspector-wrap">
      <div className="inspector-card">
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
              .sav, .dsv, .duc, .savn, .dat, .bin — up to 4 MB.
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

            {/* Game 1 (Magician's Quest / Enchanted Folk) decoder panel —
                DORMANT for every Tongari Boushi (Game 3) save in our
                corpus. Renders only when the file magic at 0x00 matches
                Game 1 (0x0DCEAB8906593DA2). Ported from LaytonLoztew's
                mqreader.js (see translation repo
                notes/_external_mqreader.js for the full source the
                offsets were lifted from). step-262. */}
            {parse.game1 && <Game1Panel decode={parse.game1} {...{ notes, setNotes, fileLabel, payloadSha }} />}

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
                // Expose edits on the active (most-recently-written) slot
                // rather than hardcoding slot A. Edits still mirror to
                // both slots automatically; this just changes which tab
                // surfaces the affordance so the inputs the user sees
                // reflect the bytes they're actually editing. Pre-step-254
                // this was hardcoded `activeSlotTab === 'A'`, which
                // exposed edits on stale slot-A data for any save whose
                // last write landed in slot B.
                editable={
                  parse.activeSlot !== null &&
                  activeSlotTab === parse.activeSlot &&
                  !slotForTab.uninitialised
                }
                lookups={lookups}
                inventoryEncoding={inventoryEncoding}
                npcEncoding={npcEncoding}
                boardIndex={boardIndex}
                boardAssessments={boardAssessments}
              />
            )}
            {boardIndexFailed && (
              <p className="csum-warn">
                The bulletin-board post index (<code>data/board_posts.json</code>) failed to load, so
                posts cannot be checked against the current translation this visit. Reload to retry.
              </p>
            )}

            <section className="editor-footer">
              <div className="editor-banner">
                <strong>Back up your original save first.</strong>{' '}
                Ritch, player name and the bulletin-board repairs have been
                checked in the game; the bank balance, NPC affinity and the
                other fields have not. If the
                modified save breaks something, you&apos;ll want the
                original to fall back to. Edits are applied to both slot A
                and slot B, and all three checksums the game verifies are
                recomputed.
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
        .entries-list li.is-pending-remove {
          background: #fef3f3;
          border-color: #f5c2c0;
        }
        .entry-meta {
          display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
          color: var(--color-ink-soft); font-size: 0.74rem;
          margin-bottom: 4px;
        }
        .entry-remove-tag {
          padding: 1px 8px; border-radius: var(--radius-pill);
          background: #fde2e0; color: #a3261e;
          border: 1px solid #f3b9b6;
          font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em;
          font-weight: 700;
        }
        .entry-text { font-size: 0.9rem; color: var(--color-ink); white-space: pre-wrap; }
        .entry-text-removed {
          text-decoration: line-through;
          color: var(--color-ink-soft);
        }
        .entry-edit-row {
          display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start;
          margin-top: 4px;
        }
        .entry-remove-btn {
          padding: 3px 10px; border-radius: var(--radius-pill);
          background: white; border: 1px solid #f3b9b6;
          color: #a3261e;
          font: inherit; font-size: 0.78rem; font-weight: 600;
          cursor: pointer;
        }
        .entry-remove-btn:hover { background: #fef3f3; }
        .entry-remove-btn.entry-remove-undo {
          background: #fef3f3;
          color: #6e1a14;
        }

        /* Bulletin board */
        .board-list { max-height: 640px; }
        .board-summary {
          display: flex; flex-direction: column; gap: 8px;
          padding: 10px 12px; margin: 6px 0 8px;
          background: var(--color-purple-50);
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
        }
        .board-summary-counts { display: flex; flex-wrap: wrap; gap: 10px; font-size: 0.82rem; }
        .board-summary-item { display: inline-flex; align-items: center; gap: 4px; }
        .board-actions { display: flex; flex-wrap: wrap; gap: 8px; }
        .board-btn {
          padding: 3px 10px; border-radius: var(--radius-pill);
          background: white; border: 1px solid var(--color-purple-100);
          color: var(--color-purple-600);
          font: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer;
        }
        .board-btn:hover { background: var(--color-purple-50); }
        .board-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .board-btn-primary {
          background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400));
          color: white; border: none; padding: 6px 14px; font-size: 0.82rem;
        }
        .board-btn-primary:hover { transform: translateY(-1px); background: linear-gradient(135deg, var(--color-pink-400), var(--color-purple-400)); }
        .board-pill {
          display: inline-block; padding: 1px 8px; border-radius: var(--radius-pill);
          font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
          border: 1px solid transparent;
        }
        .board-pill-current, .board-pill-unfilled { background: #d9f3df; color: #2c8a4a; border-color: #b9e2c4; }
        .board-pill-player { background: var(--color-purple-100); color: var(--color-purple-600); }
        .board-pill-outdated { background: #fff1c4; color: #b07f00; border-color: #f3d774; }
        .board-pill-damaged { background: #fde4d2; color: #a64a1a; border-color: #f5c69e; }
        .board-pill-unrecoverable, .board-pill-unknown { background: #fde2e0; color: #a3261e; border-color: #f3b9b6; }
        .board-pill-empty { background: var(--color-purple-50); color: var(--color-ink-soft); }
        .board-post.status-damaged, .board-post.status-outdated { border-left: 3px solid #f3d774; }
        .board-post.status-unrecoverable, .board-post.status-unknown { border-left: 3px solid #f3b9b6; }
        .board-post.is-staged { background: #fffbe6; border-color: #f3d774; }
        .board-title { font-weight: 700; color: var(--color-purple-600); font-size: 0.9rem; white-space: pre-wrap; }
        .board-detail { margin: 4px 0 0; font-size: 0.78rem; color: var(--color-ink-soft); }
        .board-current {
          margin-top: 4px; padding: 6px 8px;
          background: white; border: 1px dashed var(--color-purple-100); border-radius: var(--radius-md);
        }

        /* Inventory bag editor */
        .inventory-bag-table tr.is-pending {
          background: #fffbe6;
        }
        .inventory-combobox {
          position: relative;
          width: 100%;
          max-width: 260px;
        }
        .inventory-item-input {
          width: 100%;
          padding: 4px 8px;
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
          background: white;
          font: inherit; font-size: 0.85rem;
          color: var(--color-ink);
        }
        .inventory-item-input:focus {
          outline: 2px solid var(--color-purple-100);
        }
        .inventory-item-input::placeholder {
          font-style: italic;
          color: var(--color-ink-soft);
        }
        .inventory-item-input:disabled {
          background: var(--color-purple-50);
          cursor: not-allowed;
        }
        .inventory-item-popover {
          position: absolute;
          z-index: 30;
          top: calc(100% + 2px);
          left: 0;
          width: 100%;
          max-height: 220px;
          overflow-y: auto;
          margin: 0;
          padding: 4px 0;
          list-style: none;
          background: white;
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
          box-shadow: 0 6px 16px rgba(60, 40, 90, 0.15);
        }
        .inventory-item-option {
          padding: 4px 10px;
          font-size: 0.85rem;
          color: var(--color-ink);
          cursor: pointer;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .inventory-item-option.is-highlighted {
          background: var(--color-purple-50);
          color: var(--color-purple-600);
        }
        .inventory-item-option.is-empty-option {
          font-style: italic;
          color: var(--color-ink-soft);
          border-bottom: 1px solid var(--color-purple-100);
        }
        .inventory-item-option.is-empty-option.is-highlighted {
          color: var(--color-purple-600);
          background: var(--color-purple-50);
        }
        .inventory-item-empty-state {
          padding: 6px 10px;
          font-size: 0.8rem;
          color: var(--color-ink-soft);
          font-style: italic;
        }
        .inventory-qty-input {
          width: 70px;
          padding: 4px 6px;
          border: 1px solid var(--color-purple-100);
          border-radius: var(--radius-md);
          background: white;
          font: inherit; font-size: 0.85rem;
          color: var(--color-ink);
          text-align: right;
        }
        .inventory-qty-input:focus { outline: 2px solid var(--color-purple-100); }
        .inventory-bag-actions {
          margin-top: 8px;
          display: flex; gap: 8px; flex-wrap: wrap;
        }

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
