# Virtual Lab Plan - Fault-Tolerant Distributed Lock Service

## 1. What the IIT / IIIT Virtual Labs look like (analysis)

Reference studied: **Distributed Systems II** (IIIT Hyderabad, part of the MoE Virtual Labs programme) - <https://dsys2-iiith.vlabs.ac.in/>. The Virtual Labs portal lists ~45 CSE labs (24 from IIIT-H, others from Amrita, IIT Kharagpur, Dayalbagh, IIT Kanpur). The nearest labs to our topic are Distributed Systems I and II; none covers Raft or lock services, so our topic fills a gap.

**Lab level** (top navigation): Introduction, Objective, List of Experiments, Target Audience, Course Alignment, Feedback. Breadcrumb: CSE > Lab > Experiments. Footer carries licence (AGPL 3.0 / CC BY-NC-SA 4.0) and outreach links.

**DS-II experiment list:** Consistent Hashing; Maekawa Quorum Mutual Exclusion; Consensus with Crash Failures; Byzantine Failures Scenario; 2-Phase Commit (without failures); Chord System; 2PC Simulation.

**Experiment level** - every experiment page has the same tab row:

| Tab | Purpose | Observed detail |
|---|---|---|
| Aim | One-paragraph learning goal | e.g. Byzantine failures and how PBFT reaches consensus. |
| Theory | Concepts, algorithm, diagrams | (content not visible in my capture) |
| Pretest | Check prior knowledge before starting | **9 MCQs, 4 options each, difficulty selector (Beginner / Intermediate / Advanced), per-option "Explanation" link, Submit Quiz.** |
| Procedure | Step-by-step instructions for the simulation | (content not visible) |
| Simulation | Interactive visualisation | (content not visible - I could not confirm controls or panels) |
| Posttest | Same format, tests what was learned | assumed mirrors Pretest |
| References | Books / papers | |
| Contributors | Credits | |
| Feedback | Form | |

Caveat: the Theory, Procedure and Simulation contents did not load in my capture, so the simulation design in section 4 is my own, guided by the fixed tab structure and standard Virtual Labs conventions, not a copy of their interface.

## 2. Our lab: structure

**Title:** *Fault-Tolerant Distributed Lock Service Virtual Lab* (CSE > Distributed Systems).
**Target audience:** UG/PG students of Distributed Systems / Cloud Computing (this course: Advanced Cloud System Software Design).
**Course alignment:** consensus, replication, leases, fencing, CAP trade-offs, failure handling.
Lab-level pages: Introduction, Objective, List of Experiments, Target Audience, Course Alignment, Feedback (same as IIIT-H).

### Experiments (each with Aim / Theory / Pretest / Procedure / Simulation / Posttest / References / Feedback)

| # | Experiment | Learner does in the simulation | Concepts |
|---|---|---|---|
| 1 | **Mutual exclusion with leases** | Several clients contend for a key; vary TTL; let a client "crash" and watch the lease expire. | Locks vs leases, TTL, liveness vs safety. |
| 2 | **Raft leader election & failover** | Kill the leader, change election timeouts, watch terms, votes, candidates. | Terms, RequestVote, randomised timeouts, split votes. |
| 3 | **Log replication & quorum commit** | Send an acquire, step through AppendEntries, see commitIndex move only at majority; take 2 then 3 nodes down. | Log matching, commit rule, quorum, CP behaviour. |
| 4 | **Network partitions & split brain** | Cut the cluster 2 vs 3, isolate the leader, heal; toggle PreVote / check-quorum off to see the damage. | Partition tolerance, stale leader, term inflation. |
| 5 | **Fencing tokens** | Reproduce the zombie-client bug first with fencing OFF (corrupted resource), then ON (stale write rejected). | Clock/pause problem, monotonic tokens. |
| 6 | **Crash recovery & persistence** | Restart nodes with disk intact vs wiped; see log catch-up and state-machine replay. | Durable term/vote/log, replay, why a wiped node is dangerous. |

Optional 7: *Benchmark explorer* (latency / failover time vs cluster size), filled from Phase 2 measurements.

## 3. Per-experiment content template

1. **Aim** - 2-3 sentences.
2. **Theory** - 600-900 words, 2-3 diagrams (reuse `docs/architecture.svg` style), pseudo-code of the algorithm, "common misconceptions" box.
3. **Pretest** - 8-10 MCQs, 3 difficulty levels, each option with an explanation (matches IIIT-H format). Stored as JSON:
   `{ id, level, question, options[4], answerIndex, explanations[4] }`.
