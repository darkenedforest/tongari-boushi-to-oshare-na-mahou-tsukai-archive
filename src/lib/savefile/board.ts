// Bulletin board records in a Tongari Boushi save.
//
// The board block starts at body 0x162BC (slot-body start + 0x14 + 0x162A8,
// the offset the game's record-copy routine 0x02053F2C works from) and holds
// 14 post records of 0xA8 = 168 bytes, followed by two letter queues (10 and
// 12 records) in the same layout. Layout per translation-repo
// notes/board_post_engine_map.md:
//
//   +0x00  0x88 bytes  post text: title, 0x000A, body rows, NUL (68 UTF-16 units)
//   +0x88  0x16 bytes  author name (11 UTF-16 units)
//   +0x9E  u16         message number in msg98 (7061 = msg98070 entry 61); 0 = player post
//   +0xA0  u16         author id: NPC id, 0x1774+n for a player, 0x1773 for a visitor; 0xFFFF = empty slot
//   +0xA2  u16         id of the character named in the text ([LETTER_ADDRESSEE])
//   +0xA4  u8          0 = text not filled in yet, 1 = filled
//   +0xA5  s8          month (0-based)
//   +0xA6  s8          day (0-based)
//   +0xA7  s8          weekday
//
// Before v2.6.3 the game filled the text field unbounded, so an English post
// over 67 characters overwrote the author, then the ids, then the flag and
// date. An author name over 10 characters did the same from the author
// field. v2.6.3 stores long text in the same field as 0xFFFF followed by
// UTF-8 ("packed"), and reads both forms.
//
// The classification below is a port of the translation repo's
// src/translator/_board_save_repair.py (step-429), which was checked in the
// emulator against bug report #17's save on the v2.6.3 ROM.

export const BOARD_BASE = 0x162bc;
export const BOARD_RECORD_SIZE = 0xa8;
export const BOARD_COUNT = 14;
/** Letter queues follow the 14 board records: 10 records, then 12. */
export const LETTERS_BASE = BOARD_BASE + BOARD_COUNT * BOARD_RECORD_SIZE; // 0x16BEC
export const LETTERS_COUNT = 22;

export const TEXT_FIELD = 0x88;
export const AUTHOR_OFF = 0x88;
export const AUTHOR_FIELD = 0x16;
const O_MSG = 0x9e;
const O_A0 = 0xa0;
const O_A2 = 0xa2;
const O_FLAG = 0xa4;
const O_MONTH = 0xa5;
const O_DAY = 0xa6;
const O_WD = 0xa7;

/** A plain (UTF-16) post may hold this many characters. */
export const TEXT_PLAIN_MAX = 67;
/** A packed (0xFFFF + UTF-8) post may hold this many bytes of UTF-8 —
 *  the panel limit the translation repo enforces on every shipped post. */
export const TEXT_PACKED_MAX_BYTES = 132;
export const AUTHOR_PLAIN_MAX = 10;

/** Author ids the game uses for the player's own posts (0x1774 + n) and a
 *  visitor's post (0x1773). */
const PLAYER_ID_MIN = 0x1773;
const PLAYER_ID_MAX = 0x1777;

/** Posts whose author is the same character every time (repair tool):
 *  7061 Secret Store opening — Cat Sith (3004); 7067 — Daisy (2006),
 *  inferred: an advertisement is signed by the shop's owner. */
const FIXED_AUTHOR: Record<number, number> = { 7061: 3004, 7067: 2006 };
const INFERRED_AUTHOR = new Set([7067]);

const QUOTE_MARK = '§';
const BREAK_MARK = '▼';

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Record decoding
// ---------------------------------------------------------------------------

export interface BoardRecord {
  /** 0..13 for the board, 0..21 for the letter queues. */
  index: number;
  bodyOffset: number;
  /** Copy of the 168 record bytes (needed to keep a record verbatim). */
  raw: Uint8Array;
  rawHex: string;
  /** a0 == 0xFFFF and every byte before the message number is zero. */
  empty: boolean;
  text: string;
  /** True when the text field holds 0xFFFF + UTF-8 (v2.6.3 form). */
  textPacked: boolean;
  /** UTF-16 units before the first NUL when read unbounded across the
   *  record (up to 84). Over 67 means the pre-v2.6.3 game overflowed. */
  textUnits: number;
  author: string;
  authorPacked: boolean;
  /** All 11 author units are non-zero: the name filled its field and ran on
   *  over the message number. */
  authorOverran: boolean;
  msg: number;
  authorId: number;
  addresseeId: number;
  flag: number;
  month: number;
  day: number;
  weekday: number;
}

