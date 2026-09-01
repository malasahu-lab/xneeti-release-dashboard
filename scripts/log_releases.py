#!/usr/bin/env python3
"""Append newly-finished production deploys to releases.json.

Reads the deploy workflows in the Xneeti repos directly rather than parsing the
Slack announcements. Slack is only a mirror of these runs, and the API carries
everything the log needs — version, who ran it, when it finished, and the commit
— without the ambiguity that makes the Slack text hard to classify.

Run with no arguments. Environment:
  XNEETI_TOKEN       required. Read access to the two XNeetiTech repos.
  ANTHROPIC_API_KEY  optional. Without it, summaries fall back to PR titles.
  DRY_RUN            optional. Any non-empty value prints instead of writing.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

RELEASES_PATH = Path(__file__).resolve().parent.parent / "releases.json"

# How far back to consider a finished run. Comfortably wider than the schedule
# so a skipped or delayed run still catches up; the id dedupe makes overlap free.
LOOKBACK_HOURS = 48

# One entry per deploy target. The workflow file is what makes each pipeline
# unambiguous — the Slack messages for the frontend and the EC2/scheduler
# deploys are worded identically, which is exactly the trap this avoids.
PIPELINES = [
    {
        "repo": "XNeetiTech/xneeti-frontend",
        "workflow": "deploy-prod.yml",
        "component": "frontend",
        "label": "Frontend",
        "id_prefix": "fe",
        "version_suffix": "",
        "id_suffix": "",
        "revert": False,
    },
    {
        "repo": "XNeetiTech/xneeti-frontend",
        "workflow": "revert-prod.yml",
        "component": "frontend",
        "label": "Frontend",
        "id_prefix": "fe",
        "version_suffix": "",
        "id_suffix": "-revert",
        "revert": True,
    },
    {
        "repo": "XNeetiTech/xneeti-monolith",
        "workflow": "prod-ecs-deploy.yml",
        "component": "backend",
        "label": "Backend (ECS)",
        "id_prefix": "be",
        "version_suffix": "-backend",
        "id_suffix": "",
        "revert": False,
    },
    {
        "repo": "XNeetiTech/xneeti-monolith",
        "workflow": "prod-deploy.yml",
        "component": "backend",
        "label": "Backend (EC2 + Scheduler)",
        "id_prefix": "be",
        "version_suffix": "",
        "id_suffix": "-ec2",
        "revert": False,
    },
    {
        "repo": "XNeetiTech/xneeti-monolith",
        "workflow": "revert-prod.yml",
        "component": "backend",
        "label": "Backend (ECS)",
        "id_prefix": "be",
        "version_suffix": "-backend",
        "id_suffix": "-revert",
        "revert": True,
    },
]

VERSION_RE = re.compile(r"v\d+\.\d+\.\d+")
PR_RE = re.compile(r"Merge pull request #(\d+)")

RiskTag = Literal["breaking", "hotfix", "bugfix", "feature", "chore"]


# --------------------------------------------------------------------------- #
# GitHub
# --------------------------------------------------------------------------- #

def gh(path: str, token: str) -> Any:
    """GET the GitHub API. Returns None on 404 so callers can treat a missing
    resource as 'no data' rather than crashing the whole run."""
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "xneeti-release-logger",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        body = e.read().decode("utf-8", "replace")[:300]
        err = RuntimeError(f"GitHub {e.code} on {path}: {body}")
        err.status = e.code  # type: ignore[attr-defined]
        raise err from None


PERMISSION_HELP = """
The token cannot read GitHub Actions on {repo}.

Almost always one of two things:

  1. The token is missing the "Actions" permission.
     Fine-grained tokens need Actions: Read-only as a SEPARATE permission —
     Contents: Read is not enough to list workflow runs.

  2. The token is still waiting for XNeetiTech admin approval.
     Fine-grained tokens against an organisation stay inert until an org owner
     approves them, and calls fail exactly like this in the meantime.

Check both at: https://github.com/settings/personal-access-tokens
Open the token, confirm Actions: Read-only is listed under XNeetiTech, and look
for a "Pending approval" banner at the top.

