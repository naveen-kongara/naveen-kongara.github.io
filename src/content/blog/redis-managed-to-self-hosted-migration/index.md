---
title: "Moving off managed Redis to self-hosted"
description: "Why we moved several production Redis caches off a managed service, what the benchmarks showed, and how the migration was actually done."
date: "Mar 27 2025"
---

We were running close to a dozen Redis instances on a managed cache service, one per service or use case: session storage, a shared cache used by background jobs, a datastore for a catalog service, and a few smaller ones. The managed service worked fine, but cost kept climbing as instance sizes grew, and we had almost no control over tuning things like memory allocation or defragmentation behavior. So we looked at moving to self-hosted Redis on our own EC2 instances.

Before committing to anything, we benchmarked self-hosted Redis against the managed service on equivalent instance types. The results weren't a clean win for self-hosted:

- Latency was slightly higher on self-hosted, though the difference was small in absolute terms.
- Throughput was a little lower too.
- Memory fragmentation was noticeably worse on self-hosted out of the box.

That fragmentation gap mattered. Redis's `activedefrag` setting helps here, but the standard Redis Stack Docker image we initially tried isn't compiled with jemalloc, which `activedefrag` depends on to actually do anything useful. We ended up building a custom image: take the jemalloc-enabled `redis-server` binary from the regular `redis:7.2` image and drop it into the Redis Stack image, keeping the modules (JSON support, search, etc.) we needed. That combination gave us active defragmentation without losing the features we were using.

On architecture, we considered a few options:

- Redis + Sentinel with a replica for every master. Highly available, automatic failover, but doubles the instance count and cost.
- Standalone Redis with no replicas, relying on AOF persistence and periodic snapshots for recovery. Cheap and simple, but no real HA — one node down means downtime.
- Something in between: masters on dedicated instances, replicas consolidated a few to a box.

We went with master-slave pairs plus Sentinel for quorum, but didn't give every single master-replica pair its own two instances. Some replicas were packed together on shared instances, split out with cgroup-based memory limits so one noisy replica couldn't starve the others. That got us most of the availability benefit of full replication without doubling our EC2 footprint.

The actual migration had to happen with zero downtime, since these caches backed live production traffic including session data. We used RIOT (Redis I/O Tool), which supports live replication between two Redis endpoints — point it at the old managed instance as source and the new self-hosted instance as target, and it streams keys over continuously while both stay in sync. The cutover process per service looked like:

1. Enable keyspace notifications on the source so RIOT can track live changes.
2. Start RIOT in live replication mode between old and new.
3. Pause background job queues briefly so nothing was mid-write during cutover.
4. Flip the service's Redis connection config to the new endpoint and redeploy.
5. Resume job queues, verify things were reading and writing correctly.
6. Stop the RIOT replication once we were confident.

For one of the larger caches, we had to migrate 16 logical databases inside a single Redis instance, each mapped to a different service or feature. Rather than running RIOT by hand 16 times, we scripted it — one background process per database number, each logging to its own file, so we could watch them all progress and stop any single one if something looked wrong.

A few things stood out after this was done. First, for workloads where sub-millisecond-level consistency isn't critical, the latency gap we measured never actually showed up as a user-facing problem — it mattered far less than the benchmark numbers suggested it might. Second, the real win wasn't really about raw performance; it was that we could now size instances exactly to what each cache needed instead of paying for a managed service's fixed tiers, and we could tune things like max memory policy and defrag thresholds per use case instead of accepting one-size-fits-all defaults.

If I were doing this again, I'd spend less time comparing benchmark numbers upfront and more time figuring out the defragmentation and jemalloc question early, since that ended up being the thing that actually changed our architecture decision.