function u16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

function readPlainUnits(b: Uint8Array, off: number, maxUnits: number): string {
  let out = '';
  for (let i = 0; i < maxUnits && off + 2 * i + 1 < b.length; i++) {
    const u = u16(b, off + 2 * i);
    if (u === 0) break;
    out += String.fromCharCode(u);
  }
  return out;
}

/** Decode a text or author field the way the patched viewer does. */
export function decodeField(
  b: Uint8Array,
  off: number,
  fieldBytes: number,
  maxUnitsUnbounded: number,
): { text: string; packed: boolean; units: number } {
  if (b[off] === 0xff && b[off + 1] === 0xff) {
    let end = off + 2;
    const stop = off + fieldBytes;
    while (end < stop && b[end] !== 0) end++;
    return { text: utf8Decoder.decode(b.subarray(off + 2, end)), packed: true, units: 0 };
  }
  const unbounded = readPlainUnits(b, off, maxUnitsUnbounded);
  return { text: unbounded, packed: false, units: unbounded.length };
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function decodeBoardRecord(body: Uint8Array, bodyOffset: number, index: number): BoardRecord {
  const raw = body.slice(bodyOffset, bodyOffset + BOARD_RECORD_SIZE);
  const a0 = u16(raw, O_A0);
  let zeroBeforeMsg = true;
  for (let i = 0; i < O_MSG; i++) {
    if (raw[i] !== 0) {
      zeroBeforeMsg = false;
      break;
    }
  }
  // Read the text unbounded across the whole record (84 units) so an
  // overflowed post reports how far it ran.
  const text = decodeField(raw, 0, TEXT_FIELD, BOARD_RECORD_SIZE / 2);
  const author = decodeField(raw, AUTHOR_OFF, AUTHOR_FIELD, 16);
  let authorOverran = false;
  if (!author.packed) {
    authorOverran = true;
    for (let i = 0; i < 11; i++) {
      if (u16(raw, AUTHOR_OFF + 2 * i) === 0) {
        authorOverran = false;
        break;
      }
    }
  }
  return {
    index,
    bodyOffset,
    raw,
    rawHex: bytesToHex(raw),
    empty: a0 === 0xffff && zeroBeforeMsg,
    text: text.packed ? text.text : text.text.slice(0, 82),
    textPacked: text.packed,
    textUnits: text.units,
    author: author.packed ? author.text : author.text.slice(0, 11),
    authorPacked: author.packed,
    authorOverran,
    msg: u16(raw, O_MSG),
    authorId: a0,
    addresseeId: u16(raw, O_A2),
    flag: raw[O_FLAG],
    month: raw[O_MONTH],
    day: raw[O_DAY],
    weekday: raw[O_WD],
  };
}

export function parseBoardRecords(body: Uint8Array): BoardRecord[] {
  const out: BoardRecord[] = [];
  for (let i = 0; i < BOARD_COUNT; i++) {
    const off = BOARD_BASE + i * BOARD_RECORD_SIZE;
    if (off + BOARD_RECORD_SIZE > body.length) break;
    out.push(decodeBoardRecord(body, off, i));
  }
  return out;
}

export function parseLetterRecords(body: Uint8Array): BoardRecord[] {
  const out: BoardRecord[] = [];
  for (let i = 0; i < LETTERS_COUNT; i++) {
    const off = LETTERS_BASE + i * BOARD_RECORD_SIZE;
    if (off + BOARD_RECORD_SIZE > body.length) break;
    out.push(decodeBoardRecord(body, off, i));
  }
  return out;
}

/** Split a decoded post into its title line and body rows. */
export function splitPost(text: string): { title: string; rows: string[] } {
  const lines = text.split('\n');
  return { title: lines[0] ?? '', rows: lines.slice(1) };
}

export function isPlayerAuthorId(id: number): boolean {
  return id >= PLAYER_ID_MIN && id <= PLAYER_ID_MAX;
}

export function isValidNpcAuthorId(id: number): boolean {
  return (id >= 1000 && id < 1140) || (id >= 2000 && id < 2033) || (id >= 3000 && id < 3079);
}

/** Author / addressee id → npc_data_ofs_id (0..251), or null. 1000+n is a
 *  student (record n), 2000+n staff (record 140+n), 3000+n a guest or
 *  creature (record 173+n). */
export function authorIdToOfs(id: number): number | null {
  if (id >= 1000 && id < 1140) return id - 1000;
  if (id >= 2000 && id < 2033) return 140 + (id - 2000);
  if (id >= 3000 && id < 3079) return 173 + (id - 3000);
  return null;
}

// ---------------------------------------------------------------------------
// Post index (public/data/board_posts.json)
// ---------------------------------------------------------------------------

export interface BoardPostIndex {
  fairs: Record<string, string>;
  /** npc_data_ofs_id → English NPC name. */
  names: Record<string, string>;
  /** message number → current text (with § and ▼ marks) + earlier texts. */
  posts: Record<string, { text: string; history: string[] }>;
}

let indexCached: BoardPostIndex | null = null;
let indexInflight: Promise<BoardPostIndex | null> | null = null;

function defaultIndexUrl(): string {
  let base = (import.meta.env.BASE_URL ?? '/').toString();
  if (!base.endsWith('/')) base += '/';
  return `${base}data/board_posts.json`;
}

export async function loadBoardPostIndex(url?: string): Promise<BoardPostIndex | null> {
  if (indexCached) return indexCached;
  if (indexInflight) return indexInflight;
  indexInflight = (async () => {
    try {
      const res = await fetch(url ?? defaultIndexUrl(), { cache: 'force-cache' });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || typeof data !== 'object' || !data.posts) return null;
      indexCached = {
        fairs: data.fairs ?? {},
        names: data.names ?? {},
        posts: data.posts,
      };
      return indexCached;
    } catch {
      return null;
    } finally {
      indexInflight = null;
    }
  })();
  return indexInflight;
}

