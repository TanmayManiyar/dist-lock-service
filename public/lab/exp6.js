// Experiment 6: Crash recovery and persistence
const held6 = c => (c.locks && c.locks.ok) ? Object.values(c.locks.locks).filter(l => l.expiresAt > c.locks.now).length : 0;
const ctx6 = {};

window.EXP = {
  id: 'exp6',
  title: 'Experiment 6: Crash Recovery and Persistence',

  aim: `<p>To see what a node must keep on disk to survive a crash, and to verify that granted locks are <b>not lost</b> when one node, or even every node, restarts.</p>
  <p>You will crash and restart a single follower, then crash the <b>whole cluster</b> and bring it back, and finally destroy one node's disk to see how it recovers.</p>`,

  theory: `
<h2>What survives a crash?</h2>
<p>When a process crashes, everything in memory is lost. Raft therefore splits state into two kinds:</p>
<table style="width:100%;border-collapse:collapse">
<tr><th style="text-align:left">Persistent (on disk)</th><th style="text-align:left">Volatile (rebuilt)</th></tr>
<tr><td><code>currentTerm</code>, <code>votedFor</code>, the <b>log</b></td><td>lock table, commitIndex, lastApplied, role, leader state</td></tr>
</table>
<p>The lock table is <i>not</i> stored: it is a pure function of the log, so a restarted node rebuilds it by <b>replaying the committed log</b> from the start.</p>

<h2>Why these three items?</h2>
<ul>
<li><b>The log</b> holds the history. Entries that were acknowledged to a leader as stored must never disappear, or a committed lock grant could be lost.</li>
<li><b>currentTerm</b> keeps the node from accepting messages from stale leaders after a restart.</li>
<li><b>votedFor</b> ensures a node does not vote <i>twice</i> in the same term. If a node forgot its vote after a crash it could help elect two leaders in one term, which breaks safety.</li>
</ul>
<p>All three must reach disk <b>before</b> the node replies to the RPC that caused the change. In this implementation each node writes a JSON file to a temporary name and then renames it over the old one. The rename is atomic, so a crash during the write leaves either the old or the new consistent file, never half of each.</p>

<h2>Restart sequence</h2>
<ol>
<li>Load <code>term</code>, <code>votedFor</code> and <code>log</code> from disk. Start as a <b>follower</b> with <code>commitIndex = 0</code> and an empty lock table.</li>
<li>Hear from a leader (or win an election) and learn the current <code>commitIndex</code>.</li>
<li>Fix any mismatched log suffix, then apply committed entries in order to rebuild the lock table.</li>
</ol>

<h2>Whole-cluster restart</h2>
<p>If every node crashes (a power cut, a bad deployment), the logs on disk still hold every committed entry. After enough nodes return to form a majority, one is elected, commits a no-op, and the lock table is rebuilt exactly. Lock expiry times are stored as <b>absolute</b> timestamps in the log, so time keeps running while the cluster is down: locks whose lease ended during the outage will be swept as soon as a leader is back.</p>

<h2>Losing a disk</h2>
<p>If a node's disk is destroyed, it forgets its term, vote and log. As long as a majority of other nodes still hold the committed history, the leader simply copies the whole log to it again and it catches up. However, a node that forgets a <b>vote</b> could in principle vote twice in a term, so production systems treat a wiped node as a <i>new</i> member that must be added through a safe reconfiguration. This lab has no membership changes, so wiping a disk is shown only to illustrate recovery.</p>

<div class="box warn"><b class="t">Lab simplification</b>A production system calls <code>fsync</code> so data is on the physical disk, not just in the operating system's cache. This lab writes through the file system and relies on the OS; a power cut mid-write could be worse than a process crash.</div>
<div class="box tip"><b class="t">Key insight</b>The log is the source of truth. Everything else can be thrown away and rebuilt.</div>`,

  tools: [{ label: 'Destroy disk of', button: 'Wipe disk', url: '/api/fault/wipe' }],

  steps: [
    { title: 'Create some lock state',
      text: 'In the <b>Lock client</b> card set the lease to <code>120000</code> ms and acquire <b>three</b> locks with different keys (e.g. <code>a</code>, <code>b</code>, <code>c</code>). The held locks table should list three.',
      predict: 'How many entries will each node\'s log contain afterwards?',
      check: c => H.upCount(c) === c.n && held6(c) >= 3 && H.inSync(c),
      hint: c => `${held6(c)} of 3 locks held. Use a long lease (120000) so they do not expire during the experiment.`,
      ok: 'Three locks are committed and replicated on all five nodes.' },
    { title: 'Crash a follower',
      text: 'Kill one <b>follower</b>. Acquire another lock with a <b>new key</b> while it is down.',
      predict: 'When the follower returns, will it have the new lock?',
      baseline: c => ({ fence: H.fence(c) }),
      check: (c, b) => H.upCount(c) === 4 && !!c.leader && H.up(c).every(n => n.fence > b.fence),
      hint: c => H.upCount(c) !== 4 ? 'Kill exactly one follower.' : 'Acquire a lock with a key you have not used.',
      ok: 'The cluster kept working and committed a new lock without the crashed node.' },
    { title: 'Restart the follower',
      text: 'Restart the follower. It reloads term, vote and log from disk, then catches up.',
      predict: 'Did the node need to be told about the first three locks again?',
      check: c => H.upCount(c) === c.n && !!c.leader && H.inSync(c) && new Set(c.nodes.map(n => n.fence)).size === 1,
      hint: c => H.upCount(c) < c.n ? 'Restart the stopped node.' : 'Waiting for it to catch up...',
      ok: 'The follower reloaded its old log from disk and received only the entry it missed.' },
    { title: 'Crash the whole cluster',
      text: 'Kill <b>all five nodes</b> (one by one), wait 2 seconds, then restart all five. Do not press Reset.',
      predict: 'Every process lost its memory. Will the locks still be there?',
      baseline: c => ({ ts: Date.now(), held: held6(c) }),
      check: (c, b) => H.upCount(c) === c.n && !!c.leader && held6(c) >= b.held && b.held >= 3 && c.nodes.every(n => n.uptimeMs < Date.now() - b.ts),
      hint: (c, b) => `Kill all nodes, then restart all. Locks to recover: ${b.held}. Currently ${held6(c)} held, ${H.upCount(c)} nodes up.`,
      ok: 'Every lock survived a total outage: the lock table was rebuilt by replaying the log from disk.' },
    { title: 'Destroy one disk',
      text: 'In the lab panel under <b>Extra tools</b> choose a node that is <b>not the leader</b> and press <b>Wipe disk</b>. Watch its log length reset and grow back.',
      predict: 'The node now has no log, term or vote. What brings it back to the same state as the others?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => H.client(c, /wiped disk of node/, b.ts).length > 0 && H.upCount(c) === c.n && !!c.leader && H.inSync(c),
      hint: (c, b) => H.client(c, /wiped disk of node/, b.ts).length ? 'Waiting for the node to be re-replicated...' : 'Pick a follower in Extra tools and press Wipe disk.',
      ok: 'The leader re-copied the whole log to the empty node: committed history lives on a majority, not on one disk.' },
  ],

  procedureExtra: `<div class="box"><b class="t">Tip</b>In step 4 you can press Kill on N1-N5 in quick succession; the lab recognises a full restart when every node's uptime is shorter than the time since the step began.</div>`,

  pretest: [
    { level: 'Beginner', q: 'What happens to a process\'s memory when it crashes?',
      opts: ['It is saved automatically', 'It is lost', 'It is copied to the leader', 'It moves to another node'], ans: 1,
      ex: ['Nothing saves memory automatically.', 'Correct: only data written to disk survives.', 'The leader does not hold followers\' memory.', 'Nothing moves by itself.'] },
    { level: 'Beginner', q: 'Which of these does a Raft node write to disk?',
      opts: ['Current term, vote and log', 'Only the lock table', 'Only client names', 'Nothing'], ans: 0,
      ex: ['Correct: these three are the persistent state.', 'The lock table can be rebuilt from the log.', 'Client names are inside the log entries.', 'Without persistence a crash could lose committed data.'] },
    { level: 'Beginner', q: 'A follower restarts after a crash. Where does it get its old log back from?',
      opts: ['A client', 'Its own disk', 'The dashboard', 'It does not'], ans: 1,
      ex: ['Clients do not store the log.', 'Correct: it reloads the file it wrote before crashing.', 'The dashboard is only a viewer.', 'It does, from disk.'] },
    { level: 'Intermediate', q: 'Why is the lock table not stored on disk?',
      opts: ['It is too big', 'It is fully determined by the log, so it can be rebuilt by replaying committed entries', 'Locks do not matter after a crash', 'Disks cannot store tables'], ans: 1,
      ex: ['Size is not the reason.', 'Correct: the log is the single source of truth.', 'They matter a lot.', 'Disks can store anything.'] },
    { level: 'Intermediate', q: 'Why must votedFor be saved before a node replies to a vote request?',
      opts: ['To save time later', 'To avoid voting twice in the same term after a crash', 'To tell clients who the leader is', 'To compress the log'], ans: 1,
      ex: ['It adds a disk write now; time is not the goal.', 'Correct: a double vote could elect two leaders in one term.', 'Clients use redirects for that.', 'Compression is unrelated.'] },
    { level: 'Intermediate', q: 'Why write a temporary file and then rename it?',
      opts: ['To make backups', 'The rename is atomic, so a crash leaves either the old or the new complete file', 'To hide the file', 'Because Windows requires it'], ans: 1,
      ex: ['Backups are not the purpose.', 'Correct: no half-written state file.', 'Hiding is irrelevant.', 'It is a general technique.'] },
    { level: 'Advanced', q: 'All five nodes crash and restart. What allows the committed locks to reappear?',
      opts: ['Clients resend all requests', 'Each node\'s disk still holds the committed log, which is replayed once a leader is elected', 'The gateway keeps a copy', 'Nothing: they are lost'], ans: 1,
      ex: ['Clients may not even be running.', 'Correct: durability comes from the persisted logs.', 'The gateway is stateless for locks.', 'That would violate durability.'] },
    { level: 'Advanced', q: 'A lock had a 30 s lease and the cluster was down for 60 s. After restart the lock is...',
      opts: ['Valid for another 30 s', 'Expired, and removed by the first sweep', 'Held forever', 'Transferred to the leader'], ans: 1,
      ex: ['Expiry is an absolute time stored in the log.', 'Correct: time kept running while the cluster was down.', 'Leases always end.', 'The leader does not take locks.'] },
    { level: 'Advanced', q: 'Why is a node with a wiped disk risky in real Raft deployments?',
      opts: ['It runs slower', 'It forgot its vote and could vote twice in a term; it should rejoin as a new member', 'It will delete the other logs', 'It cannot read the network'], ans: 1,
      ex: ['Speed is not the issue.', 'Correct: forgotten promises can break election safety.', 'It cannot delete other nodes\' logs.', 'Networking is unaffected.'] },
  ],

  posttest: [
    { level: 'Beginner', q: 'After one follower is restarted, it has the same locks as the others because...',
      opts: ['Someone copies a file', 'It reloads its log and receives missed entries from the leader', 'Clients repeat requests', 'It is reset to zero'], ans: 1,
      ex: ['Raft is automatic.', 'Correct: old log from disk plus catch-up from the leader.', 'Clients do not store the log.', 'It keeps its saved log.'] },
    { level: 'Beginner', q: 'The whole cluster restarts. Are the granted locks still known?',
      opts: ['No', 'Yes, if their leases have not expired', 'Only the newest', 'Only on the leader'], ans: 1,
      ex: ['The logs survive on disk.', 'Correct: the table is rebuilt; expired leases are swept.', 'All committed locks are rebuilt.', 'Every node rebuilds the table.'] },
    { level: 'Beginner', q: 'Which file contents are written before replying to an RPC that changes them?',
      opts: ['Term, vote and log', 'Dashboard layout', 'Client IP addresses', 'Event log text'], ans: 0,
      ex: ['Correct: these define the node\'s promises.', 'The dashboard is separate.', 'IPs are not part of Raft state.', 'The event log is only for display.'] },
    { level: 'Intermediate', q: 'Which part of the node\'s state is rebuilt, not loaded?',
      opts: ['The log', 'The lock table', 'The term', 'The vote'], ans: 1,
      ex: ['The log is loaded from disk.', 'Correct: it is computed by replaying committed entries.', 'The term is stored.', 'The vote is stored.'] },
    { level: 'Intermediate', q: 'A node crashes during a write of its state file. With temp-file-plus-rename, what does it find on restart?',
      opts: ['A half-written file', 'Either the previous or the new complete file', 'No file ever', 'A corrupted log'], ans: 1,
      ex: ['Rename is atomic.', 'Correct: that is the point of the technique.', 'The old file is still there.', 'No corruption occurs.'] },
    { level: 'Intermediate', q: 'After a whole-cluster restart, who can serve lock requests?',
      opts: ['Any node immediately', 'Only a leader elected by a majority that has committed its no-op', 'The node that crashed last', 'Clients themselves'], ans: 1,
      ex: ['A follower redirects to the leader.', 'Correct: a majority must be back and elect a leader.', 'Crash order does not matter.', 'Clients never serve locks.'] },
    { level: 'Advanced', q: 'You wipe one follower\'s disk and restart it. Why does the cluster stay safe in this lab?',
      opts: ['Because the node is ignored forever', 'Because a majority of other nodes still hold the committed log and the leader re-replicates it', 'Because the log is also on the dashboard', 'Because elections stop'], ans: 1,
      ex: ['It rejoins normally.', 'Correct: committed data lives on a majority.', 'The dashboard stores no log.', 'Elections continue as needed.'] },
    { level: 'Advanced', q: 'What would happen if currentTerm were not persisted?',
      opts: ['Nothing', 'After a restart the node could accept a stale leader\'s messages or stand in an old term', 'The log would double in size', 'Clients would get errors'], ans: 1,
      ex: ['Term protects against stale leaders.', 'Correct: persisting it keeps the node from going back in time.', 'Log size is unrelated.', 'Clients are not directly affected.'] },
    { level: 'Advanced', q: 'Why do production systems call fsync?',
      opts: ['To speed up writes', 'To make sure data has reached the physical disk, not just the OS cache, before acknowledging', 'To compress files', 'To lock the file for other processes'], ans: 1,
      ex: ['fsync is slower.', 'Correct: otherwise a power loss can drop acknowledged data.', 'Compression is unrelated.', 'It does not lock files.'] },
  ],

  refs: [
    'D. Ongaro, J. Ousterhout. <i>In Search of an Understandable Consensus Algorithm</i>, USENIX ATC 2014 (Figure 2: persistent state).',
    'T. Pillai et al. <i>All File Systems Are Not Created Equal: On the Complexity of Crafting Crash-Consistent Applications</i>, OSDI 2014.',
    'etcd documentation: <a href="https://etcd.io/docs/" target="_blank" rel="noopener">data directory, WAL and snapshots</a>',
    'Project documentation: <code>docs/PHASE1.md</code>, section 4 (recovery steps).',
  ],
};
