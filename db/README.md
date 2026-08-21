# Database setup — PLANNED, NOT ACTIVE

> **Status: not in use.** The dashboard currently reads the committed
> `releases.json` and that is the live setup. Everything here is a designed-but-
> unexecuted migration, kept because the design work is done and the reasoning is
> worth preserving. Nothing in this folder affects the running dashboard.

The dashboard reads a static `releases.json` committed to this repo. That works,
but a static file can only be written by something holding a repo token — which
means the browser can never write. That blocks the QA worklist ("tested / not
tested" per release), which is the main reason a database would be worth it.

Target: **Supabase** (hosted Postgres + auto-generated REST API). The dashboard
would stay a static page on GitHub Pages; only the data source changes. The schema
is plain Postgres, so moving to `xneeti-postgres` later is a `pg_dump`/restore
rather than a rewrite.

## Files here

| File | What it is |
| --- | --- |
| `schema.sql` | Tables, indexes, the `release_feed` view, RLS policies. |
| `gen_seed.py` | Generates `seed.sql` from `releases.json`. |
| `seed.sql` | **Not committed** — generated, ~43KB. Run the generator to produce it. |

`seed.sql` is derived data, so it is not tracked. To produce it, from the repo
root:

```bash
python3 db/gen_seed.py
```

That writes `db/seed.sql` with all releases plus keyword-derived area tags.

## If you pick this up

1. Create a Supabase project (free tier is fine). Note the **project URL**, the
   **anon/publishable key**, and the **service_role key**.
2. In the SQL editor, run `schema.sql`.
3. Generate and run `seed.sql`. Both files are idempotent, so re-running is safe.
4. Sanity check:
   ```sql
   select count(*) from releases;                       -- 63
   select pipeline, count(*) from releases group by 1;   -- frontend 26 / ecs 30 / ec2 7
   select area, count(*) from release_areas group by 1 order by 2 desc;
   select * from release_feed limit 3;
   ```
5. Point the dashboard at the DB: set `SUPABASE.url` and `SUPABASE.anonKey` in
   the `const SUPABASE = { … }` block near the top of `index.html`'s script.
   Leaving them blank keeps reading `releases.json`, so this is the cutover
   switch.
6. Rewrite the routine's steps 2 and 7 to POST a row instead of the base64
   fetch-modify-commit sequence. See `automation/routine-instructions.md`.

## Cutover behaviour (already built)

`loadReleases()` in `index.html` already supports both sources. It tries the DB
first when configured and falls back to `releases.json` if the DB is unreachable.
The fallback logs a console warning, so a silent switch is still traceable.

This matters because **free-tier Supabase projects pause when idle** (roughly a
week). Without the fallback the dashboard would simply go blank; with it, the
page keeps serving the committed mirror.

The fallback and failure paths were tested. The Supabase path itself has never
run — there is no project.

Keep the routine writing `releases.json` alongside the DB for a week or two. It
costs nothing and it is the rollback path.

## Which key goes where

| Key | Used by | Notes |
| --- | --- | --- |
| `service_role` | the scheduled routine | Bypasses RLS. Secret — never in the HTML. |
| `anon` | the dashboard page | Public by design; embedded in `index.html`. RLS is what constrains it. |

The routine's instructions would hold the `service_role` key in plaintext, the
same situation as the GitHub PATs it replaces. It is a net improvement — the key
is scoped to one Supabase project and these four tables, rather than write access
to a whole GitHub account — but it does not make the problem disappear.

## The write-access tradeoff (read before enabling QA writes)

`schema.sql` grants anon **read** on everything and **no writes at all**. New
releases would still land fine because the routine uses `service_role`.

To let people set QA state from the dashboard, you uncomment the
`qa_status_write` policy at the bottom of `schema.sql`. Be clear about what that
means: the dashboard is a public GitHub Pages URL, so the anon key is visible in
page source, and **anyone who can load the page can change QA state**. There is
no per-user identity.

Three ways to handle it:

- **Accept it.** Obscure URL, low stakes, an audit trail via `updated_by` that
  people fill in honestly. Fastest, fine for a demo.
- **Add Supabase Auth** (email/magic-link, restricted to `@xneeti.com`) and gate
  the policy on `auth.role() = 'authenticated'`. Real identity, ~an afternoon of
  work, and the dashboard stops being anonymously viewable.
- **Keep writes routine-only** and defer the QA worklist. The migration still
  pays off (cheaper writes, no CDN lag, queryable), just without the new feature.

Decision on record: **routine-only writes.** The QA tables exist in the schema and
are read by the view, but no policy sets them.

## Known gaps in the seed data

- **Tickets are nearly empty (1 row).** The release summaries deliberately avoid
  ticket IDs for readability, so there is almost nothing to extract from prose.
  Ticket links should come from the routine reading commit messages going
  forward, plus a one-off backfill pass over git history.
- **Areas are keyword-derived**, marked `source='auto'`. They are a starting
  point, not curated truth. Three releases matched nothing at all
  (`fe-v1.5.12`, `fe-v1.5.6`, `fe-v1.5.3`) because their commit messages were
  too terse to classify.
- **Entries before 2026-08-12** carry content from the original prototype and
  were never re-verified against real commits. `fe-v1.5.2` says so in its own
  highlights.
