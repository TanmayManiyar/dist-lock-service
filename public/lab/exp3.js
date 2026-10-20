// Experiment 3: Log replication and quorum commit
window.EXP = {
  id: 'exp3',
  title: 'Experiment 3: Log Replication and Quorum Commit',

  aim: `<p>To observe how the leader copies every lock operation to its followers, why an operation counts as <b>committed</b> only after a majority has stored it, and what happens to writes when nodes crash.</p>
  <p>You will grant locks while watching the log length and commit index of every node, take followers down one by one, and then watch a restarted node catch up.</p>`,

  theory: `
<h2>The replicated log</h2>
<p>Every lock request (<code>acquire</code>, <code>renew</code>, <code>release</code>, lease <code>sweep</code>) becomes an entry in an ordered <b>log</b>. All five nodes apply the same entries in the same order to a deterministic <b>state machine</b> (the lock table), so they all reach the same answer to "who holds lock X?".</p>
<p>Each entry stores the <b>term</b> in which the leader created it and the command. Entries are numbered by <b>index</b>.</p>

<h2>Replication path</h2>
<ol>
<li>The client sends <code>acquire</code> to the leader.</li>
<li>The leader appends the command to its own log (and writes it to disk).</li>
<li>It sends <code>AppendEntries</code> to every follower, carrying the new entry plus the index and term of the entry just before it (<code>prevLogIndex / prevLogTerm</code>).</li>
<li>A follower accepts only if its log matches at <code>prevLogIndex</code> (the <b>log matching</b> check), stores the entry on disk, and replies success.</li>
<li>When the entry is stored on a <b>majority</b> (3 of 5 including the leader), the leader advances <code>commitIndex</code>.</li>
<li>The leader applies the entry to the lock table and replies to the client. Followers learn the new <code>commitIndex</code> from the next heartbeat and apply the entry too.</li>
</ol>

<div class="box tip"><b class="t">Log index vs commit index</b><b>Log</b> = how many entries a node has stored. <b>Commit</b> = how many are known to be on a majority and therefore safe to apply. A follower can have a longer log than its commit index for a moment: stored but not yet confirmed.</div>

<h2>Why wait for a majority?</h2>
<p>Any two majorities overlap. If an entry is on 3 of 5 nodes, every future leader must have been elected with votes from a majority, so at least one voter holds that entry, and the election restriction ensures the winner has it too. A committed lock grant therefore <b>can never be lost</b> by a crash of up to 2 nodes.</p>
<p>The client is told "granted" only <i>after</i> commit. A grant that was not committed may vanish after a leader crash, but the client was never promised it.</p>

<h2>Catching up</h2>
<p>A follower that was down has a shorter log. The leader keeps a <code>nextIndex</code> for each follower. If the log-matching check fails, the leader steps back and retries until it finds where the logs agree, then sends everything after that point. A restarted node therefore catches up automatically with no human action.</p>

<h2>Availability vs consistency</h2>
<ul>
<li>With <b>3 of 5</b> nodes up, commits still succeed (3 is a majority).</li>
<li>With <b>2 of 5</b> up, no entry can reach a majority. The leader steps down; requests fail. The service refuses to answer rather than risk two clients both believing they hold the lock (<b>CP</b> in CAP terms).</li>
</ul>
<div class="box warn"><b class="t">Common misconception</b>"Replication means every node must confirm." Only a majority must; the slowest nodes can be ignored.</div>`,

  steps: [
    { title: 'Inspect the logs',
      text: 'Scroll to the <b>node table</b> under the cluster ring. Compare <b>Log</b> and <b>Commit</b> for all five nodes.',
      predict: 'Will every node show the same log length and commit index?',
      check: c => H.upCount(c) === c.n && !!c.leader && H.inSync(c),
      hint: c => H.upCount(c) < c.n ? 'Restart stopped nodes or press Reset cluster.' : 'Wait a moment for the logs to settle.',
      ok: 'All five nodes hold the same fully committed log.' },
    { title: 'Grant a lock',
      text: 'In the <b>Lock client</b> card use a new key such as <code>file-1</code> and press <b>Acquire</b>. Watch Log and Commit on every node.',
      predict: 'By how many entries will each node\'s log grow? Do all nodes change at once?',
      baseline: c => ({ fence: H.fence(c) }),
      check: (c, b) => H.upCount(c) === c.n && H.up(c).every(n => n.fence > b.fence) && H.inSync(c),
      hint: (c, b) => `Acquire a lock with a key you have not used yet (grants so far: ${b.fence}).`,
      ok: 'The grant was replicated to all five nodes and committed everywhere.' },
    { title: 'Lose two followers',
      text: 'Press Kill for two <b>followers</b> (not the leader) so that 3 nodes remain. Then acquire another lock with a <b>new key</b> (e.g. <code>file-2</code>).',
      predict: 'Can the leader still commit with only 3 of 5 nodes?',
      baseline: c => ({ fence: H.fence(c) }),
      check: (c, b) => H.upCount(c) === 3 && !!c.leader && H.up(c).every(n => n.fence > b.fence),
      hint: c => `${H.upCount(c)} of ${c.n} nodes up. Kill followers until 3 remain, then acquire a lock with a new key.`,
      ok: 'A majority (3 of 5) is enough: the lock was granted and committed with two nodes down.' },
    { title: 'Lose the quorum',
      text: 'Kill one more node so only <b>2</b> remain, then press <b>Acquire</b> with a new key.',
      predict: 'What will the client see? Will the log of the surviving nodes change?',
      baseline: c => ({ ts: Date.now() }),
      check: (c, b) => H.upCount(c) <= 2 && !c.leader && H.client(c, /-> (no-leader|timeout|leadership-lost)/, b.ts).length > 0,
      hint: (c, b) => H.upCount(c) > 2 ? `${H.upCount(c)} nodes up. Kill until 2 remain.` : (H.client(c, /-> (no-leader|timeout|leadership-lost)/, b.ts).length ? 'Waiting for the leader to step down...' : 'Now press Acquire and wait for the error.'),
      ok: 'The write failed: with 2 of 5 nodes nothing can be committed, so the service refuses rather than guess.' },
    { title: 'Recover and catch up',
      text: 'Restart all stopped nodes. Watch the restarted nodes\' <b>Log</b> and <b>Commit</b> grow until they match the leader.',
      predict: 'Will the locks granted while those nodes were down appear on them automatically?',
      check: c => H.upCount(c) === c.n && !!c.leader && H.inSync(c) && new Set(c.nodes.map(n => n.fence)).size === 1,
      hint: c => H.upCount(c) < c.n ? `${H.upCount(c)} of ${c.n} up. Restart every stopped node.` : 'Waiting for the nodes to catch up...',
      ok: 'The restarted nodes caught up from the leader and hold the same lock history.' },
  ],

  procedureExtra: `<div class="box"><b class="t">Reading the node table</b><b>Log</b> = index of the last stored entry. <b>Commit</b> = index of the last entry known to be on a majority. Numbers can differ briefly while an entry is in flight.</div>`,

  pretest: [
    { level: 'Beginner', q: 'What is the replicated log in a Raft-based lock service?',
      opts: ['A text file of error messages', 'An ordered list of lock operations that every node applies in the same order', 'A backup that is only read after a crash', 'A list of connected clients'], ans: 1,
      ex: ['Error logs are different from the consensus log.', 'Correct: identical ordered operations give identical lock tables on every node.', 'Followers apply entries continuously, not only after crashes.', 'Clients are not stored in the log.'] },
    { level: 'Beginner', q: 'Who creates new log entries?',
      opts: ['Any node', 'Only the leader', 'The client', 'The follower with the shortest log'], ans: 1,
      ex: ['Multiple writers would conflict.', 'Correct: the single leader orders all operations.', 'Clients send requests; the leader turns them into entries.', 'Log length does not decide who writes.'] },
    { level: 'Beginner', q: 'In a 5-node cluster, how many nodes must store an entry before it is committed?',
      opts: ['1', '2', '3', '5'], ans: 2,
      ex: ['One copy is lost if that node crashes.', 'Two of five is not a majority.', 'Correct: a majority (3) guarantees overlap with any future majority.', 'Requiring all five would stop the service on a single failure.'] },
    { level: 'Intermediate', q: 'When should the leader tell the client that a lock was granted?',
      opts: ['As soon as it appends the entry locally', 'After the entry is committed (stored on a majority)', 'After every follower replies', 'Before writing to disk to be fast'], ans: 1,
      ex: ['A leader crash right then could lose the entry and the promise.', 'Correct: committed entries survive any minority of failures.', 'Waiting for all would block on one slow node.', 'Skipping the disk risks losing the grant after a restart.'] },
    { level: 'Intermediate', q: 'What is the difference between a node\'s log index and its commit index?',
      opts: ['They are always equal', 'Log index counts stored entries; commit index counts entries known to be on a majority', 'Commit index counts clients', 'Log index is the term number'], ans: 1,
      ex: ['They can differ while entries are in flight.', 'Correct: stored does not yet mean safe.', 'Clients are not counted.', 'The term is a separate number.'] },
    { level: 'Intermediate', q: 'With 3 of 5 nodes running, what happens to a new lock request?',
      opts: ['It fails', 'It succeeds, because 3 is a majority', 'It succeeds but is not durable', 'It waits until all nodes return'], ans: 1,
      ex: ['3 of 5 can still form a quorum.', 'Correct: the leader plus two followers is a majority, so entries commit.', 'Committed means durable on a majority.', 'No waiting for all nodes is needed.'] },
    { level: 'Advanced', q: 'What does the log-matching check in AppendEntries ensure?',
      opts: ['Entries are compressed', 'If two logs have the same index and term, all earlier entries are identical', 'Clients are authenticated', 'Heartbeats are encrypted'], ans: 1,
      ex: ['Compression is unrelated.', 'Correct: followers reject entries unless the previous entry matches, so divergence is detected.', 'Authentication is not part of Raft.', 'Encryption is separate.'] },
    { level: 'Advanced', q: 'A follower was down while 10 entries were committed. After restart, how does it catch up?',
      opts: ['An administrator copies the log by hand', 'The leader finds where the logs agree and resends everything after that point', 'It discards its log and the cluster restarts', 'It cannot rejoin'], ans: 1,
      ex: ['Raft needs no manual step.', 'Correct: the leader backs up nextIndex on failure and then replicates the missing suffix.', 'The cluster keeps running.', 'Crashed nodes can rejoin.'] },
    { level: 'Advanced', q: 'Why can an entry stored on only 2 of 5 nodes be lost, while one stored on 3 cannot?',
      opts: ['Two nodes fail more often', 'A later majority might contain neither of the two nodes, but any majority must include one of the three', 'Disks hold only 3 copies', 'The leader deletes minority entries immediately'], ans: 1,
      ex: ['Failure rates are not the argument.', 'Correct: any two majorities overlap, so a committed entry is seen by every future leader.', 'Disk limits are irrelevant.', 'The leader does not delete them at once; they may be overwritten later.'] },
  ],

  posttest: [
    { level: 'Beginner', q: 'You grant a lock and look at all five nodes. What do you expect?',
      opts: ['Only the leader\'s log grows', 'Every node\'s log grows by the same entry', 'Only a majority ever stores it', 'No node changes until the next election'], ans: 1,
      ex: ['Followers receive the entry via AppendEntries.', 'Correct: the entry is replicated everywhere (a majority is only needed for commit).', 'Followers store it too; commit just needs a majority.', 'Replication is continuous.'] },
    { level: 'Beginner', q: 'Two followers of a 5-node cluster are down. Can you still acquire a lock?',
      opts: ['No', 'Yes', 'Only for 5 seconds', 'Only if the leader is also restarted'], ans: 1,
      ex: ['Three nodes are still a majority.', 'Correct: the leader plus two remaining followers make 3 of 5, a majority.', 'There is no time limit.', 'No restart is needed.'] },
    { level: 'Beginner', q: 'Only 2 of 5 nodes are alive. What happens to an acquire request?',
      opts: ['It succeeds on the leader only', 'It fails: nothing can be committed', 'It succeeds after 10 seconds', 'It is saved and granted twice later'], ans: 1,
      ex: ['A grant on one node would not be safe.', 'Correct: no majority, no commit, no grant.', 'Waiting does not create a majority.', 'Duplicate grants are exactly what must be avoided.'] },
    { level: 'Intermediate', q: 'Why does a restarted follower end up with the same locks as the others?',
      opts: ['It asks clients for the lock list', 'The leader replicates the missing log entries and the follower replays them', 'It reads another node\'s disk', 'It restores a snapshot from the cloud'], ans: 1,
      ex: ['Clients do not hold the state.', 'Correct: log replication brings it to the same state.', 'Nodes never read each other\'s disks.', 'This lab has no snapshots; the log is replayed.'] },
    { level: 'Intermediate', q: 'A leader appends an entry but crashes before replicating it. What happens to that entry?',
      opts: ['It is always preserved', 'It is not committed and may be overwritten; the client never got a success reply', 'It is committed by the new leader automatically', 'It is applied on followers anyway'], ans: 1,
      ex: ['Uncommitted entries have no guarantee.', 'Correct: the client was not told it succeeded, so losing it is safe.', 'The new leader does not have it.', 'Followers never received it.'] },
    { level: 'Intermediate', q: 'The commit index of a follower is behind the leader\'s. Why?',
      opts: ['The follower is faulty', 'It learns the commit index through the next AppendEntries/heartbeat', 'Followers never commit', 'The log is corrupt'], ans: 1,
      ex: ['A short lag is normal.', 'Correct: leaderCommit is piggybacked on heartbeats.', 'Followers apply committed entries too.', 'No corruption is implied.'] },
    { level: 'Advanced', q: 'What happens if a follower rejects AppendEntries because its log does not match at prevLogIndex?',
      opts: ['The leader steps down', 'The leader decreases nextIndex for that follower and retries', 'The follower is removed forever', 'The entry is committed anyway'], ans: 1,
      ex: ['A mismatch is a normal repair situation.', 'Correct: the leader backs up until the logs agree, then overwrites the follower\'s divergent suffix.', 'Raft repairs, it does not evict.', 'Commit needs a majority of matches.'] },
    { level: 'Advanced', q: 'Which property makes it impossible to lose a committed lock grant after a leader crash?',
      opts: ['Random election timeouts', 'The election restriction: only a candidate with an up-to-date log can win a majority', 'Heartbeats every 120 ms', 'Fencing tokens'], ans: 1,
      ex: ['Timeouts only affect speed of elections.', 'Correct: majorities overlap, so the new leader always has every committed entry.', 'Heartbeats detect failure; they do not protect data.', 'Fencing protects resources from stale clients, not the log.'] },
    { level: 'Advanced', q: 'The service stops granting locks when only 2 of 5 nodes are up. In CAP terms this is...',
      opts: ['AP: available and partition tolerant', 'CP: consistent and partition tolerant, sacrificing availability', 'CA: always consistent and available', 'None of the above'], ans: 1,
      ex: ['An AP system would keep answering and risk conflicts.', 'Correct: the service refuses to answer rather than risk two lock holders.', 'No system can be both when partitions occur.', 'The behaviour matches CP.'] },
  ],

  refs: [
    'D. Ongaro, J. Ousterhout. <i>In Search of an Understandable Consensus Algorithm</i>, USENIX ATC 2014 (Sections 5.3 and 5.4).',
    'M. Burrows. <i>The Chubby Lock Service for Loosely-Coupled Distributed Systems</i>, OSDI 2006.',
    'Raft visualisation: <a href="https://raft.github.io" target="_blank" rel="noopener">raft.github.io</a>',
    'Project documentation: <code>docs/PHASE1.md</code>, section 3.1 (client write path).',
  ],
};
