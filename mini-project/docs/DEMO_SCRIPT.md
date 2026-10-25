# Demo script: frontend and backend of the Distributed Lock Service

Length: about 15 minutes. Lines starting with **SAY** are spoken. Lines starting with **DO** are actions. Line numbers are approximate and refer to the current files.

## Before you start (2 minutes, off camera)

```bash
cd C:\DistLockService
npm run fresh
```

1. Open http://localhost:8080 in the browser.
2. Open VS Code on the project folder with `server.js`, `replica.js` and `public/app.js` ready in tabs.
3. Check the top right says "Leader: N? - 5/5 nodes up (quorum 3)".

---

## Part 1. Introduction (1 minute)

**SAY:** "Imagine two programs both trying to update the same bank balance at once. They would corrupt it. So before touching it, a program asks a lock service: 'Can I have the lock?' The service says yes to only one program.

The problem is: what if the lock service itself crashes? Then nobody can get locks, or worse, two programs get the same lock. So I built a lock service that runs on five machines. The five machines vote on every decision using a protocol called Raft, so the service keeps working and stays correct even if two machines die or the network splits. This is the same idea as Google's Chubby and the etcd database.

I'll show you the frontend, which is the dashboard, then the backend, which is the code that makes it work."

---

## Part 2. Frontend tour (5 minutes)

### 2.1 The dashboard layout

**DO:** Point at the screen from top to bottom.

**SAY:** "This is a single web page built with plain HTML, CSS and JavaScript. It refreshes every half second by asking the backend for the cluster's state. There are five cards."

### 2.1b The "Start here" guide and Reset

**DO:** Point at the blue **Start here** box at the top, then at the red **Reset cluster** button in the top bar.

**SAY:** "A new visitor does not have to guess what to do. This box lists six steps in order, and each has a button that does the step for you: take a lock, ask again as someone else, crash the leader, cut the network, run the fencing demo. If things get messy at any point, **Reset cluster** puts everything back to a fresh, healthy cluster. Under it is the Working area, where everything happens. Each card starts with a one-line explanation, and the small question marks explain the technical words. The coloured sentence above the ring always says in plain English what the cluster is doing right now."

### 2.2 Cluster card (ring and node table)

**DO:** Point at the ring, the legend, and the table under it.

**SAY:** "The five circles are the five replicas, N1 to N5. Gold with a white outline is the leader. Blue are followers. Orange would be a candidate, standing for election. Grey is a machine that is down. The number under each name is the term, which is like an election round counter.

The table shows for each node its role, its term, how many entries are in its log, and the commit index, which is how many of those entries are confirmed on a majority of machines. Normally all five rows show the same numbers. The last column, 'Cut off from', will be filled in when I break the network."

### 2.3 Acquiring a lock

**DO:** In the **Lock client** card leave key `orders-db`, client `client-A`, lease `8000`. Click **Acquire**.

**SAY:** "Client A asks for the lock called orders-db for 8 seconds. The result says OK and gives a fencing token, number 1. Look at the Held locks table: A holds it, and a bar counts down the lease."

**DO:** Change the client name to `client-B` and click **Acquire**.

**SAY:** "Now client B asks for the same lock. It is refused and told that client-A holds it. That is mutual exclusion: only one holder at a time."

**DO:** Change the name back to `client-A` (the Token field already holds token 1). Click **Renew**, then watch the bar jump back to full. Then click **Release**.

**SAY:** "Only the real owner with the right token can renew or release. If I do nothing, the lock simply expires after 8 seconds, so a crashed client can't block everyone forever. That is why it is called a lease."

### 2.4 Fault injection

**DO:** Click **Acquire** as client-A again (lease 60000 is fine), so there is a lock to protect. Then click **Kill** on the node that is the leader.

**SAY:** "I have just crashed the leader. Watch the ring. The leader goes grey, one second later another node turns orange, then gold: the other four machines noticed the silence, held an election, and chose a new leader. The term number went up by one. And the Held locks table still shows A's lock, so no information was lost."

**DO:** Point to the event log at the bottom.

**SAY:** "The event log shows what each node did: 'election started', 'became leader'. The red lines are faults I injected."

**DO:** Click **Restart** on the node you killed.

**SAY:** "The old leader comes back as a follower and catches up. It does not take over again."

**DO:** Click **Isolate leader** in the Break things box.