/** Name for an author / addressee id: the player's own name for the
 *  player ids (and 0 / 5000, which the game resolves to the player), the
 *  NPC's English name otherwise. */
export function nameForId(index: BoardPostIndex, id: number, playerName: string): string | null {
  if (id === 0 || id === 5000 || isPlayerAuthorId(id)) return playerName;
  const ofs = authorIdToOfs(id);
  if (ofs === null) return null;
  return index.names[String(ofs)] ?? null;
}

/** What the game writes into the record for a database text: marks and
 *  colour tags dropped, ▼ → newline, [FAIR_MONTH:n] → the fair name, the
 *  name tags → `name`. */
export function expandPostText(index: BoardPostIndex, enText: string, name: string): string {
  let t = enText.split(QUOTE_MARK).join('').split(BREAK_MARK).join('\n');
  t = t.replace(/\[FAIR_MONTH:(\d+)\]/g, (_m, n) => index.fairs[String(Number(n))] ?? '');
  t = t.replace(/\[COLOR:\d+\]/g, '');
  t = t.replace(/\[(LETTER_ADDRESSEE|PLAYER_NAME)\]/g, name);
  return t;
}

/** Find the message number of an overflowed post from the text left in the
 *  record, against every text each post has shipped with. Tries the
 *  addressee's name, the player's name and no name for the name tags.
 *  Returns the number only when exactly one post matches. */
export function findMsgByText(
  index: BoardPostIndex,
  recordText: string,
  nameCandidates: string[],
): number | null {
  const names = Array.from(new Set([...nameCandidates.filter(n => n), '']));
  const key = recordText.slice(0, 48);
  const matches = new Set<number>();
  for (const [numStr, post] of Object.entries(index.posts)) {
    const variants = [post.text, ...post.history];
    outer: for (const v of variants) {
      for (const name of names) {
        if (expandPostText(index, v, name).slice(0, 48) === key) {
          matches.add(Number(numStr));
          break outer;
        }
      }
    }
  }
  if (matches.size === 1) return matches.values().next().value as number;
  if (matches.size > 1) return null;
  // Fallback: the title line alone, when it is unique.
  const title = recordText.split('\n')[0];
  if (!title) return null;
  const byTitle = new Set<number>();
  for (const [numStr, post] of Object.entries(index.posts)) {
    for (const v of [post.text, ...post.history]) {
      if (expandPostText(index, v, '').split('\n')[0] === title) {
        byTitle.add(Number(numStr));
        break;
      }
    }
  }
  return byTitle.size === 1 ? (byTitle.values().next().value as number) : null;
}

