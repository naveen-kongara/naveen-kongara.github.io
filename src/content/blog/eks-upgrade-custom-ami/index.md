---
title: "An EKS cluster upgrade complicated by a custom machine image"
description: "A routine Kubernetes version upgrade almost ran into a node group that would have refused to boot, because of a custom machine image and a cgroup change two versions ahead."
date: "Jul 08 2026"
---

We run a rolling upgrade program across our Kubernetes clusters: when a version is approaching the end of standard support, we stand up a new cluster on the newer version, validate it, and move workloads over rather than upgrading the live cluster in place. Staying on an unsupported version isn't free either — the cloud provider charges extended-support pricing per cluster per month once standard support ends, so there's a real cost to dragging your feet, on top of the security argument.

This round was a two-minor-version jump, skipping a version in between. That detail matters more than it sounds like it should, because it means the cluster absorbs everything that changed in the skipped version too, on day one, whether you were paying attention to that version or not.

The change that actually mattered here was a cgroup behavior change. Starting from the version we were skipping over, the underlying container runtime removes default support for the older cgroup mechanism. If a node is still running on the old cgroup version, its kubelet simply won't start unless you explicitly tell it to tolerate that. Most of our node groups run the cloud provider's standard machine image, which had already moved off the old cgroup version on its own schedule, so this didn't touch them. One node group hadn't, because it wasn't running the standard image at all — it ran a custom image we'd built ourselves, for a reason that had nothing to do with Kubernetes versioning.

The reason that custom image existed: one of our workloads schedules long-running jobs with a large memory ceiling, and under the old cgroup mechanism, an out-of-memory event only kills the one process that triggered it. Under the newer cgroup mechanism, an OOM event kills every process sharing that cgroup. For a workload where one oversized job occasionally runs hot, the difference between "kill the one bad job" and "kill everything else running alongside it" is significant, so we'd deliberately stayed on the older behavior for that node group by building our own image rather than using the provider's standard one.

That same custom image, sitting on the old cgroup version to preserve the OOM behavior we wanted, was exactly what the new Kubernetes version would refuse to boot on by default. If we'd just run the upgrade without checking, that node group's nodes would never have joined the new cluster.

The fix had three parts, and all three had to land in the image before the upgrade could proceed:

1. Explicitly tell the kubelet to tolerate the old cgroup mechanism rather than refuse to start. This is clearly described as a temporary accommodation by the platform, not a long-term setting — it's a stopgap, not a destination.
2. Bump the container runtime itself, since the version right before this one is the last to support the older runtime generation, and our custom image likely still shipped it.
3. Audit the image's boot script for a couple of flags that had already been flagged for removal around this version — either one left in place would have blocked the kubelet from starting regardless of the cgroup fix.

We made all three changes and validated that the node group actually joined the new cluster cleanly, rather than assuming the flag alone would be enough.

The part I think is worth sitting with is that the underlying issue isn't really "a flag was missing." It's that a workload-level decision made for a good reason, a while back, quietly became a structural dependency that only surfaces when something unrelated changes two versions later. The durable fix isn't the compatibility flag — it's revisiting why that workload needs the whole cgroup killed together in the first place. If the memory limits on that workload were sized down, or the one large job were split into smaller pieces, the OOM blast radius under the newer behavior would stop being a problem, and that node group could move onto the same standard image everyone else already uses. We didn't do that work as part of this upgrade — we shipped the compatibility flag so the upgrade could proceed on schedule — but it's now a tracked follow-up rather than something we'll rediscover by surprise on the next version jump.

The rest of the upgrade followed the same shape as every cluster before it in this program: the new cluster stood up alongside the old one, validated independently, with workloads migrating over service by service rather than all at once, since the blast radius of getting this particular node group wrong was high enough to want each piece checked on its own before moving the next. The old cluster stayed fully live the entire time, which meant the actual risk of the migration itself stayed low — the risk that mattered here had already been found and dealt with before a single workload moved.
