# The release logger

`log_releases.py` reads the production deploy workflows in the Xneeti repos and
appends anything new to `releases.json`. `.github/workflows/log-releases.yml`
runs it every hour and commits the result, so the dashboard updates on its own.

## Why it reads GitHub instead of Slack

The first version of this pipeline parsed the `#prod-deployments` Slack
messages. That turned out to be the wrong source:

- **The messages are ambiguous.** A frontend deploy and an EC2/scheduler deploy
  both post `Prod deploy succeeded` with no `Ref:` line — word for word
  identical. The only way to tell them apart is the repository in the run link.
- **Slack is a mirror, not the source.** Every field the log needs — version,
  who ran it, when it finished, the commit — is already on the workflow run.

Reading the workflow runs removes the ambiguity entirely, because each deploy
target is its own workflow file:

| Repo | Workflow | Logged as |
| --- | --- | --- |
| `xneeti-frontend` | `deploy-prod.yml` | Frontend |
| `xneeti-frontend` | `revert-prod.yml` | Frontend (revert) |
| `xneeti-monolith` | `prod-ecs-deploy.yml` | Backend (ECS) |
| `xneeti-monolith` | `prod-deploy.yml` | Backend (EC2 + Scheduler) |
| `xneeti-monolith` | `revert-prod.yml` | Backend (revert) |

It also means no Slack credentials are needed anywhere.

## Setup

Two repository secrets, at **Settings → Secrets and variables → Actions**.

### 1. `XNEETI_TOKEN` — required

A fine-grained personal access token with **read** access to
`XNeetiTech/xneeti-frontend` and `XNeetiTech/xneeti-monolith`:

| Permission | Level | Used for |
| --- | --- | --- |
| Actions | Read-only | listing deploy runs |
| Contents | Read-only | comparing commits |
| Pull requests | Read-only | reading PR descriptions |

The XNeetiTech org may require an admin to approve the token before it works.

Without this the job fails immediately and says so.

### 2. `ANTHROPIC_API_KEY` — optional, but you want it

This is what turns a commit message into something a QA engineer can act on.

With it, a release reads:

> Fixes report dates showing the previous day for users whose timezone is
> behind UTC.

Without it, the same release reads:

> Shipped: Add parsePeriodKeyLocal utility for handling date parsing in local
> timezone

The fallback works and never blocks a release from being logged — it labels
itself plainly as auto-generated so nobody mistakes it for a real summary — but
the plain-language summary is the entire point of this dashboard.

Uses `claude-opus-5`. Cost is a few cents a day at Xneeti's deploy rate.

## Running it by hand

**Actions → Log production releases → Run workflow.** That is the manual trigger
— use it when you don't want to wait for the hour.

Locally:

```sh
XNEETI_TOKEN=... ANTHROPIC_API_KEY=... DRY_RUN=1 python3 scripts/log_releases.py
```

`DRY_RUN` prints what it would add without writing anything.

## How it avoids duplicates and gaps

Every release gets a stable id — `fe-v1.15.20`, `be-v1.1.47-backend`,
`be-v1.1.48-ec2` — and anything already in `releases.json` is skipped. Because
duplicates are impossible, the lookback window can be generous: it considers any
run finished in the last **48 hours**, so a missed or delayed run catches up on
its own instead of leaving a permanent hole.

`concurrency` in the workflow keeps two runs from racing on the file, and the
commit step rebases before pushing in case a deploy landed mid-run.

## Timing

A deploy shows up within about an hour:

| | |
| --- | --- |
| Scheduled run | hourly at :20 (GitHub's scheduler can lag a few minutes) |
| Pages rebuild | ~1 min |
| CDN cache on `releases.json` | up to 10 min |

Not real-time. If you need it instantly, use the **Run workflow** button.

The genuinely real-time version is for the deploy workflows themselves to call
this on completion, which needs a change in the Xneeti repos rather than here.

## When something looks wrong

The job never writes a guessed entry. If it cannot resolve a commit range it
sets `ref_inferred: true` and says so in the release's own highlights, so a
thin summary is visible as thin rather than passing for complete.

Check **Actions → Log production releases** for the run log.
