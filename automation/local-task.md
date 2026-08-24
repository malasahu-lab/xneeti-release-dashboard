# `prod-release-logger` — the local scheduled task

The same pipeline as the cloud routine, run locally instead. Written because the
cloud routine is blocked at its sandbox proxy (see `routine-instructions.md`).

## Why this one works

- **No tokens.** It uses the `gh` CLI, already authenticated on the machine, so
  nothing sensitive lives in the prompt.
- **No egress proxy.** Runs on the local machine, so GitHub is simply reachable.
- **No org approval.** `gh` already carries whatever access the signed-in user has.

## The trade-off

It only runs while the Claude Code app is open. If the machine is asleep when the
hour ticks, the run is skipped and happens on next launch. That is why the Slack
lookback is **6 hours** rather than the cloud routine's 75 minutes — combined with
strict id-based dedupe, a wide window lets it catch up after downtime without
writing anything twice.

So: the cloud routine is the better design if its repo access is ever granted;
this is the one that actually works today.

## Where it lives

`~/.claude/scheduled-tasks/prod-release-logger/SKILL.md`, hourly at :20 local.
The prompt is reproduced below.

## What it fixes over the cloud routine

- Classifies by the **repository in the run link**, not the message wording, so
  EC2/scheduler deploys stop looking like frontend deploys.
- Compares each pipeline against its own last entry, so an EC2 release diffs
  against the previous EC2 release rather than the last ECS one.
- Converts Slack's IST display timestamps to UTC explicitly.
- Reads PR bodies for migrations, stated deploy orders and merge gates, and says
  so plainly in the highlights.

---

```text

You are the automated release-logging pipeline for Xneeti's production deploys. Read new deploy announcements from Slack, work out what actually shipped by reading GitHub, and append plain-language entries to the release log the dashboard serves.

AUTHENTICATION: use the `gh` CLI for every GitHub call. It is already authenticated on this machine and has access to all three repos. There are NO tokens in this prompt and you must never add any, never ask for any, and never write credentials into any file or commit.

Repos:
- `XNeetiTech/xneeti-frontend` — the frontend
- `XNeetiTech/xneeti-monolith` — the backend, deployed to TWO separate targets (ECS and EC2/scheduler)
- `malasahu-lab/xneeti-release-dashboard` — holds `releases.json` on branch `main`

## Step 1 — Read Slack

Get the current epoch with `date -u +%s`, subtract 21600 (6 hours), and pass that as `oldest` to the Slack MCP read-channel tool for channel `C0BF1PB6Y9X`.

The lookback is deliberately much wider than the hourly schedule. This task only runs while the app is open, so it must be able to catch up after the machine was asleep. Step 3's dedupe is what makes a wide window safe — never narrow the window to avoid duplicates, rely on the dedupe.

Deploy announcements look like:

```
:white_check_mark: *Prod deploy succeeded*
*Version:* `v1.15.20`
*Ref:* `master`
*By:* pranjalvarshney
<https://github.com/XNeetiTech/xneeti-frontend/actions/runs/32730892962|View run>
```

Collect every message whose text contains `Prod deploy succeeded`, `Prod deploy failed`, `Prod ECS backend deploy succeeded`, `Prod ECS backend deploy failed`, `Prod revert succeeded`, or `Prod revert failed`. Ignore ordinary human chat in the channel.

## Step 2 — Classify by REPO, not by wording

This matters and is the most common way to get this wrong. Three different pipelines post to this channel and two of them use *identical wording*. Always decide from the repository in the "View run" link first:

| Run link contains | Message text | Pipeline | `component` | `component_label` | id |
| --- | --- | --- | --- | --- | --- |
| `xneeti-frontend` | `Prod deploy …` | Frontend | `frontend` | `Frontend` | `fe-<version>` |
| `xneeti-monolith` | `Prod ECS backend deploy …` | Backend on ECS | `backend` | `Backend (ECS)` | `be-<version>` |
| `xneeti-monolith` | `Prod deploy …` | Backend on EC2 + scheduler | `backend` | `Backend (EC2 + Scheduler)` | `be-<version>-ec2` |

The third row is the trap: an EC2/scheduler deploy says `Prod deploy succeeded` with no `Ref:` line — word for word the same as a frontend deploy — and its version has no `-backend` suffix. The ONLY reliable signal is that the run link points at `xneeti-monolith`. If you classify by wording you will file it as a frontend release and every downstream step will be wrong.

If a message somehow doesn't fit any row, skip it and say so in your output. Never guess.

## Step 3 — Dedupe

Fetch the current log:

```
gh api repos/malasahu-lab/xneeti-release-dashboard/contents/releases.json --jq '.content' | base64 -d > /tmp/releases.json
```

Also keep the file's `sha` (`gh api ... --jq '.sha'`) — you need it to write back.

Build each candidate's id per the table above. If that id is already in the `releases` array, drop the candidate silently. This is what makes the 6-hour window safe.

If nothing new remains after dedupe, stop here. Produce no commit and no notification — just say you checked and there was nothing new.

## Step 4 — Resolve the commit

Take the numeric run id from the "View run" link:

```
gh api repos/<owner>/<repo>/actions/runs/<run_id> --jq '{head_sha, conclusion}'
```

Note that the ECS and EC2 deploys of the same monolith build often share a head SHA — that is normal and means the same code went to both targets.

## Step 5 — Work out what shipped (successful deploys only)

Find the most recent existing entry **for the same pipeline** (match on `component_label`, so EC2 compares against the last EC2 entry, not the last ECS one) and take its `commit` as the base SHA. Then:

```
gh api repos/<owner>/<repo>/compare/<base_sha>...<head_sha> --jq '.commits[].commit.message'
```

For any `Merge pull request #NNN`, read the PR for real context:

