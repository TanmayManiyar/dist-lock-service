# Demo Script: Fault-Tolerant Distributed Lock Service

About 10 minutes. **SAY** = speak. **DO** = click or type. **SHOW (backend)** = point at the live terminal panel on the dashboard (or the real terminal). **CONCEPT** = the idea behind the step, in plain words.

## Setup (before you start)

```bash
cd mini-project
npm run demo        # starts the gateway + 5 replicas with clean data, opens http://localhost:8080
```

- Browser: dashboard on one half of the screen. VS Code on the other half, with `server.js`, `replica.js`, `public/app.js` open and the `data/` folder visible.
- Task Manager: filter on `node.exe`. You should see 6 processes (1 gateway + 5 replicas).
- Top right of the page says a leader is elected and 5/5 nodes are up.
- Live terminal card: keep **details** ticked, **heartbeats** unticked.
- Keep **Lease** at `60000` for the fault steps so the lock doesn't expire mid-explanation.

---

## 1. The problem and the idea (1 min)

**SAY:** "Two programs updating the same bank balance at the same time will corrupt it. So before touching it, a program asks a **lock service**: 'can I have the lock?' It says yes to only one program. That is **mutual exclusion**.

But the lock service is now a single point of failure. If it crashes nobody can work, and if it goes wrong two programs get the same lock. So I built a lock service that runs on **five machines** that agree on every decision by voting, using an algorithm called **Raft**. It keeps working if two machines die or the network splits. Google's Chubby and the etcd database work the same way. It is plain Node.js with zero dependencies."

**CONCEPT: three building blocks**

| Term | Plain meaning |
|---|---|
| **Raft consensus** | Five machines keep one identical list of decisions. A decision counts only when a **majority (3 of 5)** has saved it. |
| **Lease** | A lock with a timer. If the client dies, the lock frees itself. Nobody is blocked forever. |
| **Fencing token** | A number that goes up with every grant. Storage rejects writes with an old number. This protects against a client that wakes up late. |

---

## 2. Live demo: frontend and backend together (6 min)

### Step 1. The cluster (45 s)

**DO:** Point at the ring in the **Cluster** card, then open **Details of each machine**.

**SAY:** "Five circles are the five replicas. Gold is the **leader**, blue are **followers**. The leader takes every request and the followers keep copies. **Term** is the election round number. **Commit** is how many log entries a majority has confirmed. All five rows match."

**SHOW (backend):** Task Manager (6 `node.exe`). In the IDE, open `data/`: `node1.wal` ... `node5.wal` and `node1.json` ... `node5.json`.

**SAY:** "These are real processes on real ports 7001 to 7005, talking to each other over HTTP. The `.wal` file is each machine's **write-ahead log**: it is written to disk before the machine replies, so a crash cannot make it forget. The `.json` file holds the term and who it voted for."

**CONCEPT: majority.** 3 of 5 must agree. Any two majorities share at least one machine, so two groups can never both make decisions. Five machines survive two failures.

### Step 2. Mutual exclusion (1 min 30 s)

**DO:** In **Lock client**: Resource `orders-db`, Client `client-A`, Lease `8000`. Click **Acquire**. The result shows OK and token 1, and the **Held locks** table shows a countdown bar.

**DO:** Change Client to `client-B`. Click **Acquire**.

**SAY:** "Refused. 'Held by client-A'. Only one holder at a time."

**SHOW (backend):** In the live terminal click the **Requests** chip.

**SAY:** "A button click is an HTTP request to the gateway: `POST /api/acquire`. The gateway doesn't know who leads, so it asks the nodes, forwards to the leader, and retries if leadership changes. The gateway holds no lock data. All state lives in the five replicas."

Now click **Locks**.

**SAY:** "Every one of the five replicas logs the same decision: `GRANTED fencing token=1`, then `REFUSED, held by client-A`. Five machines, same answer, because the lock table is a deterministic function of the shared log."

**DO:** Switch back to `client-A`, click **Renew**, then **Release**.

