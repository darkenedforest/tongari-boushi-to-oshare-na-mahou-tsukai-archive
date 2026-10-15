/* Builds the Luma3DS folder for the 3DS patch from the patched ROM, in the
 * browser (or in Node for testing). It does what the Windows package's .bat
 * does with 3dstool: reads the ROM (.3ds/.cci, decrypted), takes the patch's
 * files out of its RomFS, decompresses the code from its ExeFS, fixes the
 * exheader, and packs everything as luma/titles/<title id>/ in a zip.
 *
 * `info` is the release's "luma" entry in patches_3ds.json (file list with
 * CRC32 and size, exheader bytes to change, code.ips contents). Every file is
 * checked against it: a ROM that is not the patched one gives an error, not a
 * broken folder. No game data is hosted: it all comes from the visitor's ROM.
 */
(function (root) {
  'use strict';

  const MEDIA_UNIT = 0x200;

  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }
  function u64(b, o) {
    return u32(b, o) + u32(b, o + 4) * 0x100000000;
  }
  function magic(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  }

  // ── CRC32 (zip polynomial) ─────────────────────────────────────────
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ── ROM layout ─────────────────────────────────────────────────────
  // NCSD (cartridge image) -> partition 0 = the game's NCCH.
  function readNcch(rom) {
    if (magic(rom, 0x100) !== 'NCSD') throw new Error('This is not a 3DS ROM (.3ds / .cci).');
    const base = u32(rom, 0x120) * MEDIA_UNIT;
    if (magic(rom, base + 0x100) !== 'NCCH') throw new Error('The ROM has no game partition.');
    return {
      base: base,
      exheader: base + 0x200,
      exefs: base + u32(rom, base + 0x1a0) * MEDIA_UNIT,
      romfs: base + u32(rom, base + 0x1b0) * MEDIA_UNIT,
    };
  }

  // ExeFS: 10 entries of (name[8], offset, size), data after the 0x200 header.
  function exefsFile(rom, exefs, name) {
    for (let i = 0; i < 10; i++) {
      const e = exefs + i * 16;
      let n = '';
      for (let j = 0; j < 8 && rom[e + j]; j++) n += String.fromCharCode(rom[e + j]);
      if (n === name) {
        const off = exefs + 0x200 + u32(rom, e + 8);
        return rom.subarray(off, off + u32(rom, e + 12));
      }
    }
    throw new Error('ExeFS file not found: ' + name);
  }

  // The 3DS "backward LZ77" code compression (what 3dstool -u undoes).
  // The footer gives the compressed span and the extra size; the data is
  // decoded from the end towards the start, in place.
  function decompressCode(src) {
    const size = src.length;
    const topAndBottom = u32(src, size - 8);
    const top = topAndBottom & 0xffffff;
    const bottom = topAndBottom >>> 24;
    const out = new Uint8Array(size + u32(src, size - 4));
    out.set(src);
    let s = size - bottom;
    let d = out.length;
    const end = size - top;
    while (s > end) {
      const flags = out[--s];
      for (let i = 0; i < 8; i++) {
        if (((flags << i) & 0x80) === 0) {
          out[--d] = out[--s];
        } else {
          s -= 2;
          const v = out[s] | (out[s + 1] << 8);
          const disp = (v & 0x0fff) + 3;
          let n = ((v >>> 12) & 0x0f) + 3;
          if (d - n < end || disp > out.length - d) throw new Error('Bad compressed code.');
          while (n--) { d--; out[d] = out[d + disp]; }
        }
        if (s <= end) break;
      }
    }
    return out;
  }

  // RomFS: IVFC hash tree; level 3 holds the file system. Its start is the
  // header (0x60) plus the master hash, aligned to the level 3 block size.
  function romfsFiles(rom, romfs) {
    if (magic(rom, romfs) !== 'IVFC') throw new Error('RomFS not found in the ROM.');
    const masterHash = u32(rom, romfs + 0x08);
    const block = 1 << u32(rom, romfs + 0x4c);
    const l3 = romfs + Math.ceil((0x60 + masterHash) / block) * block;
    if (u32(rom, l3) !== 0x28) throw new Error('Unexpected RomFS layout.');
    const dirMeta = l3 + u32(rom, l3 + 0x0c);
    const fileMeta = l3 + u32(rom, l3 + 0x1c);
    const fileData = l3 + u32(rom, l3 + 0x24);
    const NONE = 0xffffffff;
    const files = new Map();
    function name(at, len) {
      let s = '';
      for (let i = 0; i < len; i += 2) s += String.fromCharCode(rom[at + i] | (rom[at + i + 1] << 8));
      return s;
    }
    function walkDir(off, path) {
      const d = dirMeta + off;
      for (let f = u32(rom, d + 0x0c); f !== NONE; ) {
        const e = fileMeta + f;
        const start = fileData + u64(rom, e + 0x08);
        files.set(path + name(e + 0x20, u32(rom, e + 0x1c)), rom.subarray(start, start + u64(rom, e + 0x10)));
        f = u32(rom, e + 0x04);
      }
      for (let c = u32(rom, d + 0x08); c !== NONE; ) {
        const e = dirMeta + c;
        walkDir(c, path + name(e + 0x18, u32(rom, e + 0x14)) + '/');
        c = u32(rom, e + 0x04);
      }
    }
    walkDir(0, '');
    return files;
  }

  // ── Zip (stored, no compression) ───────────────────────────────────
  // Returns an array of Uint8Array parts; the browser wraps them in a Blob
  // without copying the data into one big buffer.
  function zipParts(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.path);
      const h = new Uint8Array(30 + name.length);
      const v = new DataView(h.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 0x0800, true); // UTF-8 names
      v.setUint16(8, 0, true); // stored
      v.setUint32(14, e.crc, true);
      v.setUint32(18, e.data.length, true);
      v.setUint32(22, e.data.length, true);
      v.setUint16(26, name.length, true);
      h.set(name, 30);
      parts.push(h, e.data);
      const c = new Uint8Array(46 + name.length);
      const cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint32(16, e.crc, true);
      cv.setUint32(20, e.data.length, true);
      cv.setUint32(24, e.data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      c.set(name, 46);
      central.push(c);
      offset += h.length + e.data.length;
    }
    let size = 0;
    for (const c of central) size += c.length;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, size, true);
    ev.setUint32(16, offset, true);
    return parts.concat(central, [end]);
  }

  // ── Main ───────────────────────────────────────────────────────────
  function build(rom, info) {
    const n = readNcch(rom);
    const romfs = romfsFiles(rom, n.romfs);
    const prefix = 'luma/titles/' + info.titleId + '/';
    const entries = [];
    for (const [path, crc, size] of info.files) {
      let data;
      if (path === 'code.bin') {
        data = decompressCode(exefsFile(rom, n.exefs, '.code'));
      } else if (path === 'exheader.bin') {
        data = rom.slice(n.exheader, n.exheader + 0x800);
        for (const [off, val] of info.exheaderPatch) data[off] = val;
      } else if (path === 'code.ips') {
        data = new TextEncoder().encode(info.codeIps);
      } else {
        data = romfs.get(path.replace(/^romfs\//, ''));
        if (!data) throw new Error('This ROM is missing ' + path + '. Is it the patched ROM of this version?');
      }
      const c = crc32(data);
      if (data.length !== size || c !== crc)
        throw new Error('A file does not match (' + path + '). Use the Japanese ROM this version expects.');
      entries.push({ path: prefix + path, data: data, crc: c });
    }
    return zipParts(entries);
  }

  const api = { build: build, crc32: crc32, decompressCode: decompressCode, romfsFiles: romfsFiles, readNcch: readNcch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TongariLuma = api;
})(typeof self !== 'undefined' ? self : this);
