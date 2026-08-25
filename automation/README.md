# The automation

The dashboard is only the visible half. The part that makes it self-updating is a
**scheduled Claude Code routine** called `prod-deployments-watchdog`, which runs
hourly in the cloud and commits to `releases.json`.

It is configured on claude.ai (Code → Routines), not in this repo — a routine has
no file representation. `routine-instructions.md` here is the exact prompt it
runs, with credentials redacted, so the pipeline is reviewable and reproducible.

## How it runs

| | |
| --- | --- |
| Schedule | hourly |
| Lookback | 75 minutes (deliberately wider than the interval, so a late run still overlaps the previous one and nothing slips through) |
| Connectors | Slack (read) |
| Tools | Bash — GitHub is reached over `curl`, not a connector |
| Model | Claude Sonnet |

## Setup

1. **Two GitHub fine-grained tokens.** A token can only have one resource owner,
   which is why it is two rather than one:
   - **XNeetiTech-scoped** — repos `xneeti-frontend` + `xneeti-monolith`,
     permissions Contents: Read-only and Pull requests: Read-only. If you are not
     a full org member this generates as a *pending request* and an org admin has
     to approve it before it works.
   - **Personal-scoped** — repo `xneeti-release-dashboard`, Contents: Read and
     write.
2. Create a routine on claude.ai, add the **Slack** connector, and set the
   schedule to hourly.
3. Paste `routine-instructions.md` as the instructions, substituting your real
   token values for the two `REPLACE_WITH_…` placeholders.
4. Use **Run now** to test before trusting the schedule. With no deploy in the
   lookback window the correct result is that it does nothing at all.

## On the credentials

The tokens sit in the routine's instructions in plaintext. This is not a design
choice — scheduled routines expose no secrets store or environment variables, and
GitHub is not available to them as a connector, so a token passed to `curl` is
the only path. Consequences worth accepting knowingly:

- Anyone who can read the routine's configuration can read the tokens.
- **Rotate both** if the routine is deleted, exported, or handed to someone else.
- They are scoped as narrowly as GitHub allows: read-only on the two source
  repos, write confined to this dashboard repo. A leak cannot modify application
  code.

## Verified behaviour

- **Detection and the no-op path** were tested with live manual runs: it reads
  the channel, finds nothing inside the window, and correctly writes nothing.
- **Correlation and commit** were validated by hand against a real deploy
  (`v1.15.19`) — resolve the run's commit, diff against the previous frontend
  release, write the summary, commit. The 35-release backfill used the same
  procedure.
- **Not yet observed end-to-end unattended**, because no production deploy has
  landed inside a scheduled window since it was enabled. The first real deploy is
  the true test.

## Design notes

**Why polling.** A real Slack Events subscription pushes within milliseconds, but
it needs a public HTTPS endpoint to receive the callback — infrastructure this
project deliberately avoids. Hourly polling with an overlapping lookback trades
latency for having nothing to host.

**Why the lookback is wider than the interval.** At a 60-minute schedule with a
60-minute lookback, a run firing even slightly late leaves a gap. 75 minutes
means consecutive runs overlap; the dedupe step makes re-seeing a deploy harmless.

**Why dedupe is by ID.** Each release gets `<fe|be>-<version>`, checked against
`releases.json` before any work happens. Overlapping windows and manual re-runs
are therefore both safe.

**Failed deploys skip correlation.** A failed deploy shipped no code, so there is
nothing to diff. It is recorded with `status: "failed"` and no risk tag, which is
how the dashboard knows to show "production is still running the previous
version" rather than a changelog.

---

## Superseded

This Slack-polling routine has been replaced by a GitHub Action —
`.github/workflows/log-releases.yml`, documented in `scripts/README.md`.

Two reasons it was retired:

1. **It could not reach GitHub.** The scheduled cloud environment routes
   outbound traffic through a proxy that rejects `api.github.com` for repos not
   attached to the environment. Every run failed at the same step, regardless of
   the tokens, with *"GitHub access to this repository is not enabled for this
   session."*
2. **Slack was the wrong source.** A frontend deploy and an EC2/scheduler deploy
   post identical text; only the repository in the run link distinguishes them.
   Reading the workflow runs directly removes the ambiguity, and needs no Slack
   credentials and no long-lived PATs in a prompt.

Kept for reference only. Do not re-enable it alongside the Action — both write
`releases.json` and would conflict.