After changing permissions you do NOT need a new token or a new secret — the
change applies to the existing one. Just re-run this workflow.
"""


def preflight(token: str) -> int:
    """Check each repo and permission before doing real work, so a misconfigured
    token produces one clear sentence instead of a traceback partway through."""
    repos = sorted({p["repo"] for p in PIPELINES})
    failures = 0

    for repo in repos:
        try:
            meta = gh(f"/repos/{repo}", token)
        except RuntimeError as e:
            print(f"  {repo}: cannot read the repository at all — {e}", file=sys.stderr)
            failures += 1
            continue
        if meta is None:
            print(f"  {repo}: not visible to this token (404). Either the repo is not "
                  f"selected on the token, or the token is not approved yet.", file=sys.stderr)
            failures += 1
            continue
        print(f"  {repo}: contents ok")

        try:
            gh(f"/repos/{repo}/actions/workflows?per_page=1", token)
            print(f"  {repo}: actions ok")
        except RuntimeError as e:
            if getattr(e, "status", None) == 403:
                print(PERMISSION_HELP.format(repo=repo), file=sys.stderr)
            else:
                print(f"  {repo}: actions check failed — {e}", file=sys.stderr)
            failures += 1

    return failures


def recent_runs(pipeline: dict, token: str) -> list[dict]:
    """Successful and failed runs of one deploy workflow, newest first."""
    data = gh(
        f"/repos/{pipeline['repo']}/actions/workflows/{pipeline['workflow']}"
        f"/runs?status=completed&per_page=30",
        token,
    )
    return (data or {}).get("workflow_runs", [])


# --------------------------------------------------------------------------- #
# Summarisation
# --------------------------------------------------------------------------- #

SUMMARY_SYSTEM = """\
You write release notes for a QA engineer who did not write the code and does \
not want to read a diff. Describe the user-visible effect of a production \
deploy in plain language.

Rules:
- `overview` is ONE sentence describing what changed for people using the \
product. Never restate a commit subject. Write "Fixes report dates showing the \
previous day for users whose timezone is behind UTC", not "Add \
parsePeriodKeyLocal utility".
- `highlights` is 2 to 5 short bullets in the same register. Naming a PR number \
at the end of a bullet is fine; do not lead with ticket IDs.
- Flag anything genuinely risky plainly and early in the bullets: database \
migrations (especially irreversible ones such as a dropped table or column), \
anything the PR itself calls breaking, a stated deploy order or merge gate, \
feature flags, or a required manual step.
- `risk_tag` is exactly one of: breaking, hotfix, bugfix, feature, chore. Use \
`breaking` for irreversible schema changes and anything the PR describes as \
breaking.
- If the material is thin, say so honestly rather than inventing detail. Never \
describe a change you cannot see evidence for."""


def summarize_with_claude(pipeline: dict, version: str, commits: list[str],
                          prs: list[dict]) -> dict | None:
    """Plain-language summary via Claude. Returns None if unavailable so the
    caller can fall back rather than lose the release entirely."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None

    try:
        import anthropic
        from pydantic import BaseModel
    except ImportError:
        print("  ! anthropic/pydantic not installed — falling back", file=sys.stderr)
        return None

    class ReleaseSummary(BaseModel):
        overview: str
        highlights: list[str]
        risk_tag: RiskTag

    parts = [
        f"Deploy target: {pipeline['label']}",
        f"Repository: {pipeline['repo']}",
        f"Version: {version}",
        "",
        "Commits in this deploy:",
        *(f"- {c}" for c in commits or ["(none resolved)"]),
    ]
    for pr in prs:
        body = (pr.get("body") or "").strip()
        if len(body) > 6000:
            body = body[:6000] + "\n…(truncated)"
        parts += ["", f"--- PR #{pr['number']}: {pr['title']} ---", body or "(no description)"]

    try:
        client = anthropic.Anthropic()
        response = client.messages.parse(
            model="claude-opus-5",
            max_tokens=16000,
            thinking={"type": "adaptive"},
            system=SUMMARY_SYSTEM,
            messages=[{"role": "user", "content": "\n".join(parts)}],
            output_format=ReleaseSummary,
        )
        return response.parsed_output.model_dump()
    except Exception as e:  # noqa: BLE001 — never let a summary failure drop a release
        print(f"  ! summary failed ({type(e).__name__}: {e}) — falling back", file=sys.stderr)
        return None


