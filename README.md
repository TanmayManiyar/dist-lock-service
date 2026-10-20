# Fault-Tolerant Distributed Lock Service

A Chubby / etcd-style lock coordinator built from scratch (Node.js, zero dependencies).
Five replicas run Raft consensus; a lock state machine on top provides **leases** and **fencing tokens**.

## Run

Requires Node 18+.

```bash
npm run fresh      # start gateway + 5 replicas with clean data (npm start keeps data)
# open http://localhost:8080
npm test           # in a second terminal: crash / partition / failover checks
```

## What you can do in the dashboard

- Watch roles, terms and log indexes of the 5 replicas live.
- **Kill / restart** any node, **isolate the leader**, **split the cluster**, **heal the network**.
- Acquire / renew / release locks as named clients and see the fencing token.
- Run the **fencing demo**: a stalled client's stale write is rejected by the protected resource.

## Virtual Lab

Open **http://localhost:8080/lab/** for the IIT-style virtual lab (Aim, Theory, Pretest, Procedure, Simulation, Posttest, References, Feedback).
The Simulation tab embeds this real cluster plus a lab panel that gives guided steps, checks each step automatically, and offers protocol toggles (PreVote, check-quorum, election timeout) and a cluster reset.
All six experiments are built: 1 leases, 2 leader election, 3 log replication, 4 partitions, 5 fencing tokens, 6 crash recovery. Plan: [docs/VIRTUAL_LAB_PLAN.md](docs/VIRTUAL_LAB_PLAN.md).

## API (gateway, port 8080)

| Method | Path | Body |
|---|---|---|
| POST | `/api/acquire` | `{key, owner, ttlMs}` -> `{ok, token, expiresAt}` or `{ok:false, error:"held", holder}` |
| POST | `/api/renew` | `{key, owner, token, ttlMs}` |
| POST | `/api/release` | `{key, owner, token}` |
| GET | `/api/locks` | lock table (served by the quorum-confirmed leader) |
| GET | `/api/cluster` | node roles/terms/events |
| POST | `/api/resource/write` | `{key, token, owner, value}` - rejects stale tokens |
| POST | `/api/fault/kill`, `/restart` | `{id}` |
| GET/POST | `/api/config` | `{prevote, checkQuorum, electionMin, electionMax}` (lab toggles) |
| POST | `/api/reset` | wipe node data and restart a clean cluster |
| POST | `/api/fault/partition` | `{groups:[[1,2,3],[4,5]]}`; `/api/fault/heal` |

## Phase 2: tests, benchmarks, deployment

| What | Command | Details |
|---|---|---|
| Basic correctness + failover | `npm test` (server running) | `test.js` |
| Chaos / fault injection + safety checker | `npm run chaos` (or `chaos:quick`) | `test-chaos.js`: concurrent clients, random crashes, partitions and leader isolation; history checker verifies mutual exclusion, token uniqueness, durability, convergence, liveness |
| Benchmarks | `npm run bench` | `bench.js` -> [docs/BENCHMARKS.md](docs/BENCHMARKS.md); analysis in [docs/PHASE2.md](docs/PHASE2.md) |
| Docker (private network, one container per replica) | `npm run docker` | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (also AWS VPC/EC2 guide) |

## Design

See [docs/PHASE1.md](docs/PHASE1.md) (architecture, data flow, failure strategy) and [docs/architecture.svg](docs/architecture.svg).

Key points: Raft with PreVote and check-quorum, durable term/vote/log, leader no-op on election,
commands carry timestamps so the state machine is deterministic, lease expiry is replicated via `sweep` commands,
reads are served only by a leader holding a quorum lease.

## Known limitations (documented trade-offs)

- No log compaction / snapshots, no membership changes.
- Lease expiry assumes loosely synchronised clocks across replicas.
- Replicas are local processes standing in for VMs in a VPC; network partitions are simulated at the RPC layer.
