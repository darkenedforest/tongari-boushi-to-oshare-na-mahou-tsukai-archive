import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
const ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(URL && ANON_KEY);

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(URL!, ANON_KEY!)
  : null;

export const BUG_BUCKET = 'bug-report-images';

const SESSION_KEY = 'tongari-anon-session';

export function getOrCreateSession(): string {
  if (typeof window === 'undefined') return 'ssr';
  let s = window.localStorage.getItem(SESSION_KEY);
  if (!s) {
    s = crypto.randomUUID();
    window.localStorage.setItem(SESSION_KEY, s);
  }
  return s;
}