**CONCEPT: lease.** Only the owner with the right token can renew or release. If A does nothing, the lock expires after 8 seconds. The leader notices and records a 'sweep' in the log, so all replicas expire it at the same point.

### Step 3. How a lock is committed (1 min)

**DO:** Acquire again as `client-A`. In the terminal click **Raft**.

**SAY:** "Follow the request through the backend. The leader **appends it to its log** (`appended to my log as #N`) and sends `AppendEntries` to the four followers. Each follower saves it to its WAL and acknowledges. When the leader sees `COMMIT ... stored on 3/5 nodes (majority is 3)`, the lock is granted. Only then does the client get 'OK'."

**CONCEPT:** If a client was told it holds the lock, that fact is already on three machines. The leader can crash a millisecond later and the new leader still knows.

**SHOW (backend):** Click **Disk**: `appended 1 entry to node1.wal`.

### Step 4. Crash the leader (1 min 15 s)

**DO:** Click **Crash the leader**. Watch the ring. Then click **Faults** and **Raft** in the terminal.

**SAY:** "I've killed the leader's process. Watch: it goes grey. About a second later one node turns orange, then gold. The term goes up by one, and the lock is still in the **Held locks** table."

**SHOW (backend):** Task Manager lost one `node.exe`. The terminal shows `election timeout`, `pre-vote`, `election started for term N`, votes, then `became LEADER`.

