---
title: "A scheduled-query worker increase that pushed a database out of memory"
description: "Bumping worker concurrency to clear a backlog of scheduled queries overloaded a shared database, which triggered an out-of-memory kill of its checkpointer process."
date: "Feb 24 2025"
---

An internal Postgres database went down for a few minutes one morning. The service just stopped responding — not degraded, fully down until it restarted itself.

The timeline started a bit earlier than the outage itself. We had a backlog of over 1,500 scheduled queries queued up on a reporting tool that reads from this database, so we'd increased the worker concurrency on that tool from 12 to 20 to clear the backlog faster. More workers meant more concurrent queries hitting the same database.

Shortly after, the database's logs showed connections timing out, and then the checkpointer process got killed. In Postgres, the checkpointer periodically flushes in-memory changes (the shared buffer) to disk so recovery after a crash doesn't have to replay the entire write-ahead log from the beginning. When it gets killed mid-flush, Postgres treats that as an unsafe state and shuts the whole instance down rather than risk corruption, then goes through crash recovery on restart.

The kernel logs confirmed why the checkpointer died: the out-of-memory killer stepped in. Something had pushed memory usage past what the host could sustain, and the OOM killer picked a process to kill to free memory — in this case, a core Postgres process rather than one of the query workers.

What we could confirm: the extra scheduled-query concurrency increased load on the box around the same time. What we couldn't fully pin down: the exact mechanism that tipped memory usage over the edge. Postgres connections, query memory, and background jobs can all contribute to pressure, and by the time we were reading kernel logs after the fact, we had a kill event and a plausible cause, not a clean single line from A to B.

The database came back on its own after crash recovery, a few minutes after the initial failure. No data loss, since write-ahead logging is designed for exactly this kind of unclean shutdown.

What changed afterward: treating "increase worker concurrency" as a capacity change that needs the same scrutiny as any other load increase on a shared database, not a quick settings tweak. And generally, when a fix for one symptom (a query backlog) involves turning up concurrency against a resource other things depend on, it's worth asking what else is sharing that resource before making the change, not after it falls over.
