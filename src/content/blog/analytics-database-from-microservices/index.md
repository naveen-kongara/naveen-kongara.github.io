---
title: "A shared analytics database fed from microservice databases"
description: "Why we stopped running analytical queries against production and built a dedicated database synced in near-real-time instead."
date: "Feb 26 2025"
---

We run a handful of services, each with its own Postgres database. For a long time, anyone who needed data for a report or a dashboard just queried a read replica of whichever service owned that data. It worked until it didn't.

The problems showed up in a few predictable ways. A long-running analytical query on a replica could get killed by recovery conflicts whenever the primary caught up on WAL replay. Statement timeouts tuned for the production workload were too short for reporting queries, so people either ran queries directly against production (risky) or kept bumping timeouts on the replica (which just moved the risk). And the moment someone wanted to join data across two services — say, orders from one service with inventory from another — there was no clean way to do it; replicas only had their own service's data.

So we built a separate database whose only job is to hold a near-real-time copy of every service's tables, kept in sync continuously, that anyone can query without touching a production path at all.

### How it's kept in sync

Postgres logical replication does the actual work. Each service's primary database publishes a subset of its tables (we exclude internal bookkeeping tables like schema migration history), and the central database subscribes to each one independently. Every service gets its own schema in the central database — `old_schema`, `new_schema`, and so on — so table names never collide even though several services have tables with the same name.

Setting this up for a new service is roughly the same five steps every time:

1. On the service's primary, set `wal_level = logical` and raise `max_replication_slots` / `max_wal_senders` enough to handle another subscriber, then restart.
2. Create a replication role, grant it `SELECT` on the tables you want to publish, and create a `PUBLICATION` naming those tables.
3. On the central database, create a new schema for the service, create a publication-matching subscription, and create a read-only role scoped to just that schema via `search_path`.
4. Let the initial sync run — for a service with years of data this can take hours — and watch `pg_stat_replication` on the source and `pg_stat_subscription` on the target until it says it's caught up.
5. Re-enable any statement timeouts that were loosened for the initial sync, and only then point reporting tools at the new schema.

The one property that made this worth doing: once a subscription is caught up, the lag is usually seconds, not minutes. That's close enough to real-time that most dashboards can't tell the difference from querying production directly, without any of the replica recovery-conflict problems.

### What changed for people writing queries

Before this, someone building a report had to know which replica belonged to which service, what its naming quirks were, and hope their query wouldn't get killed mid-run. After, there's one place to go. A query against a single service's data looks like `select * from new_schema.customers;`. A query that needs two services' data in one join just references two schemas in the same statement — something that was flatly impossible before, since each replica only ever had one service's tables.

We mapped the old per-service replica data sources onto equivalent schemas in the new database, mostly so existing saved queries kept working without anyone having to rewrite them. New queries just use the central database directly.

### What I'd flag to anyone doing this

The mechanical setup is the easy part. The things that actually took iteration:

- Initial sync time scales with table size, and a service with a decade of history can take a database-disk-resize and a multi-hour wait before its publication is usable. Plan the rollout per service, not all at once.
- Logical replication only ships DML, not DDL. A schema migration on the source doesn't propagate automatically — you need a process (we automated ours as part of the migration tooling) to apply the equivalent change on the subscriber side, or replication breaks the next time a migrated table is touched.
- Decide upfront which tables genuinely need replicating. Publishing everything is tempting but blows up initial sync time and the surface area you have to keep schema-aligned forever.

A year in, this is the default place anyone goes for reporting, and the "don't query production for analytics" rule is finally something we can actually enforce instead of just asking people nicely.
