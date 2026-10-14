// Client for the site's backend (Cloud Run service `media-api` in GCP
// project media-library-119506; source in api/ at the repo root).
//
// The browser holds no keys. Public endpoints do only what the site does —
// read the boards and add posts — and files are uploaded straight to Cloud
// Storage through short-lived signed URLs the API issues per file, pinned to
// one object name, content type and maximum size.

const DEFAULT_API_BASE = 'https://media-api-667670217544.us-central1.run.app';

export const API_BASE = ((import.meta.env.PUBLIC_API_BASE as string | undefined) || DEFAULT_API_BASE).replace(/\/+$/, '');

/** Kept for the components' "backend not configured" branches. */
export const apiConfigured = Boolean(API_BASE);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data as T;
}

export const apiGet = <T>(path: string) => request<T>('GET', path);
export const apiPost = <T>(path: string, body: unknown) => request<T>('POST', path, body);

export type UploadPurpose =
  | 'report-image'
  | 'comment-image'
  | 'guestbook-card'
  | 'report-attachment'
  | 'comment-attachment'
  | 'save-capture';

export interface UploadResult {
  /** Object path in the bucket; pass it to the endpoint that attaches it. */
  object: string;
  /** Public URL for images and guest-book cards; null for private files. */
  publicUrl: string | null;
}

/** Ask the API for a signed upload URL, then PUT the file to Cloud Storage. */
export async function uploadFile(purpose: UploadPurpose, file: Blob, filename = 'file.bin'): Promise<UploadResult> {
  const contentType = file.type || 'application/octet-stream';
  const ticket = await apiPost<{
    object: string;
    uploadUrl: string;
    headers: Record<string, string>;
    publicUrl: string | null;
  }>('/api/uploads', { purpose, size: file.size, contentType, filename });
  const put = await fetch(ticket.uploadUrl, { method: 'PUT', headers: ticket.headers, body: file });
  if (!put.ok) throw new ApiError(put.status, `Upload of ${filename} failed (${put.status}).`);
  return { object: ticket.object, publicUrl: ticket.publicUrl };
}

const SESSION_KEY = 'tongari-anon-session';

/** Anonymous per-browser id used to count one "me too" / heart per visitor. */
export function getOrCreateSession(): string {
  if (typeof window === 'undefined') return 'ssr';
  let s = window.localStorage.getItem(SESSION_KEY);
  if (!s) {
    s = crypto.randomUUID();
    window.localStorage.setItem(SESSION_KEY, s);
  }
  return s;
}
