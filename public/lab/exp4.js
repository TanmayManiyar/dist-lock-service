// Experiment 4: Network partitions and split brain
const healed = c => c.nodes.every(n => !n.up || !(n.blocked || []).length);
const allCfg = (c, k, v) => c.nodes.filter(n => n.up).every(n => n.config && n.config[k] === v);

window.EXP = {
  id: 'exp4',
  title: 'Experiment 4: Network Partitions and Split Brain',

  aim: `<p>To observe what a lock service does when the network splits the cluster into groups that cannot talk to each other, and to see how Raft prevents <b>split brain</b> (two leaders both handing out the same lock).</p>
  <p>You will isolate the leader, write on the majority side, heal the network, then switch protection features off one at a time to see exactly what each one is for.</p>`,

  theory: `
<h2>Partitions are different from crashes</h2>
<p>When a node crashes, it is silent. When the network partitions, <b>both sides keep running</b> and each believes the other has failed. A lock service must make sure that "I cannot reach the others" never leads to two holders of the same lock.</p>

<h2>The majority rule</h2>
<p>With 5 nodes split 3 | 2, only the group of 3 can elect a leader or commit entries. The group of 2 cannot reach a majority, so it can neither elect nor commit. At most <b>one</b> side can make progress, and that side is the only one that can grant locks.</p>

<h2>What happens to an isolated leader</h2>
<ul>
<li>The majority side stops hearing heartbeats, times out and elects a <b>new leader in a higher term</b>.</li>
<li>The old leader, cut off, still thinks it is leader. But it cannot replicate to a majority, so <b>nothing it accepts can commit</b>: its clients get no grants.</li>
<li><b>Check-quorum:</b> a leader that has not heard from a majority for about 1.5 s steps down on its own. This stops it serving stale reads and tells clients to look for the real leader.</li>
</ul>

<h2>Split brain</h2>
<p><b>Split brain</b> = two nodes both acting as leader and both able to commit. Raft makes this impossible: a term can have only one leader (one vote per node per term, majority needed), and committing needs a majority. You can briefly see <i>two nodes with the role "leader"</i> (a stale one and a current one), but only the one with the higher term can commit.</p>

<h2>Healing</h2>
<p>When the network heals, the stale leader receives a message with a higher term, steps down to follower, deletes any uncommitted entries that conflict, and copies the new leader's log.</p>

<h2>PreVote</h2>
<p>An isolated follower hears no heartbeats, so it keeps timing out and raising its term (term 5, 6, 7, &hellip;) even though it can never win. When it reconnects, its huge term forces the healthy leader to step down and triggers a needless election. With <b>PreVote</b> the node first asks "would you vote for me?" without changing its term; with no majority reachable the answer is no and the term stays put.</p>

<div class="box tip"><b class="t">Reading the ring</b>Dashed red lines are broken links. Nodes keep running even when links are cut: the table's "Cut off from" column shows what each node cannot reach.</div>
<div class="box warn"><b class="t">Common misconception</b>"The old leader sees nobody, so it must be dead." It is alive and still believes it is leader. That is exactly why terms and quorums exist.</div>`,

  steps: [
    { title: 'Healthy cluster',
      text: 'Check that all 5 nodes are up, one is leader, and no links are cut (the "Cut off from" column shows a dash).',
      predict: 'Which node is the leader and what term is it in?',
      check: c => H.upCount(c) === c.n && H.leaders(c).length === 1 && healed(c),
      hint: c => !healed(c) ? 'Press Heal network.' : H.upCount(c) < c.n ? 'Restart stopped nodes or press Reset cluster.' : 'Wait for a single leader.',
      ok: 'Healthy start: one leader, full connectivity.' },
    { title: 'Isolate the leader',
      text: 'Press <b>Isolate leader</b>. The old leader keeps running but can no longer reach any other node. Wait 3 seconds and watch roles and terms.',
      predict: 'Who will lead the cluster now? What will the isolated node think it is?',
      baseline: c => ({ leader: c.leader, term: H.maxTerm(c) }),
      check: (c, b) => !!c.leader && c.leader !== b.leader && H.maxTerm(c) > b.term && !!H.node(c, b.leader) && H.node(c, b.leader).role !== 'leader',
      hint: (c, b) => b.leader ? `Press Isolate leader (current leader: N${b.leader}).` : '',
      ok: 'The majority elected a new leader in a higher term; the cut-off leader stepped down (check-quorum).' },
    { title: 'Write on the majority side',
      text: 'Acquire a lock with a new key (e.g. <code>part-1</code>). Requests are routed to the leader of the majority side.',
      predict: 'Will the grant succeed even though one node is unreachable?',
      check: c => !!c.leader && c.nodes.some(n => n.up && n.fence < H.node(c, c.leader).fence),
      hint: () => 'Press Acquire in the Lock client card with a key you have not used.',
      ok: 'The 4-node side committed the grant; the isolated node knows nothing about it.' },
    { title: 'Heal the network',
      text: 'Press <b>Heal network</b>. Watch the isolated node: its role, term, log and commit.',
      predict: 'Will the old leader take over again? Will it learn about the lock you granted?',
      check: c => H.upCount(c) === c.n && healed(c) && H.leaders(c).length === 1 && H.inSync(c) && new Set(c.nodes.map(n => n.fence)).size === 1,
      hint: c => !healed(c) ? 'Press Heal network.' : 'Waiting for the logs to converge...',
      ok: 'One leader, one history: the old leader followed the new leader and caught up.' },
    { title: 'Two leaders, one truth',
      text: 'In <b>Protocol settings</b> turn <b>Leader check-quorum OFF</b>, then press <b>Isolate leader</b> again. Wait 3 seconds and look at the node table.',
      predict: 'How many nodes will report the role "leader"? Can both grant locks?',
      check: c => c.nodes.some(n => n.up && n.config && n.config.checkQuorum === false) && H.leaders(c).length >= 2,
      hint: c => `Leaders reported: ${H.leaders(c).length}. Needs check-quorum OFF and an isolated leader.`,
      ok: 'Two nodes claim leadership, but the stale one has a lower term and cannot reach a majority, so it cannot commit anything.' },
    { title: 'Heal and restore protection',
      text: 'Press <b>Heal network</b> and turn <b>Leader check-quorum ON</b> again.',
      predict: 'Which of the two leaders gives up, and why?',
      check: c => H.upCount(c) === c.n && healed(c) && allCfg(c, 'checkQuorum', true) && H.leaders(c).length === 1 && H.inSync(c),
      hint: c => `${!healed(c) ? 'Network still cut. ' : ''}${!allCfg(c, 'checkQuorum', true) ? 'Check-quorum still OFF. ' : ''}${H.leaders(c).length !== 1 ? 'Waiting for one leader.' : ''}`,
      ok: 'The lower-term leader saw the higher term and stepped down.' },
    { title: 'Inflate a term',
      text: 'Turn <b>PreVote OFF</b>, then press <b>Split majority | minority</b>. Two nodes are now isolated. Wait 4 seconds and compare the <b>Term</b> column.',
      predict: 'The minority can never win an election. Will its term stay put?',
      check: c => c.nodes.some(n => n.up && n.config && n.config.prevote === false) && !!c.leader && c.nodes.some(n => n.up && n.role !== 'leader' && n.term >= H.node(c, c.leader).term + 3),
      hint: c => `PreVote must be OFF and the cluster split. Leader term: ${c.leader ? H.node(c, c.leader).term : '-'}.`,
      ok: 'The isolated nodes kept raising their term although they could never win.' },
    { title: 'Heal and watch the disruption',
      text: 'Keep PreVote OFF and press <b>Heal network</b>. Watch the leader and the term.',
      predict: 'The reconnecting nodes have a much higher term. What will happen to the healthy leader?',
      baseline: c => ({ term: c.leader ? H.node(c, c.leader).term : H.maxTerm(c) }),
      check: (c, b) => H.upCount(c) === c.n && healed(c) && H.leaders(c).length === 1 && new Set(c.nodes.map(n => n.term)).size === 1 && H.maxTerm(c) >= b.term + 3,
      hint: (c, b) => `Heal the network. Waiting for the cluster to settle (leader term was ${b.term}).`,
      ok: 'The healthy leader was forced out by the returning high term: an unnecessary election.' },
    { title: 'Turn PreVote back on',
      text: 'Turn <b>PreVote ON</b>. Optionally repeat the split to see the minority terms stay unchanged.',
      predict: 'With PreVote on, will isolated nodes inflate their term?',
      check: c => allCfg(c, 'prevote', true) && H.leaders(c).length === 1 && healed(c),
      hint: () => 'Turn PreVote ON and make sure the network is healed.',
      ok: 'Safe settings restored.' },
  ],

  procedureExtra: `<div class="box"><b class="t">Tip</b>If the cluster gets into an odd state, press <b>Reset cluster</b> in the lab panel (it wipes node data and restores default settings).</div>`,

  pretest: [
    { level: 'Beginner', q: 'What is a network partition?',
      opts: ['A node crashing', 'The network splitting so that groups of nodes cannot reach each other while all keep running', 'A full disk', 'A slow client'], ans: 1,
      ex: ['A crash is a node failure, not a network failure.', 'Correct: both sides stay alive and each believes the other failed.', 'Disk faults are unrelated to the network.', 'Client speed is not a partition.'] },
    { level: 'Beginner', q: 'A 5-node cluster splits 3 | 2. Which side can elect a leader and grant locks?',
      opts: ['The side with 2 nodes', 'The side with 3 nodes', 'Both sides', 'Neither side'], ans: 1,
      ex: ['2 of 5 is not a majority.', 'Correct: 3 of 5 is a majority.', 'Two leaders would be split brain.', 'The majority side can proceed.'] },
    { level: 'Beginner', q: 'What is "split brain"?',
      opts: ['A leader with a corrupted log', 'Two nodes both acting as leader and both able to grant the same lock', 'Two clients with the same name', 'Dividing the log into two files'], ans: 1,
      ex: ['That is corruption, not split brain.', 'Correct: it breaks mutual exclusion.', 'Client names are unrelated.', 'Splitting files is not split brain.'] },
    { level: 'Intermediate', q: 'After being isolated, the old leader still believes it is leader. Why is that not dangerous?',
      opts: ['It cannot send any messages', 'It cannot replicate to a majority, so nothing it accepts can be committed', 'Clients ignore it', 'It deletes its log'], ans: 1,
      ex: ['It may still send messages; they just do not arrive.', 'Correct: commits need a majority, which it cannot reach.', 'Clients may still try it.', 'It keeps its log.'] },
    { level: 'Intermediate', q: 'What does check-quorum do?',
      opts: ['Checks client passwords', 'Makes a leader step down if it cannot hear from a majority', 'Counts lock holders', 'Checks disk space'], ans: 1,
      ex: ['No authentication is involved.', 'Correct: a cut-off leader stops pretending to lead and stops serving stale reads.', 'Lock counting is separate.', 'Disk space is unrelated.'] },
    { level: 'Intermediate', q: 'When a partition heals, what happens to the old leader?',
      opts: ['It stays leader', 'It sees a higher term, steps down, and catches up from the new leader', 'It is permanently banned', 'The cluster restarts'], ans: 1,
      ex: ['Two leaders would persist.', 'Correct: terms order leadership; higher always wins.', 'Raft has no banning.', 'No restart is needed.'] },
    { level: 'Advanced', q: 'Why can two nodes show the role "leader" at the same time without breaking safety?',
      opts: ['Safety is not guaranteed in Raft', 'They are in different terms and only the higher-term one can reach a majority and commit', 'Both can commit; conflicts are fixed later', 'The leaders alternate'], ans: 1,
      ex: ['Raft guarantees at most one leader per term and commits only with a majority.', 'Correct: leadership in a lower term is stale and powerless.', 'Committed entries are never undone.', 'There is no alternation.'] },
    { level: 'Advanced', q: 'What can happen to uncommitted entries on a stale leader after healing?',
      opts: ['They are committed', 'They are overwritten by the new leader\'s log', 'They are copied to all nodes', 'They block the cluster'], ans: 1,
      ex: ['They never reached a majority.', 'Correct: the log-matching repair truncates conflicting uncommitted suffixes.', 'Followers follow the current leader\'s log.', 'They are simply replaced.'] },
    { level: 'Advanced', q: 'A node isolated for a long time rejoins. Without PreVote, what is the likely effect?',
      opts: ['None', 'Its inflated term forces the healthy leader to step down, causing an unnecessary election', 'It becomes leader instantly', 'It crashes'], ans: 1,
      ex: ['Terms matter greatly.', 'Correct: any message with a higher term makes the receiver step down.', 'It must still win an election.', 'It does not crash.'] },
  ],

  posttest: [
    { level: 'Beginner', q: 'In a 5-node cluster, how many nodes can be on the minority side of a partition and still be unable to commit?',
      opts: ['Up to 2', 'Exactly 3', 'Only 1', 'Any number'], ans: 0,
      ex: ['Correct: 1 or 2 nodes cannot form a majority of 5.', 'Three is a majority and can commit.', 'Two nodes are also unable.', 'A group of 3 or more can commit.'] },
    { level: 'Beginner', q: 'You isolate the leader and grant a lock. Who grants it?',
      opts: ['The isolated old leader', 'The new leader on the majority side', 'No one', 'All nodes together'], ans: 1,
      ex: ['It cannot reach a majority.', 'Correct: the majority side elected a new leader in a higher term.', 'The majority side keeps working.', 'The isolated node is unreachable.'] },
    { level: 'Beginner', q: 'After healing, all nodes have the same log. How?',
      opts: ['An administrator copies it', 'The new leader replicates its log to the nodes that missed entries', 'They exchange random entries', 'Clients resend everything'], ans: 1,
      ex: ['Raft is automatic.', 'Correct: followers are repaired by AppendEntries.', 'There is no random exchange.', 'Clients are not involved.'] },
    { level: 'Intermediate', q: 'With check-quorum OFF, you isolate the leader. What do you observe?',
      opts: ['Nothing changes', 'Two nodes report leader; the stale one is in a lower term', 'The cluster stops', 'Both leaders commit'], ans: 1,
      ex: ['The majority elects a new leader.', 'Correct: the stale leader never learns it lost leadership while cut off.', 'The majority side keeps serving.', 'Only the majority-side leader can commit.'] },
    { level: 'Intermediate', q: 'Why does a higher term always win?',
      opts: ['Because it is newer data on disk', 'Terms order leadership periods; a node seeing a higher term knows its own leadership is stale', 'Because higher numbers are faster', 'Clients prefer higher terms'], ans: 1,
      ex: ['Terms are not about disk age.', 'Correct: that is how stale leaders are detected.', 'Speed is not involved.', 'Clients do not choose.'] },
    { level: 'Intermediate', q: 'Which statement about partitions and the CAP theorem fits this lock service?',
      opts: ['It stays available on both sides', 'It stays consistent by making the minority side unavailable', 'It ignores consistency', 'It has no partition tolerance'], ans: 1,
      ex: ['That would allow two lock holders.', 'Correct: CP behaviour.', 'Mutual exclusion is the whole point.', 'It tolerates partitions by pausing the minority.'] },
    { level: 'Advanced', q: 'With PreVote OFF, an isolated follower\'s term climbs. Why does it keep raising its term?',
      opts: ['It is faulty', 'It never hears a leader, times out repeatedly and starts new elections that cannot win', 'Clients keep asking', 'Terms increase with time automatically'], ans: 1,
      ex: ['It is behaving as specified.', 'Correct: every timeout starts a new term, but a majority is unreachable.', 'Clients cannot reach it.', 'Terms change only on elections.'] },
    { level: 'Advanced', q: 'How does PreVote prevent the problem?',
      opts: ['It disables elections', 'A node must first win a no-side-effects poll of a majority before incrementing its term', 'It copies terms between nodes', 'It sets a fixed term'], ans: 1,
      ex: ['Elections still work normally.', 'Correct: an isolated node cannot get pre-votes so its term does not move.', 'Nothing is copied.', 'Terms are not fixed.'] },
    { level: 'Advanced', q: 'A stale leader appended an entry during isolation. After healing, what must happen to maintain safety?',
      opts: ['The entry must be committed', 'The entry is discarded in favour of the new leader\'s log', 'The new leader appends it too', 'All nodes restart'], ans: 1,
      ex: ['It never had majority acknowledgement.', 'Correct: the client was never told it succeeded.', 'The new leader never saw it.', 'Restarts are not needed.'] },
  ],

  refs: [
    'D. Ongaro. <i>Consensus: Bridging Theory and Practice</i>, PhD thesis, Stanford 2014 (PreVote, check-quorum, Chapter 9).',
    'S. Gilbert, N. Lynch. <i>Brewer\'s Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services</i>, 2002.',
    'Raft visualisation: <a href="https://raft.github.io" target="_blank" rel="noopener">raft.github.io</a>',
    'Project documentation: <code>docs/PHASE1.md</code>, section 4 (failure strategy, rows 5-7).',
  ],
};