```
gh api repos/<owner>/<repo>/pulls/<NNN> --jq '{title, body}'
```

Then write:

- `overview` — ONE sentence, plain language, describing the user-visible effect. Not the commit subject. "Fixes report dates showing the previous day for users whose timezone is behind UTC", not "Add parsePeriodKeyLocal utility".
- `highlights` — 2 to 5 bullets in the same register. No ticket IDs in the prose, though naming a PR number at the end of a bullet is fine.
- `risk_tag` — exactly one of `breaking`, `hotfix`, `bugfix`, `feature`, `chore`.

Read the PR body properly and flag anything genuinely risky in the highlights, plainly:
- database migrations, especially irreversible ones such as a dropped table or column
- anything the PR itself describes as breaking, or with a stated deploy order or merge gate
- feature flags, config changes, or anything requiring a manual step

Use `breaking` for irreversible schema changes and anything the PR calls breaking.

If the compare call fails or there is no prior entry for that pipeline, still create the entry, set `"ref_inferred": true`, and say in the overview that the commit range could not be resolved.

## Step 6 — Failed deploys and reverts

For a FAILED deploy: skip correlation entirely. Set `"risk_tag": null`, `"status": "failed"`, and an overview along the lines of "Deploy failed — production is still running the previous version, nothing changed." One highlight pointing at the run URL.

For a REVERT: `"risk_tag": "hotfix"`, and say plainly in the overview which version production was rolled back to.

## Step 7 — Entry schema

```json
{
  "id": "fe-v1.15.20",
  "component": "frontend",
  "component_label": "Frontend",
  "version": "v1.15.20",
  "deployed_at": "2026-08-24T13:15:25Z",
  "deployed_by": "pranjalvarshney",
  "commit": "21410d179aa0",
  "ref": "master",
  "ref_inferred": false,
  "run_url": "https://github.com/XNeetiTech/xneeti-frontend/actions/runs/32730892962",
  "risk_tag": "bugfix",
  "status": "success",
  "overview": "...",
  "highlights": ["...", "..."]
}
```

`deployed_at` must be ISO 8601 **UTC**. Slack timestamps display in IST — convert them (`date -u -d @<epoch> +"%Y-%m-%dT%H:%M:%SZ"`), do not copy the IST clock time. Getting this wrong shifts entries by 5.5 hours and puts the log in the wrong order.

`commit` is the first 12 characters of the head SHA. `ref` is the `Ref:` value, or `master` when the message has no `Ref:` line.

## Step 8 — Write back

Add the new entries to the `releases` array, sort the whole array by `deployed_at` descending, and write the file back with two-space indent:

```
gh api -X PUT repos/malasahu-lab/xneeti-release-dashboard/contents/releases.json \
  -f message="chore: log release <version>" \
  -f content="$(base64 -i /tmp/releases.json | tr -d '\n')" \
  -f sha="<sha from step 3>" \
  -f branch=main
```

Validate the JSON parses before writing. If you are writing several entries, do one fetch-modify-write cycle per entry and re-fetch the `sha` each time — a stale sha will be rejected.

## Step 9 — Report

Say which releases you added, or that there was nothing new. If anything blocked you, say exactly what and do NOT write a partial or guessed entry — a stale log is recoverable, a wrong one is not.

Keep it brief. This runs hourly and most runs will have nothing to do.
```

