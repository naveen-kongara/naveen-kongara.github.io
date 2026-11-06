---
title: "Evaluating predictive autoscaling tools for Kubernetes"
description: "Why two off-the-shelf predictive autoscaling tools didn't work for us, and what we built instead."
date: "Sep 16 2024"
---

Normal horizontal pod autoscaling reacts to load that's already happening. By the time CPU or request count crosses a threshold, the application has already been under pressure for a bit. We wanted something that could scale pods up before that pressure hit, based on predicted load rather than current load.

We looked at two third-party options first.

The first was a managed prediction service that could forecast any metric and feed that forecast into scaling decisions. In practice the predictions weren't accurate enough to trust, and it didn't support the application performance metrics (like request duration) we actually cared about — only infrastructure-level metrics.

The second was a third-party autoscaling tool that combined APM and non-APM metrics into its predictions. This one had a different problem: low trust in the setup after running into several issues getting it working reliably, and the model itself was a black box. When it scaled something unexpectedly, there was no way to see why. For something sitting in the path of production capacity decisions, "trust us" isn't good enough — we needed to be able to explain any scaling action after the fact.

Both failures pointed at the same requirement we hadn't written down explicitly until then: whatever did this needed to be inspectable. We wanted to know why a scaling decision happened, not just that it happened.

So we built an in-house prediction service instead. The design was straightforward: scrape the same metrics (CPU, memory, P99 request duration, request rate) that normal autoscaling would use, feed a window of recent history into a time-series forecasting model, and expose the predicted pod count through an API that our autoscaler (KEDA) could call on a schedule.

For the model itself, we tried two approaches:

- **Holt-Winters** (a classic exponential smoothing method) — accuracy was too low to rely on.
- **Prophet** — noticeably better accuracy on our traffic patterns, and we went with it.

The pipeline runs on a tight loop: a scraper thread pulls the last 60 seconds of metrics from Prometheus and from Elasticsearch every 20 seconds, writing into a per-service metrics table. A separate prediction thread runs every 60 seconds per service/resource pair, pulls training data, runs it through the model, and writes a 5-minute-ahead prediction. An API endpoint does the final conversion from "predicted load" to "pods needed," using each service's known per-pod capacity for that resource.

We set a hard bar going in: prediction accuracy above 95%, since a confident wrong prediction is worse than no prediction — it either scales something up for load that never arrives, wasting cost, or fails to scale ahead of load that does arrive, which defeats the entire point of doing this predictively instead of reactively.

We also built a dashboard comparing predicted vs. actual load per service, specifically so anyone could look at a scaling event after the fact and see whether the prediction that drove it was reasonable. That visibility was the thing both third-party tools were missing, and it ended up being as important as the model accuracy itself.

The bigger takeaway wasn't really about Prophet vs. Holt-Winters. It was that for something making automated decisions about production capacity, being able to explain a decision after it's made is a requirement, not a nice-to-have — and that requirement alone ruled out both off-the-shelf options before accuracy was even the deciding factor.
