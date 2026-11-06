---
title: "Why an inventory service kept crash-looping under normal load"
description: "A service that handled high write and read volume started crash-looping. The cause was stale Postgres statistics on a table where most rows shared one indexed value."
date: "Dec 04 2025"
---

Starting one afternoon, response times on one of our busier API endpoints went from under 500ms to several seconds. The endpoint reads from a large table — tens of millions of rows — filtered by an indexed column. Slower responses on that endpoint backed up request queues, which eventually caused pods to restart and crash-loop.

The first thing we checked was whether anything had changed recently. Nothing had. What had changed was the data. A background worker runs every night and updates roughly 100,000 rows, overwriting the value of that indexed column. Run every night for long enough, and the distribution of values in that column shifts a lot: by the time we looked, about 64% of all rows in an 88-million-row table shared a single value in that column, and another 21% had it set to null. Only a small fraction of rows still had genuinely unique values.

Postgres' query planner decides whether to use an index scan or a sequential scan based on how selective it expects a filter to be, using statistics gathered by autovacuum's ANALYZE step. Those statistics hadn't kept pace with how skewed the column had become. The planner was still estimating that filtering on this column would return a small number of rows — reasonable for a column that used to have mostly unique values — so it kept choosing index scans even in cases where, given the actual current distribution, a sequential scan would have been faster, or where the estimate was simply wrong in the other direction and an index scan that should have been cheap was returning for a value that now matched over half the table.

Autovacuum does trigger ANALYZE automatically, but the threshold is based on a fraction of the table size. On an 88-million-row table, that threshold is large, and the nightly update of 100K rows didn't come close to crossing it quickly enough to keep the statistics representative of a column whose shape was changing that fast.

There was a second factor. Part of the application code used Rails' `.first` method on queries against this table, which adds an implicit `ORDER BY id`. Combined with stale statistics, this discouraged the planner from using the index that would otherwise have helped, pushing more queries toward scans that touched far more rows than necessary.

The immediate fix was a manual `ANALYZE` on the table, which restored normal query performance right away — the planner started making reasonable decisions again as soon as it had current statistics. We also replaced the `.first` calls with `.take`, which doesn't add the ordering clause and matched what the query actually needed.

For the longer term, three changes went in:
- A lower `autovacuum_analyze_scale_factor` for this specific table, so ANALYZE triggers much sooner relative to its size instead of waiting for a fraction meant for an average-sized table.
- Increased statistics target on the affected column, so the planner keeps a more detailed picture of its value distribution instead of a coarse one that misses the skew.
- Ongoing monitoring of how that column's value distribution changes over time, since a nightly job reshaping two-thirds of a table's rows in a single value is the kind of pattern that will cause this again if left unmonitored.

The broader lesson: table-level autovacuum settings tuned for an average table don't hold up once a table gets both very large and has a write pattern that skews a specific column's distribution quickly. A table that size needs analyze/vacuum thresholds considered on its own, not on Postgres' one-size-fits-all defaults.
