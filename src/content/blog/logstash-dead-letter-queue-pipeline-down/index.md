---
title: "A dead-letter queue issue that took down our logging pipeline"
description: "How a single Logstash pipeline let a broken dead-letter-queue output block all application log shipping, and how splitting pipelines fixed it."
date: "Aug 26 2026"
---

We had one Logstash pipeline doing everything: reading application logs, and also reading its own dead-letter queue (DLQ) to republish failed events back to Elasticsearch. Both jobs were defined as separate `.conf` files, but Logstash was loading all of them into a single pipeline because `pipelines.yml` pointed at a glob (`path.config: "/etc/logstash/conf.d/*.conf"`).

That setup has a quiet failure mode. If the DLQ side can't reach Elasticsearch for any reason, Logstash applies back-pressure to the whole pipeline it belongs to. Since the DLQ reader and the real ingestion path were the same pipeline, a broken DLQ output stalled ingestion too. Application logs that had nothing to do with the DLQ stopped shipping and were lost, with no obvious error pointing at the cause.

We confirmed this in a test environment before touching anything in production. The reproduction was simple: point the DLQ output's Elasticsearch host/port at something unreachable, send a mix of well-formed and intentionally malformed log records through a generator script, and watch what happens. Result: nothing landed in either the normal index or the DLQ index. One broken output took the whole thing down.

The fix was to stop pretending this was one pipeline. We split it into three, declared explicitly instead of through a glob:

- `main` — real application log ingestion, with its own DLQ enabled
- `dlq-reader` — reads `main`'s dead-letter queue and republishes failed events per service
- `redis-slowlog-reader` — an unrelated log source that happened to share the same conf directory, isolated for the same reason

Each pipeline runs with its own worker pool and queue inside the same Logstash process, so a stuck output on one can't block the others.

First attempt at the fix didn't work. After rewriting `pipelines.yml` with three explicit pipeline definitions and restarting, only one pipeline came up. The cause was a leftover setting in `logstash.yml`: a global `path.config: /etc/logstash/conf.d/*` line. That setting overrides whatever `pipelines.yml` says and forces Logstash back into single-pipeline mode. Commenting it out and restarting again got all three pipelines running independently, which we confirmed with:

```
curl -s http://<host>:9600/_node/pipelines?pretty
```

That showed `main`, `dlq-reader`, and `redis-slowlog-reader` running separately, with `main` reporting `dead_letter_queue_enabled: true`.

Re-running the same failure simulation after the fix gave a different result. With the DLQ output still pointed at a bad port, well-formed logs landed in the normal index without any issue — `main` was unaffected. The `dlq-reader` pipeline itself stayed stuck, which is expected since its output was still misconfigured, but it no longer took anything else down with it.

What's still open is how `dlq-reader` behaves once its output is pointed back at something valid — whether it drains the backlog cleanly or needs a manual nudge. That's a smaller problem to have, since it's now contained to one pipeline instead of silently eating application logs.

The broader lesson: when a tool lets you bundle unrelated jobs into one execution unit for convenience (a glob config is easier to write than three explicit entries), you're also bundling their failure modes. Isolating pipelines by failure domain, not just by what's convenient to configure, is worth the extra lines in the config file.
