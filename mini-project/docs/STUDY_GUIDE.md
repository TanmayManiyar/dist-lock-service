# Study Guide: Fault-Tolerant Distributed Lock Service

Read this top to bottom once, then use Section 9 (viva Q&A) to rehearse.

---

## 1. The problem in plain English

Imagine 10 workers that must not edit the same file at the same time. You need a **lock**: "only one holder at a time".

On one machine that is easy. In the cloud it is hard, because:
- the lock server can **crash** (then nobody can lock, or the lock is lost);
- the **network** can split, so two servers each think they are in charge (**split brain**) and hand the same lock to two people;
- a client can **freeze** (GC pause, slow network) while holding a lock, and wake up *after* the lock was given to someone else.

**Our project** (Topic 13) is a lock service like Google's *Chubby* or *etcd*. It stays correct and available when machines crash or the network splits.

Three ideas solve it:

| Problem | Solution | One-line meaning |
|---|---|---|
| Server crashes | **Replication** across 5 nodes | The lock table lives on 5 machines, not 1 |
| Replicas disagree / split brain | **Raft consensus** | Replicas vote; only a *majority* (3 of 5) can decide anything |
| Client dies holding a lock | **Lease (TTL)** | Lock auto-expires after a time limit |
| Frozen client wakes up late | **Fencing token** | Each grant gets a bigger number; the resource rejects old numbers |

---

## 2. Concepts you must know

**Replica / node**: one server process. We run 5.

**Quorum / majority**: with N=5, majority = 3 (`Math.floor(5/2)+1`, the `MAJORITY` constant at the top of `replica.js`). Any two majorities overlap in at least one node, so two conflicting decisions can never both get a majority. That is the whole reason split brain is impossible. With 5 nodes you survive **2 failures**.

**Raft** is a consensus algorithm. It makes all replicas agree on one ordered **log** of commands. Three roles:
- **Leader**: the only node that accepts client writes. Sends **heartbeats** every 120 ms.
- **Follower**: copies the leader's log. If it stops hearing heartbeats, it starts an election.
- **Candidate**: a follower asking for votes.

**Term**: a counter that increases each election. Like "president #7". A node seeing a higher term immediately steps down. Stale leaders are thereby cancelled.

**Log**: ordered list of commands (`acquire A`, `release B`...). If every replica applies the same commands in the same order, every replica ends up with the same lock table. This is a **replicated state machine**.

**Commit**: an entry is committed once a majority has stored it. Only then is it applied and acknowledged to the client. A committed entry is never lost, even if the leader crashes.

**Lease**: a lock with an expiry time (`ttlMs`). Renewing extends it.

**Fencing token**: a counter incremented on every successful grant. Lock for key X granted to A with token 7, later to B with token 8. The protected resource remembers the highest token seen and **rejects any write with a lower token**.

> Why leases alone are not enough: A's lease expires while A is frozen. B gets the lock. A wakes up *thinking it still holds it* and writes. Only the resource can stop this, hence fencing tokens.

---

## 3. Architecture (files and what each does)

```
Browser dashboard (public/)  ->  Gateway (server.js, :8080)  ->  5 replicas (replica.js, :7001..7005)
                                       |                              |
                              fault injection,                 Raft + lock state machine
                              leader discovery,                 + disk (data/nodeX.json, .wal)
                              demo "protected resource"
```

| File | Role |
|---|---|
| [replica.js](../replica.js) | **One replica.** Raft (election, replication, commit) + lock state machine + disk persistence. The core of the project. ~370 lines. |
| [server.js](../server.js) | **Gateway.** Spawns the 5 replicas as child processes, finds the leader, forwards client requests, injects faults (kill/partition), hosts the fenced-resource demo, serves the dashboard. |
| [public/](../public) | Dashboard UI (HTML/JS/CSS) showing nodes live and buttons for faults. |
| [test.js](../test.js) | Smoke test: 10 checks (election, exclusion, failover, expiry, partition, heal). |
| [test-chaos.js](../test-chaos.js) | Randomised stress test with a safety checker (proves no two holders overlap). |
| [bench.js](../bench.js) | Measures latency, throughput, failover time for 3/5/7 nodes. Output in [BENCHMARKS.md](BENCHMARKS.md). |
| Dockerfile, docker-compose.yml, docs/DEPLOYMENT.md | Running replicas on separate VMs (VPC/cloud part). |

Zero dependencies: plain Node.js `http`, `fs`, `fetch`. Replicas talk to each other over HTTP/JSON.

---

## 4. Code walkthrough: `replica.js` (the replica)