**SAY:** "Now I cut the leader off from the network but leave it running. The dashed red lines are broken links. The four others elect a new leader. The cut-off node notices it can't reach a majority and steps down. This is a network partition, the hardest failure for a lock service, because both sides are alive and each thinks the other died."

**DO:** Click **Acquire** with a new key (for example `partition-test`).

**SAY:** "The majority side still gives out locks, and the isolated node can't. Only one side can ever hold a majority, so you can never have two leaders both handing out the same lock."

**DO:** Click **Heal network**.

**SAY:** "After healing, the isolated node sees the higher term, steps down, and copies what it missed. The table shows all five nodes with identical logs again."

### 2.5 Fencing token demo

**DO:** Click **Run demo** in the **Fencing token demo** card and wait about 5 seconds.

**SAY:** "This is the failure that even a correct lock service cannot prevent by itself. Client A takes the lock with a short lease, then freezes, for example during a long garbage-collection pause. Its lease expires and client B gets the lock. When A wakes up it still thinks it owns the lock and tries to write.

The fix is the fencing token. Each grant gets a number that only goes up. The storage service, here the Protected resource, remembers the highest number it has seen and rejects anything lower. The last step shows A's old token being rejected. That is how the data stays safe."

**DO:** Point to the **Protected resource** table.

**SAY:** "The table shows the highest token seen for each key and who wrote last."

---

## Part 3. Backend tour (6 minutes)

**SAY:** "The backend has two programs. `server.js` is the gateway: the front door. `replica.js` is one replica of the lock service, and I run five copies of it."

### 3.1 How a button click reaches the backend

**DO:** Open `public/app.js`.

**SAY:** "On the frontend, `poll()` in `public/app.js` asks `/api/cluster` and `/api/locks` every 500 ms and `render()` redraws the page. The Acquire button just sends a POST to `/api/acquire` with the key, client name and lease. There is no lock logic in the browser at all. The browser only displays what the backend says."

### 3.2 The gateway: `server.js`

**DO:** Open `server.js` and scroll through these places.

- **`startNode`:** "When the gateway starts it launches five replica processes. This is also how Kill and Restart work: it stops or starts a process."
- **`statuses` and `viaLeader`:** "Clients don't know which of the five machines is the leader. `viaLeader` asks the nodes, finds the leader, forwards the request, and if the leader just changed it retries. It remembers the leader to avoid asking every time. Operations that are safe to repeat, like acquire and renew, are retried; release is not."
- **`resource` and the `/api/resource/write` endpoint:** "This is the protected resource. It stores the highest token per key and rejects lower ones. That is the fencing check."
- **`applyPartition`:** "To simulate a network cut I tell each node which other nodes it must ignore. That is how Isolate leader and Split cluster work."
- **`http.createServer`:** "All the endpoints live here: acquire, renew, release, cluster, locks, and the fault buttons. It also serves the dashboard files."

**SAY:** "Notice the gateway keeps no lock data. If it crashed, I could just restart it. All the real state is in the five replicas."

### 3.3 One replica: `replica.js`

**DO:** Open `replica.js`. Scroll to each section marker.

**SAY:** "This file is the heart of the system, under 400 lines with no libraries. It has five parts."

1. **Persistent state (`persist`, `loadDisk`):** "Each node writes three things to disk: its current term, who it voted for, and a log of every command. The log is a file that only grows. This is written before replying to any message. So after a crash the node comes back remembering exactly what it promised."

2. **The lock state machine (`applyCmd`):** "This small function is the lock table. It handles acquire, renew, release and sweep. Look at acquire: if the lock is held and not expired, refuse. Otherwise increase the counter, `++sm.fence`, and that is the fencing token. The time used comes from the command, not from the clock of the machine running it, so all five nodes always make the same decision. The lock table is not saved to disk. It is rebuilt by replaying the log."

3. **Leader election (`stepDown`, `raftHandlers`, `tryElection`):** "If a follower hears nothing from the leader for 600 to 1100 milliseconds, random so they don't all try at once, it starts an election. It first asks the others with a 'pre-vote' that changes nothing, so an isolated node can't keep inflating the term. If it gets a pre-vote majority, it increases the term, votes for itself and asks for votes. Three of five votes, a majority, makes it leader. A node only votes for a candidate whose log is at least as up to date as its own, which guarantees the new leader has every committed lock."

