# Fault-Tolerant Distributed Lock Service (Mini Project)

A Chubby / etcd-style lock coordinator built from scratch in Node.js with **zero dependencies**.
Five replicas run the **Raft** consensus algorithm; a lock state machine on top provides **leases** and **fencing tokens**.
It keeps working when machines crash or the network splits, and it never hands the same lock to two clients.

This folder is the whole project. It runs completely on your own machine and needs nothing else.

## Run it

Requirements: **Node.js 18 or newer** (check with `node -v`). There is nothing to install.

```bash
npm run fresh      # start the gateway + 5 replicas with clean data
```

Then open **http://localhost:8080** in a browser.

| Command | What it does |
|---|---|
| `npm run fresh` | Start everything with a clean data folder (best for a demo) |
| `npm start` | Start everything, keeping the data from last time |
| `npm run demo` | Same as `fresh`, and opens the browser for you |
| `npm test` | 10 smoke / fault-injection checks (run it in a second terminal while the server is up) |
| `npm run chaos:quick` | 20 s randomised crash / partition stress test with a safety checker (starts its own cluster) |
| `npm run chaos` | The same for 60 s |
| `npm run bench` | Latency / throughput / failover benchmarks for 3, 5 and 7 replicas |

Press **Ctrl+C** in the terminal to stop the gateway; it stops all five replicas too.
Ports used: **8080** (dashboard + gateway) and **7001 to 7005** (replicas). If 8080 is taken, run with another port,
for example `PORT=8081 npm start` (macOS / Linux) or `$env:PORT=8081; npm start` (PowerShell).
Windows may ask once whether Node.js may use the network; allow it (it only talks to localhost).

## What runs on your machine

`npm start` launches **6 real Node.js processes**: the gateway (`server.js`) and five replicas (`replica.js`), one per node.
You can see them in Task Manager.

- The replicas talk to each other over real HTTP on localhost (votes, `AppendEntries`, acknowledgements).
- Each replica writes real files into `data/`: `nodeN.wal` (the write-ahead log) and `nodeN.json` (term and vote).
- The dashboard buttons act on those processes: **Kill N3** really kills that process, **Restart N3** really starts a new one that reloads its files and catches up, **Acquire** sends a real request through gateway, leader, followers and disk.
- **Network partitions** are injected in software: replicas are told to refuse to talk to certain peers. The effect on Raft is the same as unplugging a cable.
- All five replicas share one laptop here. They can also run on separate machines (see `docs/DEPLOYMENT.md`).

## The dashboard

One page, two sections.

- **Left: the steps.** A six-step walkthrough (look at the cluster, take a lock, be refused as another client, crash the leader, cut the network, fencing), each with a "why it matters" line and a glossary.
- **Right: the live system.**
  1. **Cluster:** the five machines, who leads, a "Break things" panel (crash a machine or the leader, isolate the leader, split 3 | 2, heal) and a table of every machine's term, log length and commit index.
  2. **Lock client:** acquire, renew and release locks as any client name, and see held locks with a lease countdown.
  3. **Fencing:** write to a protected storage with a token; run the stale-client demo.
  4. **Live backend terminal:** the real log lines printed by the gateway and each replica process, streaming live (see below).
  5. **Event log:** the same activity in plain English.

### The live backend terminal

Every line is a real log line from the running processes: client requests and leader routing, elections and votes, log replication
(`AppendEntries`), `COMMIT` on a majority, the lock decision each replica applies (`GRANTED`, `REFUSED`, `RENEWED`, `RELEASED`, `EXPIRED`),
write-ahead-log writes, fencing checks, crashes, restarts and partitions. The same lines also appear in the terminal that started the server.
Filter by area (Requests / Raft / Locks / Disk / Faults) or node, show per-heartbeat lines, pause, clear, or download the log as a text file.

## Show it to the examiner (about 8 minutes)

Open this folder in VS Code, then **Terminal > New Terminal** and run `npm run demo`. Put the browser next to the editor.