### 4.1 Setup (top of the file)
Reads `id`, cluster size, data dir from argv. `peers` = the other 4 ids. `MAJORITY` = 3. Timers: heartbeat 120 ms, election timeout random 600-1100 ms (randomness prevents everyone becoming candidate at once). `cfg` holds `prevote` and `checkQuorum` toggles.

### 4.2 Persistence (`loadDisk()` and `persist()`): survive crashes
Raft requires `term`, `votedFor` and the `log` to survive a restart.
- `node<ID>.json` = `{term, votedFor}`, written to a temp file then **renamed** (atomic, so never half-written).
- `node<ID>.wal` = write-ahead log, **append-only**, one JSON entry per line.
- `loadDisk()` rebuilds state on start; a torn last line (crash mid-write) is ignored.
- `DURABLE=1` adds `fsync` (forces data onto the physical disk; slower, see benchmarks).

### 4.3 Lock state machine (`applyCmd()`): the actual lock logic
`applyCmd(cmd)` is a **pure, deterministic** function of the command and current state:

- **acquire**: if a lock exists and `expiresAt > cmd.now`: same owner gets it again (re-entrant), anyone else gets `held`. Otherwise grant: `token = ++sm.fence`, store `{owner, token, expiresAt = now + ttl}`.
- **renew**: only the current owner with the matching token, only if not expired, extends the expiry.
- **release**: only owner + matching token deletes it.
- **sweep**: deletes every expired lock.

**Key design point:** the time `now` is stamped by the leader *inside the command* (built in the HTTP handler for `/client/*`), not read by each replica. If every replica read its own clock, they would disagree about expiry and diverge. Carrying the time in the log keeps all replicas identical.

`applyCommitted()` applies log entries up to `commitIndex` in order, and answers the waiting client request.

### 4.4 Role transitions (`stepDown()`, `becomeLeader()`)
- `stepDown(term)`: adopt a higher term, clear vote, become follower, fail any pending client requests with `leadership-lost`.
- `becomeLeader()`: initialise per-follower trackers (`nextIndex`, `matchIndex`) and append a **no-op entry** in the new term. Raft can only commit entries from the current term, so this no-op lets the new leader safely commit older entries.

### 4.5 RPCs and handlers (`rpc()` and `raftHandlers`)
`rpc()` sends a POST with a 300 ms timeout; returns `null` on failure or if the peer is in the `blocked` set (this is how partitions are simulated).

Three handlers:
1. **`/raft/prevote`**: "would you vote for me?" without changing anything. Refuses if a leader was heard recently or my log is behind. This stops an isolated node from inflating its term and disrupting the cluster when it rejoins.
2. **`/raft/vote`**: standard RequestVote. Grants if same term, haven't voted for someone else, and the candidate's log is at least as up to date (`upToDate()`). That rule guarantees a leader always has every committed entry.
3. **`/raft/append`**: AppendEntries, doubles as heartbeat. Rejects stale terms; resets the election timer (leader is alive); checks the **consistency check** (`prevLogIndex/prevLogTerm` must match, else returns a hint to back up); truncates conflicting entries, appends new ones, persists, and advances `commitIndex` to the leader's.

### 4.6 Election (`tryElection()`)
When the election timer fires (checked in the 120 ms `setInterval`): 
1. **PreVote round** (if enabled). Need a majority of "yes" or give up.
2. Increment term, vote for self, become candidate, persist.
3. Ask all peers for votes. If a majority (including self) grant, `becomeLeader()`. If someone has a higher term, step down.

### 4.7 Replication and commit (`propose()`, `replicate()`, `advanceCommit()`)
- `propose(cmd)`: only the leader. Appends `{term, cmd}` to its log, persists, stores a promise in `pending`, calls `broadcast()`. Resolves when that entry commits (or `timeout` after 3 s).
- `replicate(p)`: sends the follower the entries from `nextIndex[p]`. On success updates `matchIndex`, on failure backs `nextIndex` up using the hint (this is how a lagging or wiped follower catches up).
- `advanceCommit()`: finds the highest index stored on a majority **and from the current term**, sets `commitIndex`, applies it. This is the moment the client is answered.
- `hasQuorumLease()`: has a majority acknowledged within 1.5 s? Used for reads and for check-quorum.

### 4.8 Timers (the `setInterval` blocks)
- Every 120 ms: leader broadcasts heartbeat and runs **check-quorum** (steps down if it cannot reach a majority: prevents a cut-off leader acting as leader). Followers check whether the election deadline passed.
- Every 300 ms: leader proposes a `sweep` command if any lock has expired. Expiry goes through the log so every replica deletes the same locks.