4. **Replication and commit (`advanceCommit`, `replicate`, `propose`):** "When a request arrives, `propose` appends it to the leader's log, then `replicate` sends it to the followers. `advanceCommit` counts how many nodes have stored it. When three of five have, the entry is committed, `applyCmd` runs, and only then is the client told 'OK'. So if a client was told it got the lock, that fact is already on a majority of machines, and a leader crash cannot lose it."

5. **Timers :** "Every 120 ms the leader sends heartbeats. If a leader can't reach a majority for 1.5 seconds it steps down, so a cut-off leader doesn't pretend to lead. Every 300 ms the leader checks for expired leases and records a 'sweep' in the log, so all replicas delete expired locks at the same point."

**DO:** Scroll to `crash` and `boot`.

**SAY:** "Finally, `crash` and `boot` simulate a process dying and restarting. `boot` throws away everything in memory and rebuilds from disk. That is how I test crash recovery."

### 3.4 Follow one request end to end

**SAY:** "Let me put it together. I click Acquire."

1. "`app.js` sends POST `/api/acquire` to the gateway."
2. "`server.js` `viaLeader` finds the leader and forwards it to that node's `/client/acquire`."
3. "The leader's `propose` adds an `acquire` command to its log and saves it to disk."
4. "`replicate` sends it to four followers; each saves it to disk and confirms."
5. "When three of five have it, `advanceCommit` marks it committed."
6. "`applyCmd` grants the lock with the next token, and the answer travels back to the browser."
7. "A moment later the followers learn it is committed and apply it too."

---

## Part 4. Proof that it works (2 minutes)

**DO:** In a second terminal run:

```bash
npm test
```

**SAY:** "This script talks to the running cluster and runs 12 checks: a leader is elected, only one client gets a lock, the lock survives killing the leader, leases expire, tokens always increase, the majority side keeps working during a partition, and everything converges after healing."

**SAY (no need to run):** "There is also a chaos test, `npm run chaos`. It runs eight clients hammering the locks for a minute while randomly crashing machines and cutting the network, then checks that no two clients ever held the same lock at the same time. It passed on every run. I also proved the checker works by deliberately breaking the lock logic: it immediately reported dozens of violations."

**SAY:** "On my laptop an operation takes about 30 milliseconds, the cluster handles several thousand operations per second, and failover after killing the leader takes about one second."

---

## Part 5. Closing (30 seconds)

**SAY:** "To summarise: five machines agree through Raft, so the service survives crashes and network splits. Locks are leases, so dead clients don't block anyone. Fencing tokens protect the data even from clients that wake up late. The frontend lets you break things and watch the system heal, and the backend is a few hundred lines of code with no libraries. The limits are that the log has no compaction, the cluster size is fixed, and it has not yet been run on real cloud machines, only locally and in Docker."

---

## Likely questions and short answers

| Question | Answer |
|---|---|
| Why 5 machines and not 3? | 5 tolerates 2 failures; 3 tolerates only 1. More machines make every write slower. |
| What if 3 machines die? | The service stops granting locks, because no majority is left. It prefers to be unavailable rather than risk two holders (this is the CAP trade-off: consistency over availability). |
| What if the leader crashes right after granting a lock? | The grant was already stored on a majority before the client was told, so the new leader has it. |
| Why not just use etcd or ZooKeeper? | The case study asks to design and build this layer; I built it so I can show and test every part. |
| What stops two leaders? | A node votes once per term and a leader needs a majority. Two majorities always overlap in at least one node, so two leaders in the same term is impossible. |
| What is the fencing token for if the lock is correct? | A client can pause past its lease and still try to write. The lock service cannot stop that; the resource can, by rejecting old tokens. |
| Is the lock table saved on disk? | No. Only term, vote and the log are saved; the lock table is rebuilt from the log on restart. |
| Does this run on real cloud VMs? | The design maps to five VMs in a VPC across three availability zones. I have tested locally and in Docker; the AWS guide is written but untested. |

## Tips for the live demo

- Keep your **lease** at 60000 while demonstrating faults so the lock does not expire in the middle of your explanation.
- If something looks odd, press **Heal network** and restart any grey nodes, or stop the server and run `npm run fresh` for a clean start.
- Do not run the chaos test or benchmarks live; they take minutes.
