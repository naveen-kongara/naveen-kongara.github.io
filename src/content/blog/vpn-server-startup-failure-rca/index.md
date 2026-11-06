---
title: "Why our self-hosted VPN servers got stuck in a restart loop"
description: "Three Pritunl VPN servers on one host failed to start after a restart and kept timing out at the same step. The cause was a zombie process holding a lock meant to be shared."
date: "Oct 26 2026"
---

We self-host VPN access using Pritunl. After a routine restart, three VPN servers on the same host failed to come back up. Each one hung at the same internal step — applying firewall rules — got killed by Pritunl's 5-minute startup timeout, retried, and hung again at the same step. This repeated in a loop until someone intervened.

Users connected to one of the affected servers got disconnected when it went down, and anyone trying to connect during the loop simply couldn't.

**Narrowing it down**

The first useful clue was that every failing server died at the exact same internal state — the step where Pritunl applies iptables rules — and every failure was exactly 5 minutes after the attempt started. That's not a random hang; that's something hitting the same lock or resource every time, and the timeout is the only thing ending it.

We ruled out a few obvious suspects quickly:
- The system-level iptables lock file had no holder — so it wasn't a lock held by some other process outside Pritunl.
- The iptables rule set itself wasn't unusually large — a few hundred lines, nothing that should take 5 minutes to apply.
- The database Pritunl uses for its own state was healthy and responsive.

What we did find: a defunct (zombie) `iptables` process, nearly 20 minutes old, sitting in the process list. Pritunl runs iptables commands one at a time behind its own internal lock, so every server trying to start has to wait its turn for that lock. If one of those commands finishes but Pritunl never collects its exit status, the lock never gets released, and everything behind it queues up forever — or until something times out and retries, making a fresh attempt at the same broken lock.

**Root cause (probable, not fully proven)**

All three servers happened to start within about 8 seconds of each other. Two child processes — the VPN process and the iptables command — were spawned around the same moment. The most likely explanation is a known issue in how old Python versions handle subprocess output pipes: if a second process inherits the same output pipe as the first, the parent can end up waiting forever for "end of output" that never actually arrives, because the pipe is still technically open from the other process's side. The iptables command had already exited, but Pritunl kept waiting on it as if it hadn't, and in doing so, kept holding the lock.

This host was running a legacy build of the VPN software on an old Python 2.x runtime — current releases don't use the code path that has this problem. That made it a meaningful contributing factor, not just bad luck: starting multiple servers at once makes the race far more likely, and an old runtime made the underlying bug reachable at all.

**Fix**

Restarting individual VPN servers did nothing, because the stuck thread and the zombie process belonged to the main service, not to any one server. A full restart of the VPN service cleared both:

```bash
sudo systemctl stop pritunl
sudo pkill -f 'openvpn /tmp/pritunl'
ps -ef | grep -E '[o]penvpn|[i]ptables|[p]ritunl'   # expect no output
sudo systemctl start pritunl
```

After that, we started the servers one at a time instead of all together, which avoided re-triggering the same race.

**What's next**

The real fix is upgrading off the legacy runtime and VPN build that has this subprocess-handling issue in the first place — that's tracked as follow-up work, not something to patch around indefinitely. In the meantime, starting servers sequentially rather than simultaneously removes most of the risk, and we added monitoring for two early warning signs: a server stuck at the firewall-rules startup step, and any defunct iptables process older than a few minutes. Either one on its own is a much cheaper problem to catch than three VPN servers stuck in a retry loop.