CODERABBIT_RE = re.compile(
    r"##\s*Summary by CodeRabbit\s*(.*?)(?:<!--\s*end of auto-generated|\Z)", re.S | re.I)
CAT_RE = re.compile(r"^[*\-]\s*\*\*(.+?)\*\*:?\s*$")
BULLET_RE = re.compile(r"^[*\-]\s+(.*\S)\s*$")
JUNK_TITLE_RE = re.compile(r"^(xneeti[\s\-_]*\d+|update|updates|changes|fix|fixes|wip)\.?$", re.I)

# Deterministic risk signals. These are the things a release log exists to
# surface, and they must not depend on an API key being present.
# (group, pattern, message). Only the first match within a group is emitted, so
# a table drop does not produce two bullets saying the same thing.
DANGER_PATTERNS = [
    ("drop", re.compile(r"\bDROP\s+TABLE\b", re.I),
     "Runs a migration that DROPS a database table — irreversible, and the "
     "reports that used it will stop returning data."),
    ("drop", re.compile(r"drop\s+[a-z0-9_]+\s+and remove its retired code paths", re.I),
     "Permanently retires a reporting table and the code that fed it — irreversible."),
    ("gate", re.compile(r"DO NOT MERGE BEFORE\s+([0-9]{4}-[0-9]{2}-[0-9]{2})", re.I),
     "The pull request carries a stated merge gate — check it was cleared before this shipped."),
    ("order", re.compile(r"^\s*##\s*Deploy ordering \(BINDING", re.I | re.M),
     "The pull request specifies a binding deploy order — check the pipelines went out in that order."),
    ("breaking", re.compile(r"\bBREAKING CHANGE\b", re.I),
     "Flagged as a breaking change by the author."),
]

CATEGORY_RANK = [
    ("breaking", ("breaking",)),
    ("feature", ("new feature", "feature")),
    ("bugfix", ("bug fix", "bugfix", "fix")),
    ("chore", ("refactor", "chore", "documentation", "test", "style", "performance")),
]


def repair_title(pr: dict) -> str:
    """GitHub truncates long PR titles at ~70 chars and the author's original
    text continues at the top of the body. Stitch the two halves back together
    so the log does not show 'External Ima…'."""
    title = (pr.get("title") or "").rstrip()
    body = (pr.get("body") or "").lstrip()
    if title.endswith("…") and body.startswith("…"):
        tail = body.split("\n", 1)[0].lstrip("…").strip()
        if tail:
            return (title[:-1].rstrip() + tail).strip()
    return title


def coderabbit_sections(body: str) -> dict[str, list[str]]:
    """CodeRabbit posts a plain-language summary into most PR bodies. It is
    already written for humans, so prefer it over any title we could scrape."""
    m = CODERABBIT_RE.search(body or "")
    if not m:
        return {}
    out: dict[str, list[str]] = {}
    current = None
    for raw in m.group(1).splitlines():
        line = raw.strip()
        cat = CAT_RE.match(line)
        if cat:
            current = cat.group(1).strip()
            out.setdefault(current, [])
            continue
        bullet = BULLET_RE.match(line)
        if bullet and current and not bullet.group(1).startswith("**"):
            text = bullet.group(1).strip()
            if text:
                out[current].append(text)
    return {k: v for k, v in out.items() if v}