// ---------------------------------------------------------------------------
// Assessment — what is wrong with each record and what to do about it
// ---------------------------------------------------------------------------

export type BoardStatus =
  | 'empty'
  | 'player'
  | 'unfilled'
  | 'current'
  | 'outdated'
  | 'damaged'
  | 'unrecoverable'
  | 'unknown';

export type BoardFix =
  | {
      kind: 'unfilled';
      msg: number;
      a0: number;
      a2: number;
      month: number;
      day: number;
      weekday: number;
      authorInferred: boolean;
    }
  | {
      kind: 'write';
      msg: number;
      a0: number;
      a2: number;
      month: number;
      day: number;
      weekday: number;
      text: string;
    };

export interface BoardAssessment {
  status: BoardStatus;
  recommendation: 'keep' | 'update' | 'remove';
  /** Message number, from the record's ids or found from its text. */
  msg: number | null;
  /** The current translation of that message, expanded for display. */
  currentText: string | null;
  /** Repair that "Update to current translation" applies; null when the
   *  post cannot be brought up to date. */
  fix: BoardFix | null;
  detail: string;
}

export function assessBoard(
  records: BoardRecord[],
  index: BoardPostIndex | null,
  playerName: string,
): BoardAssessment[] {
  const goodDates = records
    .filter(r => r.authorId !== 0xffff && r.textUnits < 82 && r.month < 12)
    .map(r => ({ month: r.month, day: r.day, weekday: r.weekday }));

  return records.map(r => {
    if (r.empty) {
      return { status: 'empty', recommendation: 'keep', msg: null, currentText: null, fix: null, detail: 'Empty slot.' };
    }
    const n = r.textUnits;
    const isPlayer = r.msg === 0 && isPlayerAuthorId(r.authorId) && n <= TEXT_PLAIN_MAX;
    if (isPlayer) {
      return {
        status: 'player',
        recommendation: 'keep',
        msg: null,
        currentText: null,
        fix: null,
        detail: 'Written by a player; the translation does not touch it.',
      };
    }
    if (!index) {
      return {
        status: 'unknown',
        recommendation: 'keep',
        msg: null,
        currentText: null,
        fix: null,
        detail: 'Post index not loaded yet.',
      };
    }
    const known = (m: number) => Boolean(index.posts[String(m)]);
    const expandFor = (m: number, a2: number) =>
      expandPostText(index, index.posts[String(m)].text, nameForId(index, a2, playerName) ?? '');

    if (r.flag === 0 && known(r.msg) && isValidNpcAuthorId(r.authorId)) {
      return {
        status: 'unfilled',
        recommendation: 'keep',
        msg: r.msg,
        currentText: expandFor(r.msg, r.addresseeId),
        fix: null,
        detail: 'Not filled in yet — the game writes the current text the next time the board opens.',
      };
    }
    if (r.textPacked && known(r.msg) && isValidNpcAuthorId(r.authorId)) {
      const cur = expandFor(r.msg, r.addresseeId);
      const same = cur.trim() === r.text.trim();
      return {
        status: same ? 'current' : 'outdated',
        recommendation: same ? 'keep' : 'update',
        msg: r.msg,
        currentText: cur,
        fix: {
          kind: 'unfilled',
          msg: r.msg,
          a0: r.authorId,
          a2: r.addresseeId,
          month: r.month,
          day: r.day,
          weekday: r.weekday,
          authorInferred: false,
        },
        detail: same
          ? 'Stored in the v2.6.3 compact form with the current text.'
          : 'Stored in the v2.6.3 compact form, but the wording has changed since.',
      };
    }
    if (r.textPacked && known(r.msg)) {
      // Written directly by this editor (or the repair tool) because the
      // author id was lost: compact text, message number restored, author
      // field blank. Judged on its text alone.
      const cur = expandFor(r.msg, r.addresseeId);
      const same = cur.trim() === r.text.trim();
      return {
        status: same ? 'current' : 'outdated',
        recommendation: same ? 'keep' : 'update',
        msg: r.msg,
        currentText: cur,
        fix: {
          kind: 'write',
          msg: r.msg,
          a0: r.authorId,
          a2: r.addresseeId,
          month: r.month,
          day: r.day,
          weekday: r.weekday,
          text: cur,
        },
        detail: same
          ? 'Current text, written in directly; the author could not be recovered and stays blank.'
          : 'Written in directly with an older wording; the author stays blank.',
      };
    }
    if (n <= TEXT_PLAIN_MAX && r.authorOverran) {
      return {
        status: 'unrecoverable',
        recommendation: 'remove',
        msg: null,
        currentText: null,
        fix: null,
        detail:
          `The author's name ("${r.author}…") overran its field and overwrote the message number before the ` +
          'game looked the text up, so the text shown belongs to a different post. Nothing says what this post was.',
      };
    }
    if (n <= 78 && known(r.msg) && isValidNpcAuthorId(r.authorId)) {
      const cur = expandFor(r.msg, r.addresseeId);
      const same = cur.trim() === r.text.trim();
      const fix: BoardFix = {
        kind: 'unfilled',
        msg: r.msg,
        a0: r.authorId,
        a2: r.addresseeId,
        month: r.month,
        day: r.day,
        weekday: r.weekday,
        authorInferred: false,
      };
      if (n > TEXT_PLAIN_MAX) {
        return {
          status: 'damaged',
          recommendation: 'update',
          msg: r.msg,
          currentText: cur,
          fix,
          detail: `The text ran ${n - TEXT_PLAIN_MAX} character${n - TEXT_PLAIN_MAX === 1 ? '' : 's'} past its field into the author's name. The message number and author id are intact.`,
        };
      }
      return {
        status: same ? 'current' : 'outdated',
        recommendation: same ? 'keep' : 'update',
        msg: r.msg,
        currentText: cur,
        fix,
        detail: same ? 'Already the current text.' : 'An older translation of this post.',
      };
    }
    // The text ran over the fields behind it (or the ids make no sense).
    const a2Name = nameForId(index, r.addresseeId, playerName);
    const msg = findMsgByText(index, r.text, [a2Name ?? '', playerName]);
    if (msg === null) {
      return {
        status: 'unknown',
        recommendation: 'remove',
        msg: null,
        currentText: null,
        fix: null,
        detail:
          n > TEXT_PLAIN_MAX
            ? `The text ran ${n - TEXT_PLAIN_MAX} characters past its field and destroyed the ids behind it, and it matches no post the translation has ever shipped.`
            : 'The message number and author id do not point at any known post.',
      };
    }
    const a0 = n <= 79 && isValidNpcAuthorId(r.authorId) ? r.authorId : FIXED_AUTHOR[msg] ?? null;
    const a2 = n <= 80 ? r.addresseeId : 0;
    let { month, day, weekday } = r;
    if (n >= 82) {
      const same = goodDates.find(d => d.day === day && d.weekday === weekday);
      if (same) month = same.month;
      else if (goodDates.length) month = goodDates[0].month;
    }
    const cur = expandFor(msg, a2);
    const overrun = `The text ran ${n - TEXT_PLAIN_MAX} characters past its field and overwrote the author` +
      (n > 78 ? ', the message number' : '') + (n > 79 ? ', the author id' : '') + (n > 80 ? ', the addressee' : '') +
      (n >= 82 ? ' and the date' : '') + '. Recognised from its text as message ' + msg + '.';
    if (a0 !== null) {
      const inferred = INFERRED_AUTHOR.has(msg) && a0 === FIXED_AUTHOR[msg] && n > 79;
      return {
        status: 'damaged',
        recommendation: 'update',
        msg,
        currentText: cur,
        fix: { kind: 'unfilled', msg, a0, a2, month, day, weekday, authorInferred: inferred },
        detail: overrun + (n > 79 ? ` Author ${inferred ? 'inferred' : 'known'}: ${nameForId(index, a0, playerName) ?? a0}.` : ''),
      };
    }
    return {
      status: 'damaged',
      recommendation: 'update',
      msg,
      currentText: cur,
      fix: { kind: 'write', msg, a0: r.authorId, a2, month, day, weekday, text: cur },
      detail: overrun + ' The author cannot be recovered; updating writes the current text and leaves the author blank.',
    };
  });
}

