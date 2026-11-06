---
title: "Benchmarking logical vs physical replication for Postgres"
description: "Comparing replication lag between logical and physical replicas under write load, and the tradeoff that decided which one to use."
date: "Jan 16 2025"
---

We had a couple of production Postgres databases running standard physical (streaming) replication, and I wanted to check whether logical replication would give us lower lag, before leaning on it more for a data pipeline project. On paper logical replication should be lighter, since it ships decoded row changes instead of raw WAL, but I wanted numbers instead of assumptions.

## Setup

I built two replicas off the same master: one physical, one logical, both on identical instance types so the comparison wasn't skewed by hardware. For logical replication, that meant:

- `wal_level = logical` on the publisher
- a publication on the schema I wanted replicated
- a subscriber with a base backup taken first (so the initial sync doesn't go through the replication slot itself), then a subscription created with `copy_data = false`

Getting a logical replica caught up without re-copying everything turned out to be the fiddly part. Stop Postgres on the subscriber, wipe the data directory, take a `pg_basebackup` from the publisher, start Postgres, then create the subscription against already-matching data. Skip that and the initial sync tries to copy every row through the slot, which is slow for anything non-trivial in size.

## Generating load and measuring lag

To actually stress both replicas, I ran scheduled UPDATE/DELETE queries against the publisher roughly every minute to force WAL generation, while keeping a long-running query open on each replica to hold back WAL replay (mimicking the kind of blocking query you'd actually see in production).

Lag was measured two ways:

```sql
SELECT
    application_name,
    EXTRACT(EPOCH FROM write_lag) AS write_lag_seconds,
    EXTRACT(EPOCH FROM flush_lag) AS flush_lag_seconds,
    EXTRACT(EPOCH FROM replay_lag) AS replay_lag_seconds,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lsn_distance
FROM pg_stat_replication
JOIN pg_replication_slots ON application_name = slot_name
WHERE state = 'streaming';
```

and on the subscriber side, for logical replication specifically:

```sql
SELECT received_lsn, last_msg_send_time, last_msg_receipt_time,
       latest_end_lsn, latest_end_time,
       EXTRACT(EPOCH FROM (now() - latest_end_time)) AS lag_sec
FROM pg_catalog.pg_stat_subscription;
```

## What the numbers showed

On a one-minute burst of updates, the logical replica stayed under 30 seconds of lag and around 800 MB behind. The physical replica on the same workload hit 74 seconds and over a gigabyte behind. On a longer, heavier burst (around 10 million update statements over several minutes), the gap widened further — the logical replica topped out near a minute of lag, while the physical replica reached close to 7 minutes.

So logical replication won on lag, clearly. But the two behaved differently under the blocking query, which is the part that actually mattered for the decision:

- The physical replica's WAL replay simply paused while the blocking query ran, then caught up immediately once the query finished. Predictable, bounded, easy to reason about.
- The logical replica kept applying changes in the background regardless of the blocking query, but disk usage on the publisher spiked during the heavy update burst and only came back down gradually, presumably from WAL retained for the replication slot. If a logical subscriber falls behind or disconnects, WAL piles up on the publisher until it catches up — there's no automatic bound on that the way there is with a replica that just pauses.

## The actual tradeoff

Lower lag isn't free. Physical replication's failure mode is boring: a slow replica stays predictably behind and catches up when the blocker clears. Logical replication's failure mode is a slot that can quietly accumulate retained WAL on the primary if the downstream subscriber can't keep up — which is a much worse thing to discover during an incident than "the replica is a bit stale."

We ended up keeping physical replication for the standard DR/read-replica use case, and only reaching for logical replication where we specifically needed selective, schema-level replication (for example, feeding a downstream analytics database without replicating the whole cluster). It's not a strict upgrade over physical replication — it's a different tool with a different risk profile, and the lower lag number alone isn't a reason to switch.

A few things worth knowing going in if you try this:

- DDL isn't replicated automatically. Adding a column means running the DDL on both sides and then running `ALTER SUBSCRIPTION ... REFRESH PUBLICATION`.
- Tables without a primary key or replica identity need explicit handling before they'll replicate correctly.
- Renaming schemas downstream, or changing column types, needs testing per case — it's not guaranteed to just work.

None of this makes logical replication a bad choice. It just means you should pick it for what it's actually good at (selective sync, feeding data pipelines) rather than as a drop-in lower-lag replacement for physical replication.