**CONCEPT: leader election.** Followers expect a heartbeat every 120 ms. If a follower hears nothing for a random 600 to 1100 ms (random so they don't all start at once), it starts an election. A node only votes for a candidate whose log is at least as up to date as its own, so the new leader always has every committed lock. A **pre-vote** round comes first and changes nothing, so a lone cut-off node can't keep inflating the term.

**DO:** Click **Restart N?** for the dead node.

**SAY:** "It comes back as a follower, reloads its WAL from disk (`recovered from disk` in the log), and catches up. It does not take over."

### Step 5. Network partition (1 min 15 s)

**DO:** Click **Isolate leader**. Show the red dashed links. Acquire a new resource, `partition-test`. Then click **Heal network**.

**SAY:** "Now the leader is alive but cut off. This is the hardest failure, because both sides are running and each thinks the other died. The four machines on the majority side elect a new leader and keep granting locks. The cut-off leader can't reach a majority, so after 1.5 seconds it steps down (`check-quorum` in the log) and can't grant anything. After healing, it sees the higher term, becomes a follower and copies what it missed."

**CONCEPT: no split brain, and the CAP trade-off.** Only a side with 3 or more machines can act, so two leaders can never hand out the same lock. If 3 machines die the service stops rather than risk two holders. It chooses **consistency over availability**.

### Step 6. Fencing tokens (1 min 15 s)

**DO:** In the **Fencing** card click **Run the fencing demo** and wait about 5 seconds.

**SAY:** "A lock service alone can't stop this. Client A takes a lock with a short lease and then freezes, for example a long garbage-collection pause. The lease expires, B gets the lock and writes. Then A wakes up, still believes it holds the lock, and writes. Without protection A overwrites B's data.

Each grant carries a token that only goes up: A got 1, B got 2. The protected storage remembers the highest token it has seen. A's write with token 1 is **REFUSED** because it has already seen 2."

**SHOW (backend):** Terminal chip **Locks**: `RESOURCE write ... -> REJECTED: stale token`. Point to the **Protected resource** table (newest token seen, last writer).

**CONCEPT:** The lock gives mutual exclusion in time. The token gives it at the resource, even when a client is slow or confused.

---

## 3. Backend code, quick tour (1 min 30 s)

**SAY:** "Two programs, no libraries."

| File | Point at | One-liner |
|---|---|---|
| `public/app.js` | `poll()`, `act()` | "The browser polls `/api/cluster` and `/api/locks` every 500 ms and just draws. There is no lock logic in the frontend." |
| `server.js` | `viaLeader`, `startNode`, `applyPartition`, `/api/resource/write` | "The gateway: finds the leader and retries, starts or kills replica processes (the Kill and Restart buttons), simulates partitions by telling nodes which peers to ignore, and hosts the fencing check." |
| `replica.js` | `applyCmd` | "The lock table: acquire, renew, release, sweep. Acquire does `++sm.fence`, the fencing token. Time comes from the command, not the machine's clock, so all five decide identically. The table isn't saved; it is rebuilt by replaying the log." |
| `replica.js` | `tryElection`, `raftHandlers` | "Pre-vote, vote, AppendEntries: Raft's rules." |
| `replica.js` | `propose`, `replicate`, `advanceCommit` | "Append, send to followers, commit at 3 of 5, then apply and reply." |
| `replica.js` | `persist`, `loadDisk` | "Write the WAL and the term file before replying; reload on boot." |

---

## 4. Proof and numbers (1 min)

**DO:** In a second terminal (server still running): `npm test`

**SAY:** "Twelve checks against the live cluster: a leader is elected, only one client gets the lock, the lock survives a leader crash, leases expire, tokens strictly increase, the majority side serves writes during a partition, and there is a single leader after healing."

**SAY (no need to run):** "`npm run chaos` runs 8 clients for a minute while randomly crashing machines and cutting the network, then checks that no two clients ever held the same lock at once. I also broke the lock logic on purpose to prove the checker catches it."

**SAY:** "Measured on my laptop (`docs/BENCHMARKS.md`): about 30 ms per operation, up to about 4000 operations per second with 32 clients, and failover in about one second. Failover is mostly the election timeout, so it doesn't grow with cluster size. With fsync on, every write is slower but fully durable."

---

## 5. The Virtual Lab (1 min)

**DO:** Leave the cluster running. Open a new terminal: `cd vlab` then `npm start`, and open http://localhost:8099.

**SAY:** "The second deliverable is a Virtual Lab, a static website for teaching this. It has six experiments: leases, leader election, log replication, partitions, fencing tokens and crash recovery. Each follows the usual lab layout: Aim, Theory, Pretest, Procedure, Simulation, Posttest, References, Feedback."

**DO:** Open **Experiment 5: Fencing Tokens**, open the Simulation tab and click through one procedure step.

**SAY:** "The cluster in the Simulation tab is not a server. `sim.js` runs the same Raft and lock logic in the visitor's browser, with an in-memory network and disks. So it deploys on Vercel as plain static files, and each student gets a private cluster they can break freely. The mini project is the real system. The lab is how someone learns it."

---

## 6. Closing (30 s)

**SAY:** "Five machines agree through Raft, so the service survives crashes and network splits. Locks are leases, so dead clients can't block anyone. Fencing tokens protect the data even from clients that wake up late. The dashboard lets you break things and watch it heal, and the live terminal shows the real backend doing it. Limits: the log has no compaction, the cluster size is fixed, and it has been run locally and in Docker, not yet on real cloud machines."

---

## Likely questions

| Question | Answer |
|---|---|
| Why 5 machines, not 3? | 5 survives 2 failures, 3 survives only 1. More machines make each commit slower. |
| What if 3 of 5 die? | No majority, so it stops granting locks. It prefers unavailable over wrong. |
| Leader crashes right after granting? | The grant was already on 3 machines before the client heard "OK". The new leader has it. |
| What stops two leaders? | One vote per node per term, and a leader needs a majority. Two majorities always overlap. |
| If the lock is correct, why fencing tokens? | A client can pause past its lease and still write. Only the resource can stop that, by rejecting old tokens. |
| Is the lock table on disk? | No. Only term, vote and log are. The table is rebuilt by replaying the log. |
| Why not use etcd or ZooKeeper? | The goal was to design and build this layer so every part can be shown and tested. |

## If something goes wrong

- Click **Reset cluster** (top bar), or stop the server and run `npm run fresh`.
- Don't run `chaos` or `bench` live; they take minutes.
- Windows may ask once to allow Node.js on the network. Allow it (localhost only).