def summarize_mechanically(commits: list[str], prs: list[dict]) -> dict:
    """Used when Claude is unavailable. Builds the best summary obtainable
    without a model: CodeRabbit's own prose where it exists, repaired PR titles
    otherwise, plus deterministic warnings for migrations and merge gates."""
    haystack = "\n".join(commits) + "\n" + "\n".join(
        f"{pr.get('title','')}\n{pr.get('body','') or ''}" for pr in prs)

    warnings, fired = [], set()
    for group, pattern, message in DANGER_PATTERNS:
        if group not in fired and pattern.search(haystack):
            fired.add(group)
            warnings.append(message)

    sections: dict[str, list[str]] = {}
    for pr in prs:
        for cat, bullets in coderabbit_sections(pr.get("body") or "").items():
            sections.setdefault(cat, []).extend(bullets)

    risk = "chore"
    for tag, keys in CATEGORY_RANK:
        if any(any(k in cat.lower() for k in keys) for cat in sections):
            risk = tag
            break
    if warnings:
        risk = "breaking"

    ordered: list[str] = []
    for _, keys in CATEGORY_RANK:
        for cat, bullets in sections.items():
            if any(k in cat.lower() for k in keys):
                ordered.extend(bullets)
    for bullets in sections.values():          # anything uncategorised
        for b in bullets:
            if b not in ordered:
                ordered.append(b)

    titles = [t for t in (repair_title(pr) for pr in prs)
              if t and not JUNK_TITLE_RE.match(t)]
    if not titles:
        titles = [c for c in commits if not c.startswith("Merge ")]

    if ordered:
        overview = ordered[0]
        highlights = warnings + [b for b in ordered[1:] if b != overview]
    elif titles:
        overview = titles[0].rstrip(".") + "."
        highlights = warnings + titles[1:]
        if not warnings and len(titles) <= 1:
            highlights = highlights + [
                "No pull request description was available, so this is taken from the commit title."
            ]
    else:
        overview = "Deployed to production; no pull requests were resolved for this range."
        highlights = warnings

    # dedupe, keep order, cap
    final, seen = [], set()
    for h in highlights:
        if h not in seen:
            seen.add(h)
            final.append(h)

    return {"overview": overview, "highlights": final[:6], "risk_tag": risk}


# --------------------------------------------------------------------------- #
# Assembly
# --------------------------------------------------------------------------- #

def build_entry(pipeline: dict, run: dict, existing: list[dict], token: str) -> dict | None:
    m = VERSION_RE.search(run.get("display_title") or "")
    if not m:
        print(f"  - skipping run {run['id']}: no version in {run.get('display_title')!r}")
        return None

    version = m.group(0) + pipeline["version_suffix"]
    entry_id = f"{pipeline['id_prefix']}-{version}{pipeline['id_suffix']}"
    head_sha = run["head_sha"]
    # A run can end several ways and they mean different things to QA. A
    # cancelled deploy is somebody stopping it on purpose; a failed one broke.
    # Both leave production on the old version, but only one needs chasing.
    conclusion = run.get("conclusion")
    shipped = conclusion == "success"

    entry = {
        "id": entry_id,
        "component": pipeline["component"],
        "component_label": pipeline["label"],
        "version": version,
        # updated_at is when the run finished, which is what the Slack post
        # reflects. created_at would be several minutes early.
        "deployed_at": run["updated_at"],
        "deployed_by": (run.get("triggering_actor") or run.get("actor") or {}).get("login", "unknown"),
        "commit": head_sha[:12],
        "ref": run.get("head_branch") or "master",
        "ref_inferred": False,
        "run_url": run["html_url"],
        "risk_tag": None,
        "status": "success" if shipped else ("cancelled" if conclusion == "cancelled" else "failed"),
        "overview": "",
        "highlights": [],
    }

    if not shipped:
        if conclusion == "cancelled":
            entry["overview"] = ("Deploy cancelled before it finished — production is still "
                                 "running the previous version, nothing changed.")
            entry["highlights"] = [
                "Someone stopped this deploy deliberately rather than it breaking.",
                f"Cancelled workflow run: {run['html_url']}",
            ]
        else:
            entry["overview"] = ("Deploy failed — production is still running the previous "
                                 "version, nothing changed.")
            entry["highlights"] = [
                f"Failed workflow run ({conclusion or 'no conclusion reported'}): {run['html_url']}",
            ]
        return entry

    if pipeline["revert"]:
        entry["risk_tag"] = "hotfix"
        entry["overview"] = f"Production was rolled back to {version}."
        entry["highlights"] = ["A revert was run, so the previous deploy's changes are no longer live.",
                               f"Workflow run: {run['html_url']}"]
        return entry

    # Diff against the last logged release for the SAME target, so an EC2 entry
    # compares against the previous EC2 entry rather than the ECS one.
    prior = next((r for r in existing
                  if r["component_label"] == pipeline["label"] and r.get("status") == "success"
                  and r.get("commit")), None)
    base = prior["commit"] if prior else None

    # A version bump with no code change behind it. Saying "no pull requests
    # were resolved" reads like something went wrong; it did not.
    if base and base == head_sha[:len(base)]:
        entry["risk_tag"] = "chore"
        entry["overview"] = (f"Redeploy of the same code as {prior['version']} — "
                             f"no new changes shipped.")
        entry["highlights"] = [
            f"Identical commit to {prior['version']}, deployed earlier.",
            "A same-commit redeploy usually means a version bump or a repeated "
            "attempt; nothing in the application changed.",
        ]
        return entry

    commits: list[str] = []
    prs: list[dict] = []
    if base:
        cmp_data = gh(f"/repos/{pipeline['repo']}/compare/{base}...{head_sha}", token)
        if cmp_data:
            commits = [c["commit"]["message"].split("\n")[0] for c in cmp_data.get("commits", [])]
            for num in {int(n) for c in commits for n in PR_RE.findall(c)}:
                pr = gh(f"/repos/{pipeline['repo']}/pulls/{num}", token)
                if pr:
                    prs.append({"number": num, "title": pr["title"], "body": pr.get("body")})
        else:
            entry["ref_inferred"] = True
    else:
        entry["ref_inferred"] = True

    summary = summarize_with_claude(pipeline, version, commits, prs) or summarize_mechanically(commits, prs)
    entry.update(summary)

    if entry["ref_inferred"]:
        entry["highlights"].append(
            "The commit range could not be resolved, so this summary may be incomplete."
        )
    return entry


