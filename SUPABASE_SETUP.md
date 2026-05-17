# Bug Reports backend setup (one-time)

The bug reports page uses Supabase (free tier) for anonymous posting,
image upload, "Me too" reactions, and comments. **No user accounts — no
GitHub login required.** Visitors just type and post.

Setup takes ~5 minutes.

## 1. Create a Supabase project

1. Go to <https://supabase.com> and sign up (Google/GitHub/email is fine).
2. Click "New project". Pick any name (e.g. `tongari-bug-reports`),
   pick the closest region, generate a strong DB password (save it).
3. Wait ~2 minutes for the project to provision.

## 2. Run the schema SQL

In the Supabase dashboard, open **SQL Editor → New query**. Paste this
and click "Run":

```sql
-- Tables ---------------------------------------------------------
create table reports (
  id bigint primary key generated always as identity,
  title text not null,
  body text not null,
  author text,
  status text not null default 'open' check (status in ('open','flagged','resolved','closed')),
  metoo_count int not null default 0,
  created_at timestamptz not null default now()
);

create table comments (
  id bigint primary key generated always as identity,
  report_id bigint not null references reports(id) on delete cascade,
  body text not null,
  author text,
  created_at timestamptz not null default now()
);

create table report_images (
  id bigint primary key generated always as identity,
  report_id bigint not null references reports(id) on delete cascade,
  url text not null,
  created_at timestamptz not null default now()
);

create table report_metoos (
  id bigint primary key generated always as identity,
  report_id bigint not null references reports(id) on delete cascade,
  session_id text not null,
  created_at timestamptz not null default now(),
  unique (report_id, session_id)
);

-- Trigger: keep metoo_count denormalized for sort speed --------
create or replace function bump_metoo_count() returns trigger
language plpgsql security definer as $$
begin
  if (tg_op = 'INSERT') then
    update reports set metoo_count = metoo_count + 1 where id = new.report_id;
  elsif (tg_op = 'DELETE') then
    update reports set metoo_count = greatest(0, metoo_count - 1) where id = old.report_id;
  end if;
  return null;
end $$;

drop trigger if exists trg_metoo_count on report_metoos;
create trigger trg_metoo_count
after insert or delete on report_metoos
for each row execute function bump_metoo_count();

-- Row-Level Security ----------------------------------------
alter table reports         enable row level security;
alter table comments        enable row level security;
alter table report_images   enable row level security;
alter table report_metoos   enable row level security;

-- Anyone can read everything (board is public).
create policy read_all_reports        on reports         for select using (true);
create policy read_all_comments       on comments        for select using (true);
create policy read_all_report_images  on report_images   for select using (true);
create policy read_all_report_metoos  on report_metoos   for select using (true);

-- Anyone can insert reports, comments, images, me-toos (no auth).
-- Updates / deletes only through the service role (Supabase dashboard).
create policy insert_reports        on reports         for insert with check (true);
create policy insert_comments       on comments        for insert with check (true);
create policy insert_report_images  on report_images   for insert with check (true);
create policy insert_report_metoos  on report_metoos   for insert with check (true);
```

## 3. Create the image storage bucket

1. In the dashboard, go to **Storage → New bucket**.
2. Name it exactly `bug-report-images`.
3. Toggle **Public bucket** ON.
4. Click "Create bucket".

Then open the new bucket → "Configuration" → "Policies" and add two
policies (or run via SQL):

```sql
create policy allow_public_read on storage.objects
  for select using (bucket_id = 'bug-report-images');

create policy allow_public_upload on storage.objects
  for insert with check (bucket_id = 'bug-report-images');
```

## 4. Grab the two keys

Supabase recently reorganized this page, so the URL and the key live in
different sub-pages now:

**Project URL** — IMPORTANT: this is the **base URL only**, NOT the
REST endpoint URL Supabase shows on the Data API page. The form you
want is:

```
https://<project-ref>.supabase.co
```

**No trailing slash. No `/rest/v1/` suffix.** The Supabase JS client
appends `/rest/v1/...` itself when making queries — if you include it
in the env var, the client builds malformed URLs like
`…/rest/v1/rest/v1/reports` and every fetch fails with "Invalid path
specified in request URL".

Where to find it:

- The easiest path: in your browser's address bar while you're inside
  the Supabase project dashboard, the URL is
  `https://supabase.com/dashboard/project/<project-ref>/...`. Copy the
  `<project-ref>` portion and build the URL yourself as
  `https://<project-ref>.supabase.co`.
- If you go to **Project Settings → Data API**, you'll see an "API URL"
  field that ends in `/rest/v1/`. **Do NOT paste that into the secret.**
  Strip the `/rest/v1/` so only `https://<project-ref>.supabase.co`
  remains.

**Public key** — open **Project Settings → API Keys**. You have two
tabs:

- "Publishable and secret API keys" (new format) — the value starts
  with `sb_publishable_...`. This is the safe browser key.
- "Legacy anon, service_role API keys" (old format) — the `anon /
  public` value starts with `eyJ...`. Also a safe browser key.