// ---------------------------------------------------------------------------
// Building records
// ---------------------------------------------------------------------------

/** Encode a post text the way the patched game stores it: UTF-16 when it
 *  fits the plain field, 0xFFFF + UTF-8 otherwise. Throws when too long. */
export function packText(text: string): Uint8Array {
  const out = new Uint8Array(TEXT_FIELD);
  if (text.length <= TEXT_PLAIN_MAX) {
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      out[2 * i] = cp & 0xff;
      out[2 * i + 1] = (cp >> 8) & 0xff;
    }
    return out;
  }
  const utf8 = utf8Encoder.encode(text);
  if (utf8.length > TEXT_PACKED_MAX_BYTES) {
    throw new Error(`Post needs ${utf8.length} bytes of storage; the limit is ${TEXT_PACKED_MAX_BYTES}.`);
  }
  out[0] = 0xff;
  out[1] = 0xff;
  out.set(utf8, 2);
  return out;
}

/** Validation message for a user-typed post text, or null when it fits. */
export function validatePostText(text: string): string | null {
  if (text.length === 0) return 'Post text cannot be empty.';
  if (text.length <= TEXT_PLAIN_MAX) return null;
  const bytes = utf8Encoder.encode(text).length;
  if (bytes > TEXT_PACKED_MAX_BYTES) {
    return `Too long: ${bytes} bytes as UTF-8, the board stores at most ${TEXT_PACKED_MAX_BYTES} (about ${TEXT_PACKED_MAX_BYTES} plain characters).`;
  }
  return null;
}

