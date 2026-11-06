---
title: "Speeding up our UAT restore process by reusing production backup infrastructure"
description: "Replacing a full pg_basebackup copy for every UAT refresh with a delta restore from production's existing WAL archive."
date: "Sep 02 2026"
---

Every UAT refresh for our Postgres databases worked the same way: boot a dedicated point-in-time-recovery (PITR) EC2 instance that stays stopped between runs, open a physical replication slot against production, wipe the UAT data directory completely, stream a full `pg_basebackup` copy across, then shut the replica back down.

The problem is that this cost didn't scale down even when almost nothing had changed since the last refresh. A full base backup transfers every byte of the database every single time, whether one table changed or none did. And it required standing up a whole replica instance just to relay data that already exists somewhere else.

Production was already solving the "get a consistent copy of this data" problem for its own backup needs — continuous WAL archiving plus periodic base backups to S3 for disaster recovery. We were building a second, slower path to roughly the same place: a working copy of the database, except ours rebuilt itself from scratch every time.

The change was to restore UAT directly from that existing S3 archive instead of relaying through a PITR replica:

```
Before:  Prod DB -> PITR EC2 replica -> pg_basebackup stream -> UAT box
         (boot + wait, per DB)         (full wipe, full copy)

After:   Prod DB -> S3 WAL archive -> delta restore -> UAT box
         (already continuous)        (only changed files transfer)
```

We used pgBackRest pointed at production's WAL archive bucket, restoring straight into the UAT box. Two behaviors of pgBackRest made this safer than it sounds:

**Delta restore.** Instead of wiping the UAT data directory first, it checksums what's already on disk against the backup manifest and only pulls the files that actually changed. A box that hasn't been refreshed in a while still pays for something close to a full copy, but a box refreshed recently only pays for the drift since last time.

**Fail-safe ordering.** pgBackRest removes the cluster's control file at the start of a restore and only writes it back as the final step of a successful run. If a restore dies partway through — a network blip, a timeout — Postgres is left physically unable to start on the half-written directory, instead of silently booting something corrupted. The next attempt's delta restore picks up from whatever landed, rather than starting over.

That second point matters more than it looks. The old script used `rm -rf` on the data directory before copying. A failed run under that approach meant the next run paid for a full copy regardless, because there was nothing left to diff against. Under the new approach, a failed run just means a slightly smaller delta next time.

We validated the new pipeline against three different databases before treating it as the default for all UAT refreshes, which let us catch per-database quirks early rather than rolling it out everywhere at once.

Removing the PITR replica also moved the bottleneck. It used to be "how fast can a dedicated replica stream data." Now it's "how fast can this one UAT box pull and decompress from S3," which is a different set of knobs — parallel restore workers, I/O buffer size against S3, and how many databases restore at once on a box that no longer has a dedicated replica per database to spread the load across.

None of this required new infrastructure. The data path we needed was already being paid for and maintained as part of production's own disaster recovery setup — we just weren't using it for anything except production recovery. Restore tooling built for production backups is usually general enough to serve a second purpose like this, and it's worth checking before building a parallel system that does something similar, slower.
