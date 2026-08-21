-- Xneeti Release Management — Supabase / Postgres schema
-- Run this once in the Supabase SQL editor before seed.sql.
--
-- Designed to be portable: this is plain Postgres, so moving to xneeti-postgres
-- later is a pg_dump/restore, not a rewrite. Nothing here is Supabase-specific
-- except the RLS policies at the bottom.

-- ---------------------------------------------------------------- core

create table if not exists releases (
  id            text primary key,              -- e.g. fe-v1.5.18, be-v1.1.45-ec2
  component     text not null check (component in ('frontend','backend')),
  pipeline      text not null check (pipeline in ('frontend','ecs','ec2')),
  version       text not null,
  deployed_at   timestamptz not null,
  deployed_by   text not null,
  commit_sha    text,
  git_ref       text default 'master',
  ref_inferred  boolean not null default false,
  run_url       text,
  risk_tag      text check (risk_tag in ('breaking','hotfix','bugfix','feature','chore')),
  status        text not null default 'success' check (status in ('success','failed')),
  overview      text not null,
  highlights    text[] not null default '{}',  -- always rendered together, so no join
  created_at    timestamptz not null default now()
);

-- version alone is NOT unique: the EC2 and ECS pipelines both ship a "v1.1.45"
-- meaning different code. (version, pipeline) is the real business key.
create unique index if not exists releases_version_pipeline_uniq
  on releases (version, pipeline);

create index if not exists releases_deployed_at_idx on releases (deployed_at desc);
create index if not exists releases_component_idx   on releases (component);
create index if not exists releases_risk_tag_idx    on releases (risk_tag);

-- ---------------------------------------------------------------- QA worklist

create table if not exists qa_status (
  release_id  text primary key references releases(id) on delete cascade,
  state       text not null default 'untested'
              check (state in ('untested','testing','verified','issue_found')),
  note        text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

create or replace function touch_qa_status() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists qa_status_touch on qa_status;
create trigger qa_status_touch before update on qa_status
  for each row execute function touch_qa_status();

-- ---------------------------------------------------------------- enrichment

create table if not exists release_tickets (
  release_id text not null references releases(id) on delete cascade,
  ticket_key text not null,                    -- e.g. XNEETI-3037
  primary key (release_id, ticket_key)
);

create table if not exists release_areas (
  release_id text not null references releases(id) on delete cascade,
  area       text not null,                    -- content-studio, growth-reporting, …
  source     text not null default 'auto'      -- 'auto' = keyword-derived, 'manual' = curated
             check (source in ('auto','manual')),
  primary key (release_id, area)
);

create index if not exists release_areas_area_idx on release_areas (area);

-- ---------------------------------------------------------------- read model

-- Single endpoint for the dashboard: one row per release with QA state,
-- tickets and areas folded in. Keeps the frontend fetch to one call.
create or replace view release_feed as
select
  r.id,
  r.component,
  r.pipeline,
  r.version,
  r.deployed_at,
  r.deployed_by,
  r.commit_sha,
  r.git_ref,
  r.ref_inferred,
  r.run_url,
  r.risk_tag,
  r.status,
  r.overview,
  r.highlights,
  coalesce(q.state, 'untested') as qa_state,
  q.note                       as qa_note,
  q.updated_by                 as qa_updated_by,
  q.updated_at                 as qa_updated_at,
  coalesce(t.tickets, '{}')    as tickets,
  coalesce(a.areas,   '{}')    as areas
from releases r
left join qa_status q on q.release_id = r.id
left join (
  select release_id, array_agg(ticket_key order by ticket_key) as tickets
  from release_tickets group by release_id
) t on t.release_id = r.id
left join (
  select release_id, array_agg(area order by area) as areas
  from release_areas group by release_id
) a on a.release_id = r.id
order by r.deployed_at desc;

-- ---------------------------------------------------------------- RLS
--
-- IMPORTANT: the dashboard is a public static page, so its anon key is public
-- too. These policies are what stand between "anyone with the URL can read"
-- and "anyone with the URL can edit". Read is open; writes are NOT granted to
-- anon here on purpose.
--
-- The scheduled routine writes with the service_role key, which bypasses RLS
-- entirely — so inserting releases keeps working without an anon write policy.
--
-- If you decide to let people set QA state from the browser, uncomment the
-- final policy. Understand what it means: anyone who can load the page can
-- change QA state. See the note in db/README.md.

alter table releases        enable row level security;
alter table qa_status       enable row level security;
alter table release_tickets enable row level security;
alter table release_areas   enable row level security;

drop policy if exists releases_read        on releases;
drop policy if exists qa_status_read       on qa_status;
drop policy if exists release_tickets_read on release_tickets;
drop policy if exists release_areas_read   on release_areas;

create policy releases_read        on releases        for select using (true);
create policy qa_status_read       on qa_status       for select using (true);
create policy release_tickets_read on release_tickets for select using (true);
create policy release_areas_read   on release_areas   for select using (true);

-- Browser-writable QA state — OFF by default. Uncomment only after reading
-- the tradeoff in db/README.md.
-- create policy qa_status_write on qa_status for all using (true) with check (true);