export function emptyRecord(): Uint8Array {
  const r = new Uint8Array(BOARD_RECORD_SIZE);
  r[O_A0] = 0xff;
  r[O_A0 + 1] = 0xff;
  r[O_A2] = 0xff;
  r[O_A2 + 1] = 0xff;
  return r;
}

function putU16(r: Uint8Array, off: number, v: number) {
  r[off] = v & 0xff;
  r[off + 1] = (v >> 8) & 0xff;
}

function putIds(r: Uint8Array, msg: number, a0: number, a2: number, flag: number, month: number, day: number, weekday: number) {
  putU16(r, O_MSG, msg);
  putU16(r, O_A0, a0);
  putU16(r, O_A2, a2);
  r[O_FLAG] = flag & 0xff;
  r[O_MONTH] = month & 0xff;
  r[O_DAY] = day & 0xff;
  r[O_WD] = weekday & 0xff;
}

/** A record with ids and date only: the patched game fills in the current
 *  text and author the next time the board opens. */
export function unfilledRecord(fix: Extract<BoardFix, { kind: 'unfilled' }>): Uint8Array {
  const r = new Uint8Array(BOARD_RECORD_SIZE);
  putIds(r, fix.msg, fix.a0, fix.a2, 0, fix.month, fix.day, fix.weekday);
  return r;
}

/** A record with the current text written directly (author left blank). */
export function writtenRecord(fix: Extract<BoardFix, { kind: 'write' }>): Uint8Array {
  const r = new Uint8Array(BOARD_RECORD_SIZE);
  r.set(packText(fix.text), 0);
  putIds(r, fix.msg, fix.a0, fix.a2, 1, fix.month, fix.day, fix.weekday);
  return r;
}

/** The original record with its text replaced and marked filled. */
export function retextedRecord(original: BoardRecord, text: string): Uint8Array {
  const r = new Uint8Array(original.raw);
  r.set(packText(text), 0);
  r[O_FLAG] = 1;
  return r;
}

export type BoardAction = { kind: 'remove' } | { kind: 'update' } | { kind: 'text'; text: string };

/** Materialise the 14 board records after the staged actions: removed
 *  records drop out and the rest close up, as the game's own remove
 *  routine does; empty records pad the block. */
export function buildBoardRecords(
  records: BoardRecord[],
  assessments: BoardAssessment[],
  actions: Record<number, BoardAction>,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  records.forEach((rec, i) => {
    const action = actions[i];
    if (rec.empty) {
      if (!action) return;
    }
    if (!action) {
      out.push(new Uint8Array(rec.raw));
      return;
    }
    if (action.kind === 'remove') return;
    if (action.kind === 'text') {
      out.push(retextedRecord(rec, action.text));
      return;
    }
    const fix = assessments[i]?.fix;
    if (!fix) {
      out.push(new Uint8Array(rec.raw));
      return;
    }
    out.push(fix.kind === 'unfilled' ? unfilledRecord(fix) : writtenRecord(fix));
  });
  while (out.length < BOARD_COUNT) out.push(emptyRecord());
  return out.slice(0, BOARD_COUNT);
}

/** Human date for a record: month and day are stored 0-based. */
export function formatBoardDate(r: BoardRecord): string {
  if (r.month > 11 || r.day > 30) return '(date lost)';
  return `${r.month + 1}/${r.day + 1}`;
}