1. **The idea (30 s).** Locks must stay safe when machines crash or the network splits. The answer is 5 replicas, Raft consensus, leases and fencing tokens.
2. **The cluster.** Point at the ring: one gold leader, four followers, same term. Majority is 3 of 5, so it survives 2 failures. Show Task Manager: 6 `node.exe` processes. Show the `data/` folder in the IDE.
3. **Mutual exclusion.** Acquire `orders-db` as `client-A` (token 1). Acquire it as `client-B`: refused. In the terminal, filter **Locks** and show `GRANTED` on every replica, then `REFUSED, held by client-A`.
4. **Replication and commit.** Filter **Raft**: the leader appends to its WAL, sends `AppendEntries` to the four followers, and logs `COMMIT ... stored on 3/5 nodes (majority is 3)`.
5. **Leader crash.** Press **Crash the leader**. Task Manager loses a process, the terminal shows the election timeout, pre-vote, votes and `became LEADER`, and the lock is still held by client-A. About one second.
6. **Network partition.** **Isolate leader**: the majority side elects a new leader and keeps serving; the cut-off node cannot. **Heal network**: one leader, logs converge.
7. **Fencing.** Run the fencing demo: client-A freezes, its lease expires, client-B gets a higher token, and client-A's late write is **REFUSED**.
8. **Proof.** In a second terminal run `npm test` (all checks pass) and show `docs/BENCHMARKS.md`.

Then walk through the code: `replica.js` (Raft + lock state machine), `server.js` (gateway), `public/` (frontend). `docs/STUDY_GUIDE.md` explains every part in plain words and has viva questions.

## Folder map

| Path | What it is |
|---|---|
| `replica.js` | One replica: Raft (election, replication, commit), the lock state machine with fencing tokens, disk persistence, structured logging |
| `server.js` | Gateway: starts the replicas, finds the leader, routes client requests, injects faults, hosts the fenced-resource demo, serves the dashboard, collects the live log |
| `public/` | The frontend: `index.html`, `app.js`, `style.css`, `ui.css` |
| `test.js`, `test-chaos.js`, `bench.js` | Smoke test, randomised safety test, benchmarks |
| `docs/` | Architecture and data flow, study guide, demo script, benchmarks, deployment notes, diagrams |
| `deliverables/` | Feasibility study, report and architecture diagram for submission |
| `Dockerfile`, `docker-compose.yml` | Run the replicas as containers on a private network (the VPC analogue) |
| `data/` | Created at runtime: each replica's write-ahead log and term file (ignored by git) |

## API (gateway, port 8080)

| Method | Path | Body |
|---|---|---|
| POST | `/api/acquire` `/api/renew` `/api/release` | `{key, owner, ttlMs, token}` |
| GET | `/api/cluster` `/api/locks` `/api/resource` `/api/term?since=N` | |
| POST | `/api/resource/write` | `{key, token, owner, value}` (rejected if the token is older than the newest seen) |
| POST | `/api/fault/kill` `/api/fault/restart` `/api/fault/wipe` | `{id}` |
| POST | `/api/fault/partition` | `{groups: [[1,2,3],[4,5]]}` |
| POST | `/api/fault/heal` `/api/reset` | |
| GET / POST | `/api/config` | `{prevote, checkQuorum, electionMin, electionMax, fencing, trace}` |

Environment variables: `PORT`, `NODES`, `BASE_PORT`, `DATA_DIR`, `DURABLE=1` (fsync every write), `BASIC_AUTH=user:pass`,
`REMOTE_NODES` (replicas on other hosts).

## Guarantees

| Guarantee | How |
|---|---|
| Mutual exclusion | Every lock operation is a command in a Raft-replicated log; the state machine grants a lock only if no unexpired holder exists |
| Fault tolerance | 5 replicas, majority 3: survives any 2 crashes or a minority partition |
| No split brain | Elections and commits need a majority; check-quorum makes an isolated leader step down |
| Durability | term, vote and log are written to disk before replying |
| No dead locks | Locks are leases; a crashed client's lock expires and is swept through the log |
| Safe against stale clients | Strictly increasing fencing tokens; the protected resource rejects older ones |

## Moving this folder

The folder is self-contained: copy or move it anywhere that has Node 18+, open it in your IDE, and run `npm run fresh`.
Nothing refers to any other folder, and nothing is installed outside it.
