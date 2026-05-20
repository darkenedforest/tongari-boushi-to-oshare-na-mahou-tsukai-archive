// Web Worker that runs the NDS ROM extractor off the main UI thread.
// Imported by the TranslationViewer React component via:
//
//     new Worker(new URL('../lib/rom/rom-worker.ts', import.meta.url), { type: 'module' })
//
// Vite/Astro handle bundling this as a module worker. The worker receives
// a `parse` message containing the ROM ArrayBuffer (transferred, not copied)
// plus the expected_paths list, and posts back either `progress`, `done`,
// or `error` messages.

import { extractRomFiles } from './parser';
import type { WorkerInbound, WorkerOutbound } from './types';

// `self` is the DedicatedWorkerGlobalScope inside a Worker context.
const ctx: DedicatedWorkerGlobalScope = self as any;

ctx.addEventListener('message', (event: MessageEvent<WorkerInbound>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'parse') return;

  try {
    const post = (m: WorkerOutbound) => ctx.postMessage(m);
    post({
      type: 'progress',
      progress: { phase: 'reading', message: 'Reading ROM bytes…' },
    });
    const rom = new Uint8Array(msg.buffer);
    post({
      type: 'progress',
      progress: { phase: 'header', message: 'Reading NDS header…' },
    });
    // Extract — the parser posts progress updates as it walks each file.
    let lastDone = -1;
    const result = extractRomFiles(rom, {
      expected_paths: msg.expected_paths,
      onProgress: (done, total) => {
        // Throttle to at most one progress message per percentage point so we
        // don't flood the message channel — at step-326 the full-ROM scope
        // is ~1,300 files so a per-file post would be excessive.
        const pct = Math.floor((done / Math.max(total, 1)) * 100);
        if (pct === lastDone) return;
        lastDone = pct;
        post({
          type: 'progress',
          progress: { phase: 'extract', files_done: done, files_total: total },
        });
      },
    });
    post({
      type: 'progress',
      progress: { phase: 'done', files_done: result.files.length },
    });
    // Serialize Maps as arrays for the postMessage clone boundary.
    post({
      type: 'done',
      header: result.header,
      files: result.files.map((f) => ({
        file_path: f.file_path,
        file_id: f.file_id,
        reso_entry_count: f.reso_entry_count,
        textblocks: Array.from(f.textblocks.entries()),
      })),
    });
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      message: (err as Error)?.message ?? String(err),
    } as WorkerOutbound);
  }
});

export {};
