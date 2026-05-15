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

In **Project Settings → API**:

- **Project URL** — looks like `https://abcdefg.supabase.co`
- **anon / public** key — long string starting with `eyJ...`

(The anon key is safe to ship in the client — it can only do what the
RLS policies allow.)

## 5. Add the keys to GitHub Actions secrets

The site builds via GitHub Actions. In the archive repo on GitHub:

**Settings → Secrets and variables → Actions → New repository secret**

Add these two:

- `PUBLIC_SUPABASE_URL` = your project URL from step 4
- `PUBLIC_SUPABASE_ANON_KEY` = your anon key from step 4

If the GitHub Action that builds the site doesn't currently pass these
through, edit `.github/workflows/deploy.yml` to include them under the
build step's `env:` block.

## 6. Local dev

Create `.env` in the repo root (already gitignored):

```
PUBLIC_SUPABASE_URL=https://your-project.supabase.co
PUBLIC_SUPABASE_ANON_KEY=eyJ...your-anon-key...
```

Then `npm run dev` and visit `/bug-reports/` — you can post and see
it live.

## Moderation

You're the admin. From the Supabase dashboard → Table Editor:

- Mark something as resolved: edit the row, set `status = 'resolved'`.
- Hide spam: just delete the row.
- Flag for visibility: `status = 'flagged'`.
- Closed (won't fix / duplicate): `status = 'closed'`.

The site reflects status changes on next page load.

## Cost

Free tier limits are generous for a fan-site bug board:
- 500 MB database — easily fits tens of thousands of reports/comments
- 1 GB storage — ~200 screenshots at 5 MB each
- 5 GB bandwidth/month
- Pauses after 7 days of zero activity (revives on next request, no
  data loss)

If the site ever hits the limits, you'll get a dashboard warning before
anything breaks.
