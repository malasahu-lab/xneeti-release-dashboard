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
        raise RuntimeError(f"GitHub {e.code} on {path}: {body}") from None


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


def summarize_mechanically(commits: list[str], prs: list[dict]) -> dict:
    """Fallback when Claude is unavailable. Honest and dull rather than absent —
    it says plainly that it is not a real summary so nobody mistakes it for one."""
    titles = [pr["title"] for pr in prs] or [c for c in commits if not c.startswith("Merge ")]
    if titles:
        overview = f"Shipped: {titles[0]}" + (f" (and {len(titles) - 1} more)" if len(titles) > 1 else "")
    else:
        overview = "Deployed to production; no pull requests were resolved for this range."
    return {
        "overview": overview,
        "highlights": [*titles[:4], "Auto-generated from commit titles — no plain-language summary available."],
        "risk_tag": "chore",
    }


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
    failed = run.get("conclusion") != "success"

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
        "status": "failed" if failed else "success",
        "overview": "",
        "highlights": [],
    }

    if failed:
        entry["overview"] = ("Deploy failed — production is still running the previous "
                             "version, nothing changed.")
        entry["highlights"] = [f"Failed workflow run: {run['html_url']}"]
        return entry

    if pipeline["revert"]:
        entry["risk_tag"] = "hotfix"
        entry["overview"] = f"Production was rolled back to {version}."
        entry["highlights"] = ["A revert was run, so the previous deploy's changes are no longer live.",
                               f"Workflow run: {run['html_url']}"]
        return entry

    # Diff against the last logged release for the SAME target, so an EC2 entry
    # compares against the previous EC2 entry rather than the ECS one.
    base = next((r["commit"] for r in existing
                 if r["component_label"] == pipeline["label"] and r.get("status") == "success"
                 and r.get("commit")), None)

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

    doc = json.loads(RELEASES_PATH.read_text())
    releases: list[dict] = doc["releases"]
    known = {r["id"] for r in releases}

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
            if candidate in known:
                continue

            entry = build_entry(pipeline, run, releases, token)
            if entry:
                print(f"  + {entry['id']} — {entry['overview'][:80]}")
                releases.append(entry)
                known.add(entry["id"])
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
