// Experiment 5: Fencing tokens
const ctx5 = {};
const grabTok = (c, re, since) => H.client(c, re, since).map(e => +(e.msg.match(/token (\d+)/) || [])[1]).filter(Boolean);
const res5 = c => (c.resource || {})['shared-file'];

window.EXP = {
  id: 'exp5',
  title: 'Experiment 5: Fencing Tokens',

  aim: `<p>To see why a correct lock service is <b>still not enough</b> to protect a shared resource, and how <b>fencing tokens</b> close the gap.</p>
  <p>You will reproduce the classic failure: a client holds a lock, pauses past its lease, wakes up and writes after someone else has taken over. First the resource rejects the stale write (fencing ON); then you switch fencing OFF and watch the data get corrupted.</p>`,

  theory: `
<h2>Locks are leases</h2>
<p>A client that crashes while holding a lock must not block everyone forever, so locks here are <b>leases</b> with a time limit (TTL). If the lease runs out, the service grants the lock to someone else.</p>

<h2>The problem: the client cannot know its lease expired</h2>
<svg viewBox="0 0 640 210" style="max-width:640px;width:100%" role="img" aria-label="Timeline of a stale write">
  <g font-family="system-ui" font-size="12" fill="#cfd5e6">
  <text x="10" y="40">Client A</text><line x1="90" y1="36" x2="620" y2="36" stroke="#4c9aff" stroke-width="2"/>
  <text x="10" y="100">Client B</text><line x1="90" y1="96" x2="620" y2="96" stroke="#2ecc8f" stroke-width="2"/>
  <text x="10" y="165">Resource</text><line x1="90" y1="161" x2="620" y2="161" stroke="#8a93ab" stroke-width="2"/>
  <circle cx="130" cy="36" r="5" fill="#4c9aff"/><text x="105" y="20">acquire #7</text>
  <rect x="200" y="28" width="150" height="16" fill="#ff5d6c" opacity=".35"/><text x="215" y="22" fill="#ff5d6c">pause (GC / network)</text>
  <circle cx="290" cy="96" r="5" fill="#2ecc8f"/><text x="250" y="86">acquire #8 (A's lease expired)</text>
  <circle cx="340" cy="161" r="5" fill="#2ecc8f"/><text x="300" y="151">B writes #8: OK</text>
  <circle cx="450" cy="36" r="5" fill="#4c9aff"/><text x="420" y="20">A wakes, still thinks it owns</text>
  <circle cx="450" cy="161" r="5" fill="#ff5d6c"/><text x="410" y="190" fill="#ff5d6c">A writes #7: REJECTED</text>
  </g>
</svg>
<p>A client may pause for any reason (garbage collection, VM migration, network stall) <i>after</i> checking that it holds the lock and <i>before</i> using the resource. When it wakes up, its lease has expired and another client holds the lock, but the first client has no way to notice. Both then write. <b>Mutual exclusion in the lock service does not protect the resource.</b></p>

<h2>The fix: fencing tokens</h2>
<ul>
<li>Every successful grant returns a <b>fencing token</b>: a number that is <b>strictly increasing</b> across all grants (7, then 8, then 9&hellip;).</li>
<li>The client sends the token with every request to the resource.</li>
<li>The <b>resource</b> remembers the highest token it has seen and <b>rejects any request with a lower token</b>.</li>
</ul>
<p>The stale client from the timeline holds token 7, but the resource already accepted 8, so its write is refused.</p>

<h2>Where the token comes from</h2>
<p>The token is a counter inside the Raft-replicated state machine, incremented on each grant. Because it is replicated, it keeps counting upward even if the leader crashes: the new leader continues from the committed value. A token never repeats and never goes backwards.</p>

<div class="box tip"><b class="t">Key insight</b>The lock service decides <i>who should</i> hold the lock; the resource enforces <i>who is allowed</i> to write. Fencing needs both.</div>
<div class="box warn"><b class="t">Limitation</b>The resource must support the token check (storage systems and databases can; a plain file on disk cannot). This is the standard recommendation in the literature for lock-protected writes.</div>`,

  steps: [
    { title: 'Client A takes the lock',
      text: 'In the <b>Lock client</b> card set key <code>shared-file</code>, client name <code>client-A</code>, lease <code>3000</code> ms and press <b>Acquire</b>. Note the fencing token.',
      predict: 'What token number will A receive?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => { const t = grabTok(c, /client-A acquire "shared-file" -> OK/, b.ts); if (t.length) ctx5.tA = t[t.length - 1]; return t.length > 0; },
      hint: () => 'Use key shared-file, client-A, lease 3000, then Acquire.',
      ok: 'A holds the lock with a fencing token.' },
    { title: 'Client A writes',
      text: 'In the <b>Protected resource</b> card press <b>Write with token</b> (key, client name and token fields are shared with the Lock client card).',
      predict: 'Will the resource accept the write?',
      check: c => { const r = res5(c); return !!r && r.writer === 'client-A' && (!ctx5.tA || r.maxToken === ctx5.tA); },
      hint: () => 'Press Write with token while the fields still show client-A and its token.',
      ok: 'The resource accepted A\'s write and recorded the highest token.' },
    { title: 'A pauses, B takes over',
      text: 'Pretend A freezes. <b>Wait over 3 seconds</b> (its lease expires). Change the client name to <code>client-B</code> and press <b>Acquire</b>.',
      predict: 'Will B get the lock? Is B\'s token larger or smaller than A\'s?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => { const t = grabTok(c, /client-B acquire "shared-file" -> OK/, b.ts); if (t.length) ctx5.tB = t[t.length - 1]; return t.length > 0 && (!ctx5.tA || ctx5.tB > ctx5.tA); },
      hint: c => H.client(c, /client-B acquire "shared-file" -> held/, 0).length ? 'B was refused: A\'s lease has not expired yet. Wait a little longer and try again.' : 'Wait 3+ seconds, set the name to client-B, then Acquire.',
      ok: 'B received a strictly larger token than A.' },
    { title: 'B writes',
      text: 'With client name <code>client-B</code> and B\'s token showing, press <b>Write with token</b>.',
      predict: 'What will the resource store as the highest token?',
      check: c => { const r = res5(c); return !!r && r.writer === 'client-B' && (!ctx5.tB || r.maxToken === ctx5.tB); },
      hint: () => 'Press Write with token as client-B.',
      ok: 'The resource now remembers B\'s higher token.' },
    { title: 'Stale write is rejected',
      text: 'A wakes up and still believes it holds the lock. Change the client name to <code>client-A</code>, set the <b>Token</b> field back to A\'s token (shown in the hint under the step) and press <b>Write with token</b>.',
      predict: 'Will the resource accept the write from A?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => H.client(c, /RESOURCE rejected stale write to "shared-file" from client-A/, b.ts).length > 0,
      hint: () => ctx5.tA ? `Set client name client-A and token ${ctx5.tA}, then Write with token.` : 'Use A\'s original token.',
      ok: 'Rejected: A\'s old token is lower than the highest token the resource has seen.' },
    { title: 'Switch fencing OFF',
      text: 'In <b>Protocol settings</b> turn <b>Fencing check at resource OFF</b>. Repeat the stale write from <code>client-A</code> with A\'s old token. Look at the <b>Protected resource</b> table.',
      predict: 'Who will be the last writer of shared-file now? Is that correct?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => !!c.config && c.config.fencing === false && H.client(c, /RESOURCE accepted write to "shared-file" from client-A.*fencing OFF/, b.ts).length > 0,
      hint: c => c.config && c.config.fencing ? 'Turn fencing OFF first.' : 'Now press Write with token as client-A with A\'s old token.',
      ok: 'The stale client overwrote B\'s data: the corruption fencing prevents.' },
    { title: 'Tokens survive failover',
      text: 'Turn fencing back <b>ON</b>. Press <b>Kill</b> for the current leader, then acquire a lock with a <b>new key</b> as <code>client-C</code>. Compare the new token with the earlier ones.',
      predict: 'After the leader crashes, can the counter restart from 1 or repeat a token?',
      baseline: c => ({ leader: c.leader, ts: Date.now(), fence: H.fence(c) }),
      check: (c, b) => !!c.config && c.config.fencing === true && !!c.leader && c.leader !== b.leader && grabTok(c, /acquire ".*" -> OK/, b.ts).some(t => t > b.fence),
      hint: c => (c.config && c.config.fencing === false) ? 'Turn fencing ON.' : 'Kill the leader, wait for a new one, then Acquire with a new key.',
      ok: 'The token kept increasing across a leader crash because the counter is part of the replicated state.' },
  ],

  procedureExtra: `<div class="box"><b class="t">Tip</b>The lock client shows your latest token automatically after each Acquire. If you forgot A's token, the lab panel hint shows it.</div>`,

  pretest: [
    { level: 'Beginner', q: 'What is a fencing token?',
      opts: ['A password for the lock service', 'A number that increases with every lock grant', 'A timestamp of the client\'s clock', 'The name of the lock'], ans: 1,
      ex: ['It is not a secret.', 'Correct: later grants always have larger tokens.', 'Clocks are not used because they can be wrong.', 'The key names the lock; the token orders grants.'] },
    { level: 'Beginner', q: 'Why do lock services give locks a time limit (lease)?',
      opts: ['To save memory', 'So a crashed client cannot hold the lock forever', 'To make locks faster', 'Because clients are unreliable at naming'], ans: 1,
      ex: ['Memory is not the reason.', 'Correct: when the lease expires the lock can be re-granted.', 'Leases do not affect speed.', 'Naming is unrelated.'] },
    { level: 'Beginner', q: 'Client A\'s lease expires and client B gets the lock. What may A still believe?',
      opts: ['That it lost the lock', 'That it still holds the lock', 'That the service crashed', 'Nothing'], ans: 1,
      ex: ['A cannot notice automatically if it was paused.', 'Correct: A only finds out when it next talks to the service.', 'The service is fine.', 'A has its stale belief.'] },
    { level: 'Intermediate', q: 'Which component rejects a stale write when fencing is used?',
      opts: ['The lock service', 'The protected resource, by comparing tokens', 'The network', 'The client itself'], ans: 1,
      ex: ['The lock service is not in the write path.', 'Correct: the resource remembers the highest token and refuses lower ones.', 'The network does not understand tokens.', 'The stale client is the one that does not know.'] },
    { level: 'Intermediate', q: 'Why is it not enough for A to check "do I hold the lock?" right before writing?',
      opts: ['The check is too slow', 'A could pause between the check and the write, so the answer may be outdated when the write happens', 'The lock service always lies', 'Locks cannot be checked'], ans: 1,
      ex: ['Speed is not the issue.', 'Correct: there is always a gap between check and use.', 'The service is truthful at that instant.', 'Locks can be checked, but the answer expires.'] },
    { level: 'Intermediate', q: 'Client A gets token 7, then B gets token 8. A writes with 7 after B wrote with 8. With fencing, the result is...',
      opts: ['A\'s write overwrites B', 'A\'s write is rejected', 'Both writes are merged', 'B\'s write is undone'], ans: 1,
      ex: ['That is the bug fencing prevents.', 'Correct: 7 < 8.', 'The resource does not merge.', 'Earlier accepted writes stay.'] },
    { level: 'Advanced', q: 'Why is the token counter stored inside the Raft state machine?',
      opts: ['To look up client names', 'So it is replicated and keeps increasing after leader crashes', 'To make it random', 'To reduce disk use'], ans: 1,
      ex: ['Names are separate.', 'Correct: the committed counter survives failover, so tokens never repeat or go backwards.', 'Tokens must be ordered, not random.', 'It does not save disk.'] },
    { level: 'Advanced', q: 'Could wall-clock timestamps replace fencing tokens?',
      opts: ['Yes, always', 'Not safely: clocks on different machines can disagree or jump', 'Yes, if they are in UTC', 'Only for small clusters'], ans: 1,
      ex: ['Clock skew breaks ordering.', 'Correct: tokens come from one replicated counter, so ordering is exact.', 'UTC does not remove skew.', 'Cluster size is irrelevant.'] },
    { level: 'Advanced', q: 'What must a resource do to benefit from fencing?',
      opts: ['Nothing, the lock service handles it', 'Check each request\'s token against the highest seen and reject lower ones', 'Cache the lock table', 'Store the client\'s IP address'], ans: 1,
      ex: ['The lock service cannot stop writes it does not see.', 'Correct: enforcement happens at the resource.', 'A cache does not enforce anything.', 'IP is not an ordering.'] },
  ],

  posttest: [
    { level: 'Beginner', q: 'A is granted token 5; later B is granted the same lock. B\'s token is...',
      opts: ['5', 'Less than 5', 'Greater than 5', 'Random'], ans: 2,
      ex: ['Tokens never repeat.', 'Tokens never decrease.', 'Correct: strictly increasing.', 'Tokens are ordered, not random.'] },
    { level: 'Beginner', q: 'With fencing ON, A writes with an old token after B wrote. The resource...',
      opts: ['Accepts', 'Rejects', 'Asks the lock service', 'Crashes'], ans: 1,
      ex: ['That would corrupt data.', 'Correct: stale tokens are refused.', 'The resource decides locally.', 'It handles the request normally.'] },
    { level: 'Beginner', q: 'With fencing OFF, the same stale write is...',
      opts: ['Rejected', 'Accepted and overwrites the newer data', 'Delayed', 'Ignored silently'], ans: 1,
      ex: ['Nothing checks the token.', 'Correct: this is the corruption fencing prevents.', 'No delay is applied.', 'It is applied, not ignored.'] },
    { level: 'Intermediate', q: 'What causes the original problem in the first place?',
      opts: ['Raft fails to elect a leader', 'A client pauses beyond its lease without knowing', 'The log is too long', 'Followers lag'], ans: 1,
      ex: ['The lock service is behaving correctly.', 'Correct: the client\'s view of time is unreliable.', 'Log length is not involved.', 'Replication lag is unrelated.'] },
    { level: 'Intermediate', q: 'Does fencing make lock leases unnecessary?',
      opts: ['Yes', 'No, leases still free locks held by crashed clients', 'Only for short locks', 'Yes if tokens are large'], ans: 1,
      ex: ['Without leases a crash would block the lock forever.', 'Correct: leases give liveness, fencing gives safety.', 'Length does not matter.', 'Token size is irrelevant.'] },
    { level: 'Intermediate', q: 'After the leader crashes, the next grant has token 9 and the previous was 8. Why is that guaranteed?',
      opts: ['Luck', 'The counter is committed in the replicated log and the new leader continues from it', 'Clients remember tokens', 'The resource assigns tokens'], ans: 1,
      ex: ['It is a design property.', 'Correct: every node applies the same committed grants.', 'Clients can be stale or crash.', 'The resource only checks tokens.'] },
    { level: 'Advanced', q: 'What would break if the token counter lived only in the leader\'s memory?',
      opts: ['Nothing', 'After a failover the new leader could reissue old tokens, so a stale client could look valid', 'The log would become too large', 'Elections would fail'], ans: 1,
      ex: ['Failover would reset the ordering.', 'Correct: tokens must survive leader changes.', 'Log size is unaffected.', 'Elections are independent.'] },
    { level: 'Advanced', q: 'A resource accepts tokens >= the highest seen. Which scenario does this allow that "> highest" would not?',
      opts: ['A single client retrying a write with its own token', 'A stale client writing', 'Two clients with the same token', 'Tokens going backwards'], ans: 0,
      ex: ['Correct: equal tokens come from the same holder, so retries are safe; lower tokens are still rejected.', 'Stale clients have a lower token and are still rejected.', 'Tokens are unique per grant.', 'Backward tokens are rejected.'] },
    { level: 'Advanced', q: 'Which statement best summarises why fencing is needed?',
      opts: ['Raft is unreliable', 'A lock service can only guarantee who should hold the lock now, not stop a delayed client acting on an old grant', 'Clients are malicious', 'Networks never fail'], ans: 1,
      ex: ['Raft is fine; the issue is outside the service.', 'Correct: enforcement has to happen where the resource is used.', 'The scenario involves honest clients that are delayed.', 'The failure is a delay, not a network cut.'] },
  ],

  refs: [
    'M. Kleppmann. <i>How to do distributed locking</i>, 2016. <a href="https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html" target="_blank" rel="noopener">martin.kleppmann.com</a>',
    'M. Burrows. <i>The Chubby Lock Service for Loosely-Coupled Distributed Systems</i>, OSDI 2006 (sequencers).',
    'Apache ZooKeeper recipes: locks and fencing with zxid.',
    'Project documentation: <code>docs/PHASE1.md</code>, section 3.3 (fencing path).',
  ],
};
