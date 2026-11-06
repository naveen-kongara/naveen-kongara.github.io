---
title: "Diagnosing and tuning autovacuum on a bloated Postgres table"
description: "A production Postgres database had millions of dead rows piling up on a few large tables. Here's how we investigated it and what we changed."
date: "Aug 31 2023"
---

One of our production Postgres databases (version 11) had a handful of tables with a few million dead rows sitting around, and bloat was creeping up — around 10 GB of bloat out of roughly 137 GB total size. Autovacuum was running, nothing was obviously broken, but the dead row counts on the biggest tables kept drifting upward instead of staying flat. I spent a couple of weeks digging into why.

## Starting point

The default autovacuum settings were untouched:

- `autovacuum_vacuum_threshold = 50`
- `autovacuum_vacuum_scale_factor = 0.2`
- `autovacuum_analyze_scale_factor = 0.1`
- `maintenance_work_mem = 2 GB` (bumped up from the 64 MB default, at least)

Autovacuum decides whether to vacuum a table using a simple formula:

```
vacuum threshold = autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * live_rows
```

A table only gets vacuumed once its dead row count crosses that threshold. That formula is the whole problem for big tables. A table with 90 million live rows needs roughly 18 million dead rows before autovacuum even considers touching it — by which point you're carrying a lot of bloat for a long time before anything happens.

## What the data showed

Pulling live/dead row counts and comparing against each table's computed threshold made the pattern obvious. Small, high-churn tables (like a users table with ~30k rows) were being vacuumed constantly — autovacuum ran against it well over a thousand times in the observation window, because its threshold is tiny relative to its churn. Meanwhile the handful of genuinely large tables — the ones actually responsible for most of the bloat — sat much closer to their thresholds without crossing them, because inserts and updates kept the live row count climbing just as fast as dead rows accumulated, which pushes the threshold up in lockstep.

In other words: a flat scale factor works fine for small tables and badly for large ones. The bigger the table, the bigger the dead-row buffer it's implicitly allowed before autovacuum reacts.

## What we tried

A few options came up in review:

- Lowering the global scale factor (we discussed 15–18%, down from 20%) so autovacuum would trigger earlier across the board.
- Setting per-table overrides via `ALTER TABLE ... SET (autovacuum_vacuum_scale_factor = ...)`. This is the cleaner fix — but it's only available from Postgres 12 onward. We were still on 11, so table-level storage parameters for autovacuum weren't an option without a major version upgrade.
- Scheduled manual `VACUUM` on the worst offenders, run as a cron job during low-traffic hours, with the regular autovacuum settings left alone the rest of the time.

Given the version constraint, we went with the last option for the biggest tables, and a modest reduction in the global vacuum threshold and scale factor (threshold down to 5000, scale factor to 0.18) to make autovacuum a bit more eager without making it aggressive during business hours.

## Testing it before rolling out

Before changing anything in production, I ran the manual vacuum script against a large, heavily-bloated table in a non-production environment to confirm the mechanics and see the actual effect. One table went from 1.26 million dead rows down to zero after the script ran, with live rows essentially unchanged. That gave enough confidence to schedule it as a recurring nightly job against the equivalent tables in production, rather than a one-off cleanup.

## What I'd do differently

The real fix here is a Postgres major version upgrade, so per-table autovacuum tuning becomes available instead of relying on a single global scale factor plus a cron-scheduled manual vacuum as a workaround. The scheduled vacuum did the job, but it's a patch, not a solution — it only runs on the tables you remember to list, and new large tables will quietly drift into the same problem unless someone notices. If I were setting this up again, I'd prioritize the version upgrade first and treat per-table autovacuum settings as the default for any table expected to grow past a few million rows, rather than discovering the need for it after the bloat already shows up.