Either format works in the `PUBLIC_SUPABASE_ANON_KEY` env var. The
`@supabase/supabase-js` client accepts both. New projects should prefer
the `sb_publishable_*` form.

**Do not** use the `service_role` / secret key in the client — that one
has admin rights and bypasses RLS.

## 5. Add the keys to GitHub Actions secrets

The site builds via GitHub Actions. The repo to edit is the **archive
repo** (the one this README lives in, the one the site is built from —
NOT the translation repo).

**Direct link:**
<https://github.com/darkenedforest/tongari-boushi-to-oshare-na-mahou-tsukai-archive/settings/secrets/actions>

That takes you to the Actions secrets page. Click "New repository
secret" and add these two:

- Name: `PUBLIC_SUPABASE_URL`
  Value: the Project URL from step 4 (the `https://<project-ref>.supabase.co` string)
- Name: `PUBLIC_SUPABASE_ANON_KEY`
  Value: the anon / publishable key from step 4

If you can't reach that direct link, navigate manually:
1. Go to <https://github.com/darkenedforest/tongari-boushi-to-oshare-na-mahou-tsukai-archive>
2. Click **Settings** (top right of the repo, gear icon)
3. In the left sidebar: **Secrets and variables → Actions**
4. Click **New repository secret** (green button)

The Astro build reads these as `import.meta.env.PUBLIC_SUPABASE_URL` and
`PUBLIC_SUPABASE_ANON_KEY`. The existing `.github/workflows/deploy.yml`
already forwards env vars at build time, so once the secrets are set
the next push will pick them up automatically.

## 6. (Optional) Local dev — skip this if you just want the live site

If you only want the bug reports working on the deployed site, **stop
here**. Steps 1-5 are enough. After step 5, the next git push to the
archive repo (or a manual workflow re-run from
<https://github.com/darkenedforest/tongari-boushi-to-oshare-na-mahou-tsukai-archive/actions>)
will rebuild the site with the env vars wired in, and the bug-report
form will start working at
<https://darkenedforest.github.io/tongari-boushi-to-oshare-na-mahou-tsukai-archive/bug-reports/>.

Section 6 is only needed if you want to test the form on your computer
before letting visitors hit it on the live site. To do that:

1. Open a terminal (PowerShell on Windows is fine) inside the archive
   repo folder:
   ```powershell
   cd C:\Users\Tyler\Documents\Repos\tongari-boushi-archive
   ```

2. Make a file named exactly `.env` in that folder (the leading dot is
   required — Windows Explorer will let you create it; right-click →
   New → Text Document, then rename to `.env` deleting the `.txt`). It
   has to live in the repo root, i.e. next to `package.json` and
   `astro.config.mjs`. Open `.env` in a text editor and paste:

   ```
   PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
   PUBLIC_SUPABASE_ANON_KEY=eyJ...YOUR-ANON-KEY...
   ```

   Replace the URL and key with the actual values you got in step 4.
   The `.env` file is already in `.gitignore`, so it won't get
   accidentally committed.

3. Run the dev server:
   ```powershell
   npm run dev
   ```
   That starts a local preview at <http://localhost:4321/> (Astro's
   default). The terminal will print the exact URL.

4. Open <http://localhost:4321/tongari-boushi-to-oshare-na-mahou-tsukai-archive/bug-reports/>
   in a browser. You should see the "Post a bug report" button
   instead of the "backend not configured" message. Posting should
   work — anything you post will go straight to your live Supabase
   project, so use a throwaway title like "test" so you can delete it
   from the Supabase dashboard afterward.

5. When done, hit `Ctrl+C` in the terminal to stop the dev server.

## Moderation

You're the admin. From the Supabase dashboard → Table Editor:

- Mark something as resolved: edit the row, set `status = 'resolved'`.
- Hide spam: just delete the row.
- Flag for visibility: `status = 'flagged'`.
- Closed (won't fix / duplicate): `status = 'closed'`.

The site reflects status changes on next page load.

## Edit suggestions table

The `/translation/` page lets visitors propose edits to any EN line in
the fan patch. Submissions land in a separate Supabase table called
`edit_suggestions` and are reviewed offline (`src/translator/_review_edit_suggestions.py`
in the translation repo).

In the Supabase dashboard, open **SQL Editor → New query**, paste this,
and click "Run":

```sql
create table edit_suggestions (
  id bigint primary key generated always as identity,
  kind text not null check (kind in ('dialog','item','npc')),
  ref text not null,                     -- e.g., "entries:511:1:0" or "item:567"
  original_en text not null,             -- snapshot of the EN string at submission time
  proposed_en text not null,
  reason text,
  submitter text,
  status text not null default 'pending'
    check (status in ('pending','accepted','rejected','duplicate','needs_info')),
  created_at timestamptz not null default now()
);

-- Row-Level Security
alter table edit_suggestions enable row level security;

-- Anyone can read submissions (the page itself doesn't display them, but
-- the triage script reads via the anon key, and a future "recent
-- suggestions" sidebar might need it).
create policy read_all_edit_suggestions on edit_suggestions
  for select using (true);

-- Anyone can insert a suggestion — no auth required.
create policy insert_edit_suggestions on edit_suggestions
  for insert with check (true);

-- Updates / deletes happen only through the service role (Supabase
-- dashboard or admin scripts). No public update / delete policy.
```

That's it for the translation suggestions backend. The existing
`PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` cover this table
too — no extra secrets needed.

### Snapshot refresh workflow

The browse-able list itself comes from a static JSON bundle generated
from the SQLite translation DB. When the DB changes and the public
listing should update, in the **translation repo** run:

```powershell
cd C:\Users\Tyler\Documents\Repos\Tongari boushi translation app claude
python src\translator\_export_translation_snapshot.py
```

That overwrites `src/data/translation_snapshot.json` in this archive
repo. Commit that JSON and push — GitHub Actions rebuilds the site and
the page updates.

### Triage submitted suggestions

From the **translation repo**:

```powershell
$env:PUBLIC_SUPABASE_URL  = "https://YOUR-REF.supabase.co"
$env:PUBLIC_SUPABASE_ANON_KEY = "eyJ..."
python src\translator\_review_edit_suggestions.py
```

Writes a Markdown report to `notes/edit_suggestions_triage_<date>.md`
with one section per pending suggestion, including the original JP,
current EN, proposed EN, char budget, overflow flag, and a blank
"Verdict:" line. Mark verdicts in the Supabase dashboard (Table Editor
→ `edit_suggestions` → change `status`).

## Save-files submission table + private bucket

The `/save-files/` page lets visitors upload their NDS save file with a
small amount of metadata so Tyler can use real-world saves for debugging
the patch. Unlike bug-reports, **the bucket is private** — only the
service-role key (Tyler's admin CLI) can read uploaded files. The page
visitor never sees anyone else's submissions either.

In the Supabase dashboard, open **SQL Editor → New query**, paste this,
and click "Run":

```sql
-- Table -----------------------------------------------------------
create table save_files (
  id bigint primary key generated always as identity,
  filename text not null,
  file_path text not null,        -- path inside the 'save-files' bucket
  file_size_bytes int not null,
  save_source text not null,      -- e.g. "melonDS", "TWiLight Menu++ + nds-bootstrap (Luma3DS CFW)", "Other: my custom setup"
  patch_version text,             -- "v2.31" / "Unsure" / null
  debug_reason text,              -- user's explanation, nullable
  submitter text,                 -- handle / null
  status text not null default 'pending'
    check (status in ('pending','reviewed','useful','duplicate','archived')),
  created_at timestamptz not null default now()
);

-- If you already created save_files with an earlier schema that had a
-- game_progress column, drop it (the form no longer sends that field):
alter table save_files drop column if exists game_progress;

-- Per-row in-game values the save-format research agent uses to localize
-- offsets for Ritch (currency) and Wizard Level. Both nullable - the form
-- treats them as optional. ritch_amount is bigint because the in-game cap
-- is unconfirmed and Ritch can theoretically run high; wizard_level is a
-- plain int.
alter table save_files add column if not exists ritch_amount bigint;
alter table save_files add column if not exists wizard_level integer;

-- Row-Level Security ---------------------------------------------
alter table save_files enable row level security;

-- Anyone can insert (anonymous form submission).
create policy insert_save_files on save_files
  for insert with check (true);

-- Nobody can read via the anon key — visitors don't see each other's
-- submissions, and Tyler's CLI uses the service-role key which bypasses
-- RLS. (Updates / deletes also only via service role — no policy needed.)
create policy read_save_files_blocked on save_files
  for select using (false);
```

## Save-files storage bucket

1. In the dashboard, go to **Storage → New bucket**.
2. Name it exactly `save-files`.
3. **Leave "Public bucket" OFF.** These files contain user game data.
4. Click "Create bucket".

Then add storage policies. Open **SQL Editor → New query** and run:

```sql
-- Anyone (including anon) can upload INTO the save-files bucket.
create policy save_files_insert on storage.objects
  for insert with check (bucket_id = 'save-files');

-- Nobody can read via anon. service_role bypasses RLS so Tyler's admin
-- CLI still downloads fine.
create policy save_files_owner_read on storage.objects
  for select using (false);
```

That's it. The save-files submission form on `/save-files/` will now
write metadata into `save_files` and upload the actual save into the
`save-files` bucket under `<YYYY>/<MM>/<uuid>/<original-filename>`.

To manage submissions: see `src/translator/_admin_save_files.py` in the
translation repo (`list`, `download`, `set-status`, `delete`
subcommands).

## Cost

Free tier limits are generous for a fan-site bug board:
- 500 MB database — easily fits tens of thousands of reports/comments
- 1 GB storage — ~200 screenshots at 5 MB each
- 5 GB bandwidth/month
- Pauses after 7 days of zero activity (revives on next request, no
  data loss)

If the site ever hits the limits, you'll get a dashboard warning before
anything breaks.
