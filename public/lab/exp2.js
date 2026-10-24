// Experiment 2: Raft leader election and failover
const maxTerm = c => Math.max(0, ...c.nodes.filter(n => n.up).map(n => n.term));
const upCount = c => c.nodes.filter(n => n.up).length;
const ctx = {}; // remembers the node killed in step 2 for step 3

window.EXP = {
  id: 'exp2',
  title: 'Experiment 2: Raft Leader Election and Failover',

  aim: `<p>To observe how a replicated lock service elects a leader, detects a leader crash, and recovers, and to see why a <b>majority (quorum)</b> of nodes is required for the service to make progress.</p>
  <p>You will crash the leader of a real five-node cluster, bring it back, break the quorum on purpose, and finally tune the election timeout to see why it must be larger than the heartbeat interval.</p>`,

  theory: `
<h2>Why a leader?</h2>
<p>A lock service must give one answer to "who holds lock X?". Raft achieves this by electing a single <b>leader</b> that orders all requests; the other nodes (<b>followers</b>) copy the leader's log. If the leader fails, the followers elect a new one.</p>

<h2>Roles and terms</h2>
<svg viewBox="0 0 640 170" style="max-width:640px;width:100%" role="img" aria-label="Raft role transitions">
  <defs><marker id="ar" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#5b6577"/></marker></defs>
  <g font-family="system-ui" font-size="14" text-anchor="middle">
  <rect x="20" y="60" width="140" height="50" rx="10" fill="#4c9aff"/><text x="90" y="90" fill="#0f1420" font-weight="700">Follower</text>
  <rect x="250" y="60" width="140" height="50" rx="10" fill="#ff8a3d"/><text x="320" y="90" fill="#0f1420" font-weight="700">Candidate</text>
  <rect x="480" y="60" width="140" height="50" rx="10" fill="#f5b83d"/><text x="550" y="90" fill="#0f1420" font-weight="700">Leader</text>
  <path d="M160,75 L250,75" stroke="#5b6577" stroke-width="2" marker-end="url(#ar)"/><text x="205" y="64" fill="#5b6577" font-size="11">timeout</text>
  <path d="M390,75 L480,75" stroke="#5b6577" stroke-width="2" marker-end="url(#ar)"/><text x="435" y="64" fill="#5b6577" font-size="11">majority votes</text>
  <path d="M320,110 Q320,150 100,112" stroke="#5b6577" stroke-width="2" fill="none" marker-end="url(#ar)"/><text x="215" y="148" fill="#5b6577" font-size="11">sees leader / higher term</text>
  <path d="M550,110 Q550,160 120,112" stroke="#5b6577" stroke-width="2" fill="none" marker-end="url(#ar)"/><text x="470" y="160" fill="#5b6577" font-size="11">higher term seen</text>
  </g>
</svg>
<p>Time is divided into <b>terms</b>, numbered 1, 2, 3, &hellip; Each term has at most one leader. The term acts as a logical clock: a node that sees a higher term than its own immediately adopts it and becomes a follower, so a stale leader can never keep ruling.</p>

<h2>Heartbeats and election timeouts</h2>
<p>The leader sends <b>heartbeats</b> (empty AppendEntries) every <code>120 ms</code>. Each follower has an <b>election timeout</b>, a random value in <code>600-1100 ms</code> in this lab. If no heartbeat arrives before it fires, the follower assumes the leader is gone and starts an election.</p>
<ul>
<li>The timeout must be <b>much larger</b> than the heartbeat interval, otherwise healthy leaders are suspected and elections happen needlessly.</li>
<li>It is <b>randomised</b> so that usually one follower times out first and wins before the others even start: this avoids <i>split votes</i>.</li>
</ul>

<h2>The election</h2>
<ol>
<li>(Optional but used here) <b>PreVote:</b> the node asks peers "would you vote for me?" without changing any term. This stops an isolated node from inflating the term.</li>
<li>The candidate increments its term, votes for itself, and sends <code>RequestVote</code> to all peers.</li>
<li>A node grants <b>at most one vote per term</b>, and only if the candidate's log is at least as up to date as its own (the <i>election restriction</i>).</li>
<li>With votes from a <b>majority</b> (3 of 5) the candidate becomes leader and immediately sends heartbeats. It appends a <i>no-op</i> entry in its new term so that entries from earlier terms can be committed safely.</li>
</ol>

<h2>Why a majority?</h2>
<p>Any two majorities of 5 nodes overlap in at least one node, so two different leaders can never both be elected in the same term and every new leader knows every committed entry. The price: with only 2 of 5 nodes alive, <b>no leader can be elected and the service stops</b>. It chooses correctness over availability (the "C" in CAP).</p>

<div class="box tip"><b class="t">What persists across a crash</b>Each node writes its <code>term</code>, <code>votedFor</code> and log to disk before replying to any request. A restarted node cannot forget a vote it has already cast, which is what prevents two leaders in one term.</div>
<div class="box warn"><b class="t">Common misconception</b>"The node with the highest ID wins." Raft has no such rule: whichever node times out first (and has an up-to-date log) usually wins.</div>`,

  steps: [
    { title: 'Find the leader',
      text: 'Look at the cluster ring: the leader is gold with a dark outline. Note its node number and the term shown under each node.',
      predict: 'Which node is the leader, and what term is the cluster in?',
      check: c => upCount(c) === c.n && !!c.leader,
      hint: c => upCount(c) < c.n ? 'Some nodes are down. Restart them or press Reset cluster.' : 'No leader yet - wait a moment.',
      ok: 'You identified a healthy 5-node cluster with one leader.' },
    { title: 'Kill the leader',
      text: 'Press <b>Kill N&lt;leader&gt;</b> in the Fault injection area of the dashboard. Watch the ring and the event log.',
      predict: 'How long will it take for a new leader to appear? Will the term change?',
      baseline: c => ({ leader: c.leader, term: maxTerm(c) }),
      check: (c, b) => { const ok = !!c.leader && c.leader !== b.leader && maxTerm(c) > b.term; if (ok) ctx.old = b.leader; return ok; },
      hint: (c, b) => b.leader ? `Kill N${b.leader} (the current leader).` : '',
      ok: 'A new leader was elected in a higher term (failover).' },
    { title: 'Bring the old leader back',
      text: 'Press <b>Restart</b> for the node you killed. It reloads its term, vote and log from disk.',
      predict: 'Will the old leader take over again? What role will it have?',
      check: c => {
        if (upCount(c) < c.n || !c.leader) return false;
        // the node killed in step 2; after a page reload fall back to any recently started node
        const n = ctx.old ? c.nodes.find(x => x.id === ctx.old) : c.nodes.find(x => x.uptimeMs < 30000 && x.id !== c.leader);
        return !!n && n.role === 'follower' && n.term === maxTerm(c) && c.leader !== n.id;
      },
      hint: c => upCount(c) === c.n ? 'Waiting for the restarted node to catch up...' : (ctx.old ? `Restart N${ctx.old}.` : 'Restart the node you killed.'),
      ok: 'The old leader rejoined as a follower in the current term.' },
    { title: 'Break the quorum',
      text: 'Kill nodes until only <b>2</b> are alive. Watch what happens when the cluster drops below 3.',
      predict: 'With 3 nodes down, can the 2 survivors elect a leader?',
      check: c => upCount(c) <= 2 && !c.leader,
      hint: c => `${upCount(c)} of ${c.n} nodes are up. Kill nodes until 2 remain, then wait about 2 seconds.`,
      ok: 'No leader: 2 of 5 is not a majority, so the service stops rather than risk two leaders.' },
    { title: 'Restore the quorum',
      text: 'Restart all stopped nodes.',
      predict: 'Will the lock service return to normal by itself? Which node will lead?',
      check: c => upCount(c) === c.n && !!c.leader,
      hint: c => `${upCount(c)} of ${c.n} up. Restart every stopped node.`,
      ok: 'With a majority back, a leader was elected and the cluster recovered.' },
    { title: 'Make elections too fast',
      text: 'In <b>Protocol settings</b> turn <b>PreVote OFF</b> and set the election timeout to <b>50-100 ms (shorter than heartbeat)</b>. The heartbeat is 120 ms, so followers will time out before the next heartbeat arrives. Watch the term number rise and the leader change even though nothing has crashed.',
      predict: 'If followers time out sooner than heartbeats arrive, what happens to the term and to leadership?',
      baseline: c => ({ term: maxTerm(c) }),
      check: (c, b) => c.nodes.some(n => n.up && n.config && n.config.electionMax <= 100) && maxTerm(c) >= b.term + 2,
      hint: (c, b) => `Term is ${maxTerm(c)} (started at ${b.term}). Needs PreVote off and 50-100 ms timeouts; term must rise by 2.`,
      ok: 'The term rose with no crash at all: needless elections disturb the cluster. Timeout must be much larger than the heartbeat.' },
    { title: 'Restore safe settings',
      text: 'Turn PreVote back ON and set the election timeout back to <b>600-1100 ms (default)</b>. Check that the term stops changing.',
      predict: 'Will the cluster settle down again?',
      check: c => !!c.leader && c.nodes.every(n => !n.up || (n.config && n.config.prevote && n.config.electionMin === 600)),
      hint: () => 'Restore PreVote ON and the default election timeout.',
      ok: 'Stable cluster restored.' },
  ],

  procedureExtra: `<div class="box"><b class="t">Tips</b>Press <b>Reset cluster</b> in the lab panel to start fresh at any time (it wipes all node data). Record what you predicted before each action in the observations box.</div>`,

  pretest: [
    { level: 'Beginner', q: 'Why does a distributed lock service run on several replicas instead of one server?',
      opts: ['A single server cannot store lock names', 'To avoid a single point of failure', 'Clients are required to connect to many servers', 'Replicas make each request faster'], ans: 1,
      ex: ['One server can store any number of lock names.', 'Correct: if the only server crashes, nobody can get or release locks. Replication keeps the service available.', 'Clients usually talk to one endpoint; replication is internal.', 'Replication adds coordination work; it improves fault tolerance, not speed.'] },
    { level: 'Beginner', q: 'Which are the three roles a node can have in Raft?',
      opts: ['Master, Slave, Observer', 'Leader, Follower, Candidate', 'Producer, Consumer, Broker', 'Client, Server, Proxy'], ans: 1,
      ex: ['Those names are from other systems.', 'Correct: followers become candidates when they time out, and a winning candidate becomes leader.', 'These are messaging-system roles.', 'These describe client-server networking, not Raft.'] },
    { level: 'Beginner', q: 'How many nodes form a majority in a 5-node cluster?',
      opts: ['2', '3', '4', '5'], ans: 1,
      ex: ['2 of 5 is a minority; two such groups could exist at once.', 'Correct: a majority is more than half, so 3.', '4 is more than needed; a majority is the smallest group over half.', 'Requiring all 5 would mean any single failure stops the cluster.'] },
    { level: 'Intermediate', q: 'When does a follower start an election?',
      opts: ['As soon as it boots', 'When a client asks for a lock', 'When it hears no heartbeat from a leader within its election timeout', 'Every 10 seconds regardless'], ans: 2,
      ex: ['A freshly booted node waits to hear from a leader first.', 'Client requests go to the leader and do not trigger elections.', 'Correct: silence from the leader for one election timeout means the leader may be dead.', 'Elections are failure-triggered, not periodic.'] },
    { level: 'Intermediate', q: 'Why are election timeouts randomised?',
      opts: ['To make clocks drift apart', 'To reduce the chance that several nodes become candidates together and split the vote', 'To slow down elections', 'Random values are required by the network'], ans: 1,
      ex: ['Timeouts do not affect clocks.', 'Correct: usually one node times out first and wins before the others start.', 'The goal is faster, cleaner elections, not slower ones.', 'The network does not require randomness.'] },
    { level: 'Intermediate', q: 'What is a Raft "term"?',
      opts: ['The length of a lock lease', 'A logical clock that numbers leadership periods', 'The number of nodes in the cluster', 'The size of the log'], ans: 1,
      ex: ['Lease length is the TTL, a separate concept.', 'Correct: each term has at most one leader; a higher term always overrides a lower one.', 'Cluster size is fixed; terms keep increasing.', 'Log size is the number of entries.'] },
    { level: 'Advanced', q: 'A candidate with an out-of-date log asks for your vote. What should you do?',
      opts: ['Vote for it: the term is higher', 'Vote for it if its node ID is larger', 'Refuse, because it could erase committed entries', 'Vote only if you are a candidate too'], ans: 2,
      ex: ['A higher term alone is not enough.', 'Raft never uses node ID to decide.', 'Correct: the election restriction only grants votes to candidates whose log is at least as up to date, so committed entries are never lost.', 'A candidate has already voted for itself; this is unrelated.'] },
    { level: 'Advanced', q: 'In a 5-node cluster, 3 nodes crash. What does a Raft-based lock service do?',
      opts: ['Continues normally using 2 nodes', 'Elects a leader among the 2 survivors', 'Stops accepting writes; no leader can be elected, but nothing is corrupted', 'Randomly grants locks to avoid downtime'], ans: 2,
      ex: ['Two nodes are not a majority.', 'Two votes are fewer than the 3 needed.', 'Correct: it sacrifices availability to keep consistency (CP).', 'Granting locks without agreement would risk two holders.'] },
    { level: 'Advanced', q: 'Why does a new leader append a no-op entry in its own term?',
      opts: ['To test the disk', 'So it can commit entries left over from earlier terms by replicating one entry from the current term', 'To tell clients the leader changed', 'To increase the term number'], ans: 1,
      ex: ['Disk testing is not its purpose.', 'Correct: Raft commits earlier-term entries only indirectly, once an entry from the current term reaches a majority.', 'Clients learn about leaders through redirects.', 'The term is increased by the election, not by the no-op.'] },
  ],

  posttest: [
    { level: 'Beginner', q: 'Which node handles lock requests from clients?',
      opts: ['Any node independently', 'The leader', 'The node with the lowest ID', 'Only a candidate'], ans: 1,
      ex: ['Independent handling would let two nodes grant the same lock.', 'Correct: the leader orders all commands and replicates them.', 'ID does not decide roles.', 'Candidates exist only during an election.'] },
    { level: 'Beginner', q: 'The leader of a 5-node cluster crashes; 4 nodes remain. What happens?',
      opts: ['The service stops permanently', 'A new leader is elected and the service continues', 'The cluster waits for the old leader', 'All locks are deleted'], ans: 1,
      ex: ['4 nodes is a majority, so the cluster can continue.', 'Correct: a follower times out, wins a majority vote and becomes leader.', 'Followers do not wait for a dead leader forever.', 'Committed locks are kept in the replicated log.'] },
    { level: 'Beginner', q: 'The old leader restarts after a new leader was elected. What is its role?',
      opts: ['Leader again', 'Follower', 'Candidate permanently', 'It is removed from the cluster'], ans: 1,
      ex: ['A stale leader cannot take over; the cluster has moved to a higher term.', 'Correct: it learns the higher term and follows the new leader.', 'It only becomes a candidate if it stops hearing a leader.', 'Raft here has a fixed membership; nodes may return.'] },
    { level: 'Intermediate', q: 'A node receives a message with a term higher than its own. What does it do?',
      opts: ['Ignores it', 'Adopts the higher term and steps down to follower', 'Starts an election', 'Deletes its log'], ans: 1,
      ex: ['Ignoring would let stale leaders keep ruling.', 'Correct: a higher term proves a newer leadership period exists.', 'It would only start one after a timeout.', 'The log is kept; conflicting entries are repaired later.'] },
    { level: 'Intermediate', q: 'Why must the election timeout be much larger than the heartbeat interval?',
      opts: ['To save bandwidth', 'Otherwise followers falsely suspect a healthy leader and trigger needless elections', 'So that elections always fail', 'Because heartbeats are slow to compute'], ans: 1,
      ex: ['Bandwidth is not the main concern.', 'Correct: a few delayed heartbeats should not cause an election; a large gap tolerates jitter.', 'Elections are supposed to succeed when the leader fails.', 'Heartbeats are cheap.'] },
    { level: 'Intermediate', q: 'Only 2 of 5 nodes are alive. Why can they not elect a leader?',
      opts: ['They lack network access', 'They can reach only 2 votes; a leader needs 3, which guarantees no second leader', 'Only the old leader can restart elections', 'Raft needs an odd number of live nodes'], ans: 1,
      ex: ['They may reach each other fine; the problem is the vote count.', 'Correct: a majority prevents two disjoint groups from each electing a leader.', 'Any node may start an election.', 'The requirement is a majority of the configured nodes, not oddness of live nodes.'] },
    { level: 'Advanced', q: 'What problem does PreVote solve?',
      opts: ['Slow disks', 'A partitioned node repeatedly raising its term and disrupting the cluster when it rejoins', 'Duplicate client requests', 'Clock skew between nodes'], ans: 1,
      ex: ['Disk speed is unrelated.', 'Correct: the isolated node cannot win a pre-vote, so its term is not raised until it can really win.', 'Duplicates are handled by lock ownership checks.', 'Raft elections do not rely on synchronised clocks.'] },
    { level: 'Advanced', q: 'Why may a node vote only once per term?',
      opts: ['To save messages', 'To guarantee at most one leader per term', 'Because votes are expensive', 'To keep logs short'], ans: 1,
      ex: ['Message count is secondary.', 'Correct: one vote per node means two candidates cannot both gather a majority in the same term.', 'The cost of voting is not the reason.', 'Voting does not affect log size.'] },
    { level: 'Advanced', q: 'Why must a node persist currentTerm and votedFor before replying to a vote request?',
      opts: ['To speed up restarts', 'Otherwise after a crash it could vote twice in one term and allow two leaders', 'So clients can read it', 'To compress the log'], ans: 1,
      ex: ['Persisting costs time; speed is not the aim.', 'Correct: forgetting a vote after a crash could let two candidates both win the same term.', 'Clients do not read vote state.', 'Compression is unrelated.'] },
  ],

  refs: [
    'D. Ongaro, J. Ousterhout. <i>In Search of an Understandable Consensus Algorithm (Extended Version)</i>, USENIX ATC 2014.',
    'M. Burrows. <i>The Chubby Lock Service for Loosely-Coupled Distributed Systems</i>, OSDI 2006.',
    'Raft visualisation and resources: <a href="https://raft.github.io" target="_blank" rel="noopener">raft.github.io</a>',
    'etcd documentation, <i>Learner design and Raft</i>: <a href="https://etcd.io/docs/" target="_blank" rel="noopener">etcd.io/docs</a>',
    'Project documentation: <code>docs/PHASE1.md</code> (architecture and failure strategy).',
  ],
};
