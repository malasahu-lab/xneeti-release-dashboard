# Release Management

**Live dashboard: https://malasahu-lab.github.io/xneeti-release-dashboard/**

Every Xneeti production deploy, translated into plain language, updated
automatically — so anyone can see what shipped without reading a diff.

## The problem

When a developer deploys to production, a bot posts to `#prod-deployments`:

```
✅ Prod deploy succeeded
Version: v1.15.19
Ref: master
By: yadav-anant
View run →
```

That tells you *a* deploy happened. It does not tell you *what* is now on
production. Only the developer who wrote the code knows that. As QA, that left a
real blind spot: something shipped, and finding out what meant asking someone or
reading the diff yourself.

The first version of the fix was manual — paste the Slack message into Claude
Code, let a skill correlate it against GitHub, read the summary. It worked, but
it needed a human to start it every time.

## What this does

```
  #prod-deployments  (Slack)
          │
          │  polled hourly, 75-minute lookback
          ▼
  ┌───────────────────────────────────┐
  │  prod-deployments-watchdog        │   scheduled Claude Code routine
  │  1. detect deploy notification    │
  │  2. skip if already logged        │
  │  3. resolve commit from the run   │
  │  4. diff against last deploy of   │
  │     the same component            │
  │  5. write plain-language summary  │
  │     + risk tag                    │
  │  6. commit to releases.json       │
  └───────────────────────────────────┘
          │
          ▼
  releases.json  ──►  GitHub Pages  ──►  dashboard (polls every 45s)
```

No human in the loop. A deploy lands in Slack, and within the hour the dashboard
explains what shipped, why it matters, and how risky it was.

## Repository layout

| Path | What it is |
| --- | --- |
| `index.html` | The dashboard. One self-contained file — no build step, no dependencies. |
| `releases.json` | The release log. Source of truth, committed to git. |
| `automation/` | The scheduled routine's instructions, and how to set it up. |
| `db/` | A planned Postgres migration. **Not active** — see `db/README.md`. |

## The dashboard

Reads `releases.json` and renders a filterable feed. Deliberate choices:

- **Plain language, no jargon.** Summaries say "users were getting locked out of
  login for up to 2 hours after a role change", not the commit subject.
- **Risk tags** — breaking / hotfix / bugfix / feature / chore — so you can scan
  for what deserves attention.
- **Honest signals.** Where the automation is unsure it says so, rather than
  inventing detail. Terse commits produce entries that admit the scope is
  unclear and point at the ticket instead.
- **Failed deploys are logged too**, so "nothing changed on prod" is visible
  rather than absent.
- Search by version, commit, or author; filter by date; group by risk.
- Defaults to the last 7 days, refreshes every 45 seconds.

## What is real, and what is not

Worth being precise, because it affects how much you should trust the log:

- **Everything from 2026-08-12 onward is verified** against real GitHub commit
  history — 35 releases correlated commit-by-commit, with deploy times taken
  from the actual Slack notifications.
- **Entries before 2026-08-12** carry content from the original prototype and
  were never re-verified. `fe-v1.5.2` says so in its own highlights.
- **Area tags** (in the planned DB schema) are keyword-derived, not curated.

## Things the release log surfaced

Not features — findings, from correlating deploys against commits:

- **Frontend shipped ahead of its backend twice in nine days.** `v1.5.5`
  (Campaign Master) went out ~3 minutes before the endpoints it calls, and
  `v1.5.2`/`v1.1.33` did the same by ~100 seconds. Both were brief windows where
  the UI could have failed in production.
- **`v1.15.19` is almost certainly a mis-tag** for `v1.5.19` — it shipped barely
  an hour after `v1.5.18`. A wrong tag makes rollbacks and version comparisons
  unreliable.
- **`v1.5.6` shipped no new code at all** — zero commits between it and
  `v1.5.5`, so it was a pipeline re-run rather than a release.
- **`v1.1.44-backend` migrated search-term reporting to a new aggregate table** —
  the highest-risk change of that week for reporting accuracy, and exactly the
  kind of thing QA needs told rather than discovering later.
- **The EC2 and ECS pipelines reuse version numbers** that mean different code
  (`v1.1.45` exists in both), which makes them easy to confuse.

## Known limitations

- **Polling, not push.** A true Slack Events subscription needs a hosted HTTPS
  endpoint; the scheduled routine polls instead. Worst-case latency is about an
  hour.
- **Credentials sit in the routine's configuration in plaintext.** There is no
  secrets store available for scheduled routines, so the GitHub tokens live in
  its instructions. Scoped as tightly as the platform allows — see
  `automation/README.md`.
- **Whole-file writes.** Each new release rewrites `releases.json`. Fine at this
  size, and the reason the `db/` migration exists as a plan.
- **Read-only.** The dashboard cannot write, so there is no "I have tested this"
  state yet. That needs the database migration.
- **GitHub Pages caches for ~10 minutes**, so the dashboard is near-live rather
  than live.

## Next steps

1. **Jira ticket links** — commits reference `XNEETI-####`; surfacing those turns
   each entry into a jump-off point for testing.
2. **Affected-area tags** so you can ask "everything that touched Content Studio
   this month" and get a regression scope.
3. **Frontend/backend drift warning** — the pattern above happened twice; the
   dashboard should catch the third.
4. **QA status per release** — needs the database migration in `db/`.