def main() -> int:
    token = os.environ.get("XNEETI_TOKEN")
    if not token:
        print("XNEETI_TOKEN is not set — cannot read the Xneeti repos.", file=sys.stderr)
        return 1

    print("Checking token access…")
    if preflight(token):
        print("\nStopping before making any changes — fix the token access above, "
              "then re-run.", file=sys.stderr)
        return 1
    print()

    doc = json.loads(RELEASES_PATH.read_text())
    releases: list[dict] = doc["releases"]
    by_id = {r["id"]: r for r in releases}

    cutoff = datetime.now(timezone.utc).timestamp() - LOOKBACK_HOURS * 3600
    added: list[dict] = []

    for pipeline in PIPELINES:
        print(f"· {pipeline['label']} — {pipeline['workflow']}")
        for run in recent_runs(pipeline, token):
            finished = datetime.strptime(run["updated_at"], "%Y-%m-%dT%H:%M:%SZ")
            if finished.replace(tzinfo=timezone.utc).timestamp() < cutoff:
                break  # runs come newest-first, so everything after this is older

            m = VERSION_RE.search(run.get("display_title") or "")
            if not m:
                continue
            candidate = (f"{pipeline['id_prefix']}-{m.group(0)}"
                         f"{pipeline['version_suffix']}{pipeline['id_suffix']}")

            # A cancelled or failed deploy is usually retried under the SAME
            # version, so the id collides. Skipping on id alone left the log
            # asserting a release was cancelled when the retry had shipped it —
            # the exact opposite of the truth. Let a success supersede a
            # non-success for the same version.
            existing = by_id.get(candidate)
            if existing is not None:
                if existing.get("status") == "success" or run.get("conclusion") != "success":
                    continue
                print(f"  ~ {candidate} — superseding {existing.get('status')} attempt "
                      f"with the successful re-run")

            entry = build_entry(pipeline, run, releases, token)
            if entry:
                if existing is not None:
                    releases[releases.index(existing)] = entry
                else:
                    releases.append(entry)
                    print(f"  + {entry['id']} — {entry['overview'][:80]}")
                by_id[entry["id"]] = entry
                added.append(entry)

    if not added:
        print("\nNothing new.")
        return 0

    releases.sort(key=lambda r: r["deployed_at"], reverse=True)
    doc["releases"] = releases
    doc["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if os.environ.get("DRY_RUN"):
        print(f"\nDRY_RUN — would add {len(added)}:")
        print(json.dumps(added, indent=2))
        return 0

    RELEASES_PATH.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print(f"\nAdded {len(added)}: {', '.join(e['id'] for e in added)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