### 4.9 HTTP API (the `http.createServer` handler)
`/raft/*` internal; `/client/acquire|renew|release` turn the request into a command and call `propose`; `/client/locks` returns the table only if `hasQuorumLease()` (so a stale leader never serves stale reads); `/status` for the dashboard; `/admin/*` for fault injection (`block` = partition, `crash`, `wipe`, `config`).

### 4.10 Crash simulation (`crash()` and `boot()`)
`crash()` drops all in-memory state; `boot()` reloads from disk only: `commitIndex=0`, `sm` empty. The state machine is then **rebuilt by replaying the log** as the leader re-commits. That is crash recovery.

### 4.11 Logging (`log()`)
Every replica writes structured log lines through `log(src, level, message)`: elections and votes, `AppendEntries`, `COMMIT`, the lock decision applied by every replica (`logApply()`), write-ahead-log writes, crashes and recovery. Each line is printed to the process's own stdout and kept in a small buffer served at `GET /logs`. The gateway merges all five buffers with its own lines and serves them at `GET /api/term`, which is what the dashboard's **live backend terminal** shows. Heartbeats are recorded only when the "heartbeats" box is ticked, because they are very chatty.

---

## 5. Code walkthrough: `server.js` (gateway)

- **Spawns replicas** (`startNode`) as child processes; `REMOTE_NODES` mode instead talks to replicas on other VMs.
- **`call(id, route, body)`**: HTTP helper with 4 s timeout.
- **`statuses()`** polls every node's `/status`; **`currentLeader()`** picks the highest-term leader.
- **`viaLeader()`**: *leader discovery*. Try cached leader, else probe all. If node replies `not-leader` with a hint, follow it. Retries up to 5 times with 250 ms gaps. Retries on `leadership-lost`/`timeout` only for idempotent ops (acquire/renew, not release).
- **Fenced resource** (`/api/resource/write`): keeps `maxToken` per key; **rejects `token < maxToken`**. This is the demo of fencing.
- **Fault injection**: `/api/fault/kill|restart|partition|heal|wipe`. Partition = tell each node a list of peers to ignore (`applyPartition`).
- Serves the dashboard files from `public/`.

---

## 6. End-to-end flows (trace these in your head)

### A. Normal acquire
1. Client `POST /api/acquire {key, owner, ttlMs}` to the gateway.
2. Gateway finds the leader, forwards to `/client/acquire`.
3. Leader builds command `{type:'acquire', key, owner, ttlMs, now}` and `propose()`s it: appended to its log + disk.
4. Leader sends AppendEntries to the 4 followers; they persist and ack.
5. After 2 acks (+ leader = 3/5) `advanceCommit()` commits it.
6. `applyCommitted()` runs `applyCmd` -> token N granted -> promise resolved.
7. Client gets `{ok:true, token:N, expiresAt}`. Followers apply the same entry on the next heartbeat, so all 5 tables match.

If someone else holds it: same path, but `applyCmd` returns `{ok:false, error:'held'}`. (Even the "no" goes through the log, so the answer is consistent.)

### B. Leader crashes
1. Followers stop receiving heartbeats; election timer (600-1100 ms) fires on the first one.
2. PreVote passes (no recent leader) -> term+1 -> RequestVote -> 3 votes -> new leader, appends no-op.
3. Gateway's cached leader fails -> re-probes -> finds the new one.
4. Lock held by A is still there, because it was committed on a majority before the crash. Measured failover: **~0.8-1.1 s** (benchmarks).

### C. Network partition (leader isolated)
- Majority side (4 nodes) elects a new leader and keeps working.
- The old leader can't reach a majority: `hasQuorumLease` is false -> it **steps down** (check-quorum) and refuses reads. Even if it didn't, its writes can't reach a majority so can't commit.
- On heal, the old leader sees a higher term, steps down, its uncommitted entries are **truncated** (in the `/raft/append` handler), and it catches up. One leader, no split brain.

### D. Lease expiry
Leader's 300 ms sweeper notices an expired lock -> proposes `sweep{now}` -> committed -> every replica deletes it. The next `acquire` gets a **higher** token.

### E. Fencing demo
A acquires (token 7), writes to resource (max=7), stalls. Lease expires, B acquires (token 8), writes (max=8). A wakes and writes with token 7 -> **rejected: stale token (7 < 8)**.

### F. Replica restart / disk wipe
Restart: `loadDisk()` restores term/vote/log; it rejoins as follower. Wiped disk: empty log; leader's `replicate` backs `nextIndex` down to 1 and resends the whole log until it catches up.

---

## 7. Safety guarantees and *why* they hold

