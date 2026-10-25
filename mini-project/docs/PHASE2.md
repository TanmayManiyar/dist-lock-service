# Phase 2 - Implementation, Fault-Injection Tests and Benchmarks

**Topic 13: Fault-Tolerant Distributed Lock Service.** Architecture and failure strategy are in [PHASE1.md](PHASE1.md); this document covers what was built and measured in Phase 2.

## 1. Implementation summary

| Component | File | Notes |
|---|---|---|
| Replica: Raft + lock state machine | `replica.js` | PreVote, check-quorum, leader no-op, pipelined AppendEntries, quorum-lease reads, fencing counter in the replicated state machine |
| Durable storage | `replica.js` | `term/votedFor` in an atomically renamed meta file; the log in an **append-only write-ahead log** (torn last line ignored on recovery); optional `DURABLE=1` = `fsync` every write |
| Gateway | `server.js` | leader discovery and caching, redirects, fault-injection control plane, fenced demo resource, optional basic auth |
| Simulated process crash | `replica.js` (`/admin/crash`, `/admin/start`, `/admin/wipe`) | lets the same fault buttons work for replicas on remote hosts / containers |
| Dashboard (frontend) with live backend terminal | `public/` | cluster view, fault injection, lock client, fencing demo, real log stream |
| Deployment | `Dockerfile`, `docker-compose.yml`, [DEPLOYMENT.md](DEPLOYMENT.md) | per-replica containers on a private network; AWS VPC/EC2 guide |

Changes made in Phase 2 to the Phase 1 design: the log moved from a rewritten JSON file to an append-only WAL (O(1) per entry instead of O(log size)); leader replication is pipelined (a new entry no longer waits for the next 120 ms heartbeat); the gateway caches the leader instead of probing every node on every request.

## 2. Fault-injection tests

### `test.js` - scripted scenarios (12 checks)
Leader election, mutual exclusion, lock survives leader crash, still exclusive after failover, lease expiry, strictly increasing fencing tokens, majority side serves under partition, single leader after heal, state converged after heal.

### `test-chaos.js` - randomised faults with a history checker
Eight concurrent clients acquire / renew / release locks on three keys (some clients "crash" while holding a lock) for 60 s while a chaos loop randomly: kills a random node, kills the leader, restarts nodes (never more than 2 down), isolates the leader, splits the cluster 3 | 2, and heals. Seeds make runs repeatable (`--seed=N`).

**Safety checker.** For each key, grants are ordered by fencing token. A grant's lifetime ends at the earlier of the time of its **first release attempt** (even if the client got an error back, because a release that timed out during a leader change may still have committed) and its **lease expiry**. Grant *n+1* must have been received *after* grant *n* ended; if not, two clients held the lock at once. This is a conservative check (it only uses information clients can observe), so it cannot produce false alarms from uncertain operations. (An earlier version of the checker only counted releases that were acknowledged; that produced false alarms in about half of the 40 s runs, when a release timed out but had actually committed. After the fix, the previously failing seeds 17 and 34 and a third seed all pass.)

Other checks after the chaos stops and the network heals: tokens are unique and each belongs to one key; the final counter on every node is at least the highest token ever handed out (acknowledged grants are durable); exactly one leader; identical, fully committed logs on all five nodes; a fresh acquire succeeds (liveness).

**Checker validated by mutation.** With the exclusion check removed from the state machine (`if (false && l && ...)`), the same test immediately reports dozens of overlaps, so a pass is meaningful.

### Results (this machine)

| Run | Duration | Grants checked | Result |
|---|---|---|---|
| seed 11 | 60 s | 427 | all checks passed |
| seed 22 | 60 s | 442 | all checks passed |
| seed 7 (quick) | 20 s | 168 | all checks passed |

Observed errors during chaos were only the expected `no-leader` and `leadership-lost` replies while elections were running.

**Not covered:** clock skew between replicas, message duplication/reordering below the HTTP layer, disk corruption, and Byzantine faults. Lease expiry assumes loosely synchronised clocks.

## 3. Benchmarks

Full tables: [BENCHMARKS.md](BENCHMARKS.md) (regenerate with `npm run bench`). Machine: i7-12700H, Windows 11, Node 24; replicas are local processes over loopback HTTP, so absolute numbers say little about a cloud deployment.

| Measure | Result | Reading |
|---|---|---|
| Latency (1 client, direct to leader) | ~30 ms p50, ~33-35 ms p95 for acquire and release | Identical for 3, 5 and 7 replicas and with fsync on/off. The ~30 ms floor is the per-request cost of HTTP over loopback with Windows timer granularity, not a protocol cost; it hides the (small) differences between configurations. |
| Throughput, 1 client | ~36-38 ops/s | = 1 / latency: a single sequential client is latency bound |
| Throughput, 32 clients, fsync off | ~3,600-4,300 ops/s | concurrency overlaps requests; entries are replicated in pipelined batches |
| Throughput, 32 clients, **fsync on** | ~220 ops/s | each entry costs a disk flush on the leader and each follower; this is the price of surviving power loss. Group commit (one fsync per batch) is the standard fix and is future work. |
| Cluster size 3 vs 5 vs 7 | no clear trend (within run-to-run noise) | on one machine with free loopback, extra acknowledgements cost little; on a real network, latency is set by the **median** replica round trip, so larger clusters tolerate more failures at a modest cost |
| Failover (leader killed to next successful acquire) | median ~0.84-1.07 s, max ~1.12 s | dominated by the 600-1100 ms election timeout + one vote round; independent of cluster size, as expected. Tunable via the election timeout (trade-off against false elections, Experiment 2). |

**Honest limitations of the measurements:** a single machine, 5 failover trials per configuration, no warm-up discarding, and a Windows timer floor. They are fit for comparing configurations against each other and for showing trends, not for claiming cloud performance.

## 4. Deployment

Tested: Docker Compose with five replica containers and a gateway on a private network (remote-mode fault injection, container restarts, full-cluster restart with the lock preserved, basic auth). The AWS EC2/VPC procedure is documented in [DEPLOYMENT.md](DEPLOYMENT.md) but has not been run on a real account.

## 5. Known gaps

No log compaction/snapshots (the log grows without bound), no membership changes, no group commit, no TLS/authentication on the replica API (private network only), no clock-skew tests, and the AWS guide is untested.