4. **Procedure** - numbered steps tied to simulation controls, plus "predict first, then run" prompts.
5. **Simulation** - see section 4.
6. **Posttest** - different question set, same format; score shown with per-question review; optional "pre vs post" improvement chart.
7. **References** - Raft paper (Ongaro & Ousterhout), Chubby (Burrows), Kleppmann "How to do distributed locking" (fencing), etcd docs.
8. **Feedback** - short form (rating + comment), stored locally / emailed.

## 4. Simulation = the real project (revised)

The Simulation tab does **not** use a separate toy simulator. It embeds the lock service we built: the real 5-replica Raft cluster behind `server.js`, driven through the same dashboard (`public/`). Everything a learner does in an experiment is something the project actually demonstrates:

| Project feature (already built) | Used in experiment |
|---|---|
| Acquire / renew / release with TTL, held-locks table with lease bars | 1 |
| Cluster ring: roles, terms, leader highlight, Kill / Restart node | 2, 6 |
| Node table: log length, commitIndex; replication via real AppendEntries | 3 |
| Isolate leader, split majority, heal network (dashed red links) | 4 |
| Event log aggregated from all nodes | all |
| Fencing demo + protected resource that rejects stale tokens | 5 |
| Disk persistence + restart (Restart Nx) | 6 |
| `test.js` scenarios | become guided "run this scenario" buttons and self-checks |

What the lab adds around the real cluster (small additions to the project, not a new system):
- **Lab panel** beside the dashboard: current step from the Procedure, "predict, then run" prompt, an Observations box, and a check that auto-verifies the step (e.g. "leader changed", "lock still held after failover", "stale write rejected").
- **Protocol toggles** on the real nodes (admin endpoint): PreVote on/off, check-quorum on/off, fencing on/off, so experiments 4 and 5 can show the failure first and the fix second.
- **Reset button** (fresh cluster) so each experiment starts clean.
- Later: Phase 2 benchmark numbers surfaced in an optional experiment 7.

## 5. Technical approach

- One web app served by the existing gateway: the lab shell (tabs Aim / Theory / Pretest / Procedure / Simulation / Posttest / References / Feedback) wraps the dashboard. One folder per experiment under `public/lab/expN-.../`.
- Shared `lab-common` (tab shell, quiz engine, lab panel, styles) and `data/*.json` question banks.
- Quiz engine: difficulty picker, per-option explanations, scores in `localStorage` (try/catch), pre vs post comparison.
- Hosting consequence: because the simulation is the real cluster, the lab needs a running backend. Run locally for the demo, or host the Node server on a VM/container (Render, Railway, a cloud VM). A static host alone is not enough. Optional later: a read-only "recorded run" fallback.
- Licence CC BY-NC-SA 4.0, as the reference lab does.

## 6. Build plan

| Phase | Work | Output |
|---|---|---|
| A | Lab shell: tab layout, quiz engine, navigation, theme; embed dashboard in Simulation tab | Navigable lab with Exp 2 skeleton |
| B | Lab panel + step verification + reset + protocol toggles in `replica.js` / `server.js` | Experiments are guided and self-checking |
| C | Experiments 1-6: theory, procedure, scenarios, 8-10 pre/post questions each (about 100 total) | All experiments complete |
| D | Optional experiment 7 with Phase 2 benchmarks | |
| E | Testing (scenario checks, quiz data validation), mobile layout, README / manual | Submittable lab |

Suggested order: A -> B -> Exp 2 and 3 -> Exp 4 and 5 (headline demos) -> Exp 1 and 6 -> E.

## 7. Open questions for you

1. Is the virtual lab graded, or extra? (Changes how much theory/quiz content is needed.)
2. Local demo enough, or must it be hosted publicly (needs a server host)?
3. How many experiments? Suggest 4 minimum (2, 3, 4, 5) if time is short.

## Sources

- IIIT-H Distributed Systems II: <https://dsys2-iiith.vlabs.ac.in/>, experiment list <https://dsys2-iiith.vlabs.ac.in/List of experiments.html>, Byzantine experiment <https://dsys2-iiith.vlabs.ac.in/exp/byzantine-failures-scenario/> and its pretest page
- Virtual Labs CSE directory: <https://www.vlab.co.in/broad-area-computer-science-and-engineering>
