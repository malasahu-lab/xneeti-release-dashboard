#!/usr/bin/env python3
"""Generate db/seed.sql from the current releases.json."""
import json, re

SRC = "data/releases.json"
OUT = "db/seed.sql"

# Keyword -> area. Deliberately conservative: a miss is better than a wrong tag,
# and every row lands with source='auto' so curation can override it later.
AREA_RULES = [
    ("content-studio",    [r"content studio"]),
    ("image-studio",      [r"image studio", r"creative studio"]),
    ("growth-reporting",  [r"growth report", r"competition scorecard", r"campaign master",
                           r"cohort", r"search term", r"search-term", r"competitor"]),
    # NOTE: bare "keyword" is deliberately excluded — Content Studio uses that word
    # heavily for copy keywords, which are not advertising keywords.
    ("advertising",        [r"campaign", r"placement", r"\bbid\b", r"bid-", r"sponsored",
                           r"opportunity center", r"negative[- ]keyword", r"\bacos\b",
                           r"ad group", r"ad type", r"ad product", r"spend"]),
    ("billing",            [r"billing", r"lock-in", r"invoic", r"plan pdf"]),
    ("rbac",               [r"\brbac\b", r"\brole\b", r"roles", r"invite", r"analyst"]),
    ("notifications",      [r"notification"]),
    ("platform-ops",       [r"memory", r"heap", r"new relic", r"cloudwatch", r"scheduler",
                           r"logging", r"log\b", r"restart"]),
    ("helix",              [r"helix", r"project manager card"]),
]

def q(s):
    """Quote a SQL string literal."""
    if s is None:
        return "null"
    return "'" + s.replace("'", "''") + "'"

def arr(items):
    """Postgres text[] literal."""
    if not items:
        return "'{}'"
    return "array[" + ",".join(q(i) for i in items) + "]"

def pipeline_of(r):
    if r["component"] == "frontend":
        return "frontend"
    return "ec2" if "EC2" in r.get("component_label", "") else "ecs"

def areas_of(r):
    blob = (r["overview"] + " " + " ".join(r["highlights"])).lower()
    found = []
    for area, pats in AREA_RULES:
        if any(re.search(p, blob) for p in pats):
            found.append(area)
    return found

def tickets_of(r):
    blob = r["overview"] + " " + " ".join(r["highlights"])
    return sorted(set(m.upper() for m in re.findall(r"XNEETI-\d+", blob, re.I)))

releases = json.load(open(SRC))["releases"]

lines = [
    "-- Seed data generated from releases.json (the file the dashboard used before the DB).",
    "-- Idempotent: re-running updates existing rows rather than erroring.",
    "-- Areas are keyword-derived (source='auto') and worth a curation pass.",
    "",
    "begin;",
    "",
]

lines.append("insert into releases (id, component, pipeline, version, deployed_at, deployed_by,")
lines.append("                      commit_sha, git_ref, ref_inferred, run_url, risk_tag, status,")
lines.append("                      overview, highlights) values")
rows = []
for r in releases:
    rows.append(
        f"({q(r['id'])},{q(r['component'])},{q(pipeline_of(r))},{q(r['version'])},"
        f"{q(r['deployed_at'])},{q(r['deployed_by'])},{q(r.get('commit'))},"
        f"{q(r.get('ref') or 'master')},{str(bool(r.get('ref_inferred'))).lower()},"
        f"{q(r.get('run_url'))},{q(r.get('risk_tag'))},{q(r.get('status') or 'success')},"
        f"{q(r['overview'])},{arr(r['highlights'])})"
    )
lines.append(",\n".join(rows))
lines.append("on conflict (id) do update set")
lines.append("  component = excluded.component, pipeline = excluded.pipeline,")
lines.append("  version = excluded.version, deployed_at = excluded.deployed_at,")
lines.append("  deployed_by = excluded.deployed_by, commit_sha = excluded.commit_sha,")
lines.append("  git_ref = excluded.git_ref, ref_inferred = excluded.ref_inferred,")
lines.append("  run_url = excluded.run_url, risk_tag = excluded.risk_tag,")
lines.append("  status = excluded.status, overview = excluded.overview,")
lines.append("  highlights = excluded.highlights;")
lines.append("")

tk = [(r["id"], t) for r in releases for t in tickets_of(r)]
ar = [(r["id"], a) for r in releases for a in areas_of(r)]
n_tickets, n_areas = len(tk), len(ar)

if tk:
    lines.append("insert into release_tickets (release_id, ticket_key) values")
    lines.append(",\n".join(f"({q(i)},{q(t)})" for i, t in tk))
    lines.append("on conflict do nothing;")
    lines.append("")

if ar:
    lines.append("insert into release_areas (release_id, area, source) values")
    lines.append(",\n".join(f"({q(i)},{q(a)},'auto')" for i, a in ar))
    lines.append("on conflict do nothing;")
    lines.append("")

lines += ["", "commit;", ""]

open(OUT, "w").write("\n".join(lines))
print(f"wrote {OUT}")
print(f"  releases: {len(releases)}")
print(f"  ticket rows: {n_tickets}")
print(f"  area rows: {n_areas}")

# distribution sanity check
from collections import Counter
pc = Counter(pipeline_of(r) for r in releases)
ac = Counter(a for r in releases for a in areas_of(r))
print(f"  pipelines: {dict(pc)}")
print(f"  areas: {dict(ac.most_common())}")
untagged = [r["id"] for r in releases if not areas_of(r)]
print(f"  releases with no area matched: {len(untagged)} {untagged}")