| Guarantee | Reason |
|---|---|
| One leader per term | Each node votes once per term; leader needs a majority; two majorities overlap |
| No lost committed lock | Committed = on a majority; any new leader must win votes from a majority, and the log up-to-date check ensures the winner has that entry |
| Mutual exclusion | Single ordered log + deterministic `applyCmd` + time stored in the command |
| No stale reads | Reads need a recent majority ack (quorum lease) |
| No split brain | Minority side can't commit or elect; check-quorum makes old leader step down |
| Stale client can't corrupt | Fencing tokens checked at the resource |
| Survives restart | term/vote/log on disk with atomic rename + append-only WAL |

**Honest limitations** (mention proactively, examiners like this): leases rely on roughly synchronised clocks only at the leader (that's why the leader stamps time); single leader limits write throughput; whole log is replayed on restart (no snapshots/compaction); membership is fixed at 5; replicas are HTTP/JSON, not an optimised binary protocol; loopback benchmarks are not cloud numbers.

---

## 8. How we tested and measured

- `npm test` ([test.js](../test.js)): leader elected; A acquires; B denied; kill leader -> new leader; lock survives failover; lease expiry lets B in; tokens strictly increase; partition -> majority elects new leader and serves writes; heal -> exactly one leader and converged state.
- `node test-chaos.js` ([test-chaos.js](../test-chaos.js)): 8 clients hammer 3 keys for 60 s while random kills, restarts, leader isolations and 3|2 splits happen. Then checks: **no overlapping grants** (history checker), tokens unique, every acknowledged grant durable, all logs identical, exactly one leader, service still live.
- `node bench.js` ([BENCHMARKS.md](BENCHMARKS.md)): ~30 ms per op (dominated by the 120 ms-tick/HTTP path), ~4000 ops/s at 32 clients, failover ~0.8-1.1 s independent of cluster size; fsync cuts throughput heavily at high concurrency (219 vs 3616 ops/s).

Run it yourself before the demo:
```bash
npm run fresh      # terminal 1, open http://localhost:8080
npm test           # terminal 2
```

---

## 9. Viva questions and short answers

1. **What is the project?** A Chubby/etcd-style distributed lock service: 5 Raft-replicated nodes provide leases and fencing tokens, tolerating 2 node failures and network partitions.
2. **Why 5 nodes?** Majority is 3, so up to 2 can fail. 3 nodes tolerate only 1; more nodes slow commits (benchmarks).
3. **What is Raft in one sentence?** An algorithm making replicas agree on one ordered log through leader election and majority-acknowledged replication.
4. **What if the leader dies?** Followers time out, run an election, a node with an up-to-date log wins a majority, committed locks are preserved. ~1 s.
5. **What is split brain and how do you avoid it?** Two nodes both acting as leader. Avoided because leadership and commits both need a majority, and two majorities overlap; terms invalidate old leaders; check-quorum makes isolated leaders step down.
6. **Why fencing tokens if you already have leases?** Leases are time-based; a paused client can outlive its lease. The token lets the *resource* reject it.
7. **Why put `now` inside the command?** So all replicas apply identical, deterministic logic; per-replica clocks would diverge.
8. **What is PreVote?** A dry-run vote that changes no state, so a partitioned node can't keep raising its term and force a healthy leader to step down when it returns.
9. **Why a no-op on becoming leader?** Raft only commits entries of the current term by counting replicas; the no-op commits and thereby also commits earlier-term entries.
10. **How does a lagging follower catch up?** `nextIndex` backs up using the failure hint until logs match, then the leader streams entries (64 per message).
11. **How do you handle a crash mid-write?** WAL is append-only; a half-written last line is discarded on load; term/vote file uses write-temp-then-rename.
12. **What does the gateway do?** Leader discovery/retry, fault injection control plane, fenced-resource demo, dashboard hosting. It holds no lock state.
13. **How does this map to the cloud topic?** Underlying primitives are VM cluster + VPC: each replica is a VM across availability zones, Raft ports private inside the VPC, only the gateway public (see [DEPLOYMENT.md](DEPLOYMENT.md), `NODE_ADDRS` / `REMOTE_NODES`).
14. **Limitations?** See end of Section 7.

---

## 10. Suggested 5-minute demo script

1. Open `http://localhost:8080`: point at 5 nodes, one LEADER, same term.
2. Acquire lock `file1` as Alice -> token 1. Try as Bob -> denied (mutual exclusion).
3. **Kill the leader** -> watch a new election and the lock still held (fault tolerance).
4. **Isolate the leader** / split cluster -> majority keeps serving, minority can't; **Heal** -> one leader.
5. Run the **fencing demo** -> stale write rejected.
6. Show `npm test` passing and the chaos test summary / benchmark table.
