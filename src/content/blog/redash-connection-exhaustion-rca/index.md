---
title: "Why an internal BI tool went down when its database ran out of connections"
description: "A database hit its max_connections limit after a pileup of idle-in-transaction connections, taking down a reporting tool and stalling its query queue."
date: "Jun 09 2025"
---

An internal reporting/BI tool was reported down one morning. Scheduled queries hadn't refreshed in about two hours, queries weren't being picked up off the queue fast enough and the queue itself was growing, and a scheduled check-in feature stopped working entirely. All symptoms of the same underlying problem, just visible in different places.

Application logs showed the actual error: `psycopg2.OperationalError: FATAL: sorry, too many clients already`. The tool's workers couldn't get a database connection because the database had hit its configured `max_connections` limit.

Looking at when connections started climbing, the pattern began hours before anyone reported the outage — connections had been creeping up since around 4am, well before the 8:30am report. By the time it was noticed, the database was also running at over 90% CPU.

Digging into what those connections were actually doing surfaced a specific pattern: a large number of them were sitting `idle in transaction`. That's a connection that opened a transaction and then didn't do anything — not commit, not rollback, just holding the connection and whatever locks that transaction implies while doing nothing. Each one by itself is harmless. Accumulate enough of them and they eat the entire connection pool while contributing zero useful work, which is effectively what happened here: connections piled up, the pool filled with idle ones, and new queries couldn't check out a connection even though the database wasn't being asked to do much real work relative to its connection count.

The immediate fix was operational: restart the worker pods and the web server to drop the stuck connections and release the pool, then clear the queries that had backed up in the queue so they weren't all retried at once.

The actionables that came out of it were aimed at not needing a manual restart next time:

- A regular, scheduled restart of worker processes during a maintenance window, rather than letting them run indefinitely and accumulate whatever state leads to this.
- A maintenance window for restarting the database itself, same reasoning.
- Setting `idle_in_transaction_session_timeout` on the database, so a connection that goes idle inside a transaction gets forcibly closed after a threshold instead of sitting there until someone notices.

Longer term, the plan was to get query-level visibility (`pg_stat_statements`) on this database specifically so idle-in-transaction and slow queries could be traced back to the queries causing them, rather than only seeing the aggregate symptom of connections running out.

The thing I took from this: a connection limit error looks like "we need more connections," but the actual fix was almost the opposite — stop connections from sitting around unused. Raising the limit would have bought time without addressing why connections were piling up in the first place.
