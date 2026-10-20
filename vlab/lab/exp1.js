// Experiment 1: Mutual exclusion with leases
const K1 = 'orders-db';
const ev1 = (c, owner, op, tail, since) => H.client(c, new RegExp(`${owner} ${op} "${K1}" -> ${tail}`), since);

window.EXP = {
  id: 'exp1',
  title: 'Experiment 1: Mutual Exclusion with Leases',

  aim: `<p>To understand how a lock service guarantees that <b>only one client at a time</b> holds a lock, and how <b>leases</b> (time-limited locks) keep the system alive when a client crashes or forgets to release.</p>
  <p>You will contend for a lock with two clients, renew a lease, try to release someone else's lock, and watch a lease expire on its own.</p>`,

  theory: `
<h2>Mutual exclusion</h2>
<p>A <b>lock</b> lets many clients coordinate access to something that must not be used by two of them at once: a file, a database row, the "primary" role. The lock service keeps a table of <code>key &rarr; (owner, token, expiry)</code>. At most one owner may be recorded per key.</p>

<h2>Operations</h2>
<table style="width:100%;border-collapse:collapse">
<tr><th style="text-align:left">Operation</th><th style="text-align:left">Succeeds when</th><th style="text-align:left">Result</th></tr>
<tr><td><code>acquire(key, owner, ttl)</code></td><td>the key is free, expired, or already held by the same owner</td><td>fencing token, expiry time</td></tr>
<tr><td><code>renew(key, owner, token, ttl)</code></td><td>owner and token match and the lease has not expired</td><td>new expiry time</td></tr>
<tr><td><code>release(key, owner, token)</code></td><td>owner and token match</td><td>lock removed</td></tr>
</table>
<p>If another client holds the lock, <code>acquire</code> fails with <i>held</i> and tells you who holds it. Only the real owner (matching both name <b>and token</b>) can renew or release, so a confused client cannot free someone else's lock.</p>

<h2>Why leases?</h2>
<p>A lock without a time limit has a fatal flaw: if its owner crashes, the lock is held forever. A <b>lease</b> is a lock that expires after a <b>TTL</b> (time to live) unless renewed. Crashed clients lose the lock automatically; healthy clients renew it before it expires (usually after about one third of the TTL has passed).</p>
<ul>
<li><b>Short TTL:</b> fast recovery after a crash, but more renewals and a risk of losing the lock during a brief pause.</li>
<li><b>Long TTL:</b> few renewals, but a crashed owner blocks others for a long time.</li>
</ul>

<h2>How expiry works in a replicated service</h2>
<p>All five replicas must agree on whether a lock has expired. Each command carries the leader's timestamp, and the leader periodically proposes a <code>sweep</code> command that deletes every expired lock. Because the sweep goes through the replicated log like any other command, every replica removes the same locks at the same point in the sequence of operations.</p>

<div class="box tip"><b class="t">Safety vs liveness</b><b>Safety</b> (never two holders) comes from the replicated log. <b>Liveness</b> (locks do not stay stuck) comes from leases. A client that is merely <i>slow</i> can still act after its lease expired; Experiment 5 (fencing tokens) shows how to protect against that.</div>
<div class="box warn"><b class="t">Common misconception</b>"Release the lock and it is immediately free for everyone." True only if the release is committed. A release that fails because of a lost leader is not applied; the lease will still expire on its own.</div>`,

  steps: [
    { title: 'Client A acquires the lock',
      text: 'In the <b>Lock client</b> card keep key <code>orders-db</code>, client <code>client-A</code>, lease <code>8000</code> ms and press <b>Acquire</b>.',
      predict: 'Will the grant succeed? What will the lock table show for the holder and lease?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => ev1(c, 'client-A', 'acquire', 'OK', b.ts).length > 0,
      hint: () => 'Press Acquire as client-A on key orders-db.',
      ok: 'A holds the lock; the lease countdown is visible in the held locks table.' },
    { title: 'Client B is refused',
      text: 'Change the client name to <code>client-B</code> and press <b>Acquire</b> on the same key while A\'s lease is still running.',
      predict: 'What will B see?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => ev1(c, 'client-B', 'acquire', 'held', b.ts).length > 0,
      hint: () => 'Act within A\'s lease (8 s). If it already expired, have client-A acquire again first.',
      ok: 'B was refused: mutual exclusion in action.' },
    { title: 'Renew the lease',
      text: 'Switch back to <code>client-A</code> (token field = A\'s token) and press <b>Renew</b> before the lease ends. Watch the countdown bar jump back.',
      predict: 'Does renewing change the fencing token?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => ev1(c, 'client-A', 'renew', 'OK', b.ts).length > 0,
      hint: () => 'Use client-A with its token and press Renew before the lease expires; re-acquire if it already expired.',
      ok: 'The lease was extended and the token stayed the same.' },
    { title: 'Release someone else\'s lock',
      text: 'Set the client name to <code>client-B</code> but leave A\'s token in the Token field, then press <b>Release</b>.',
      predict: 'Can B free A\'s lock by guessing the token?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => ev1(c, 'client-B', 'release', 'not-holder', b.ts).length > 0,
      hint: () => 'client-B + A\'s token + Release. If A\'s lease expired, re-acquire as client-A first.',
      ok: 'Refused: release requires the real owner and token.' },
    { title: 'Hand over the lock',
      text: 'As <code>client-A</code> with its token press <b>Release</b>. Then switch to <code>client-B</code> and press <b>Acquire</b>.',
      predict: 'How does B\'s token compare with A\'s?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => ev1(c, 'client-A', 'release', 'OK', b.ts).length > 0 && ev1(c, 'client-B', 'acquire', 'OK', b.ts).length > 0,
      hint: c => ev1(c, 'client-A', 'release', 'OK', 0).length ? 'Now acquire as client-B.' : 'Release as client-A first.',
      ok: 'B got the lock right after A released it, with a larger token.' },
    { title: 'Let a lease expire',
      text: 'As <code>client-B</code> set the lease to <code>2000</code> ms and press <b>Acquire</b> (or Renew). Do <b>nothing</b> for 3 seconds, watching the held locks table. Then press <b>Renew</b> as client-B.',
      predict: 'Will the lock still be in the table after 3 seconds? Will Renew work?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => ev1(c, 'client-B', 'renew', 'not-holder', b.ts).length > 0,
      hint: () => 'Acquire with a 2000 ms lease, wait over 2 seconds, then press Renew.',
      ok: 'The lease expired on its own and the late renew was refused.' },
    { title: 'Same owner, same token',
      text: 'As <code>client-A</code> press <b>Acquire</b> twice in a row on the same key.',
      predict: 'Does the second acquire create a new lock or return the existing one?',
      baseline: () => ({ ts: Date.now() }),
      check: (c, b) => { const t = H.client(c, new RegExp(`client-A acquire "${K1}" -> OK token`), b.ts).map(e => e.msg.match(/token (\d+)/)[1]); return t.length >= 2 && t[t.length - 1] === t[t.length - 2]; },
      hint: () => 'Acquire as client-A twice within its lease.',
      ok: 'Repeating an acquire is harmless (idempotent): the owner keeps the same token.' },
  ],

  procedureExtra: `<div class="box"><b class="t">Tip</b>The Token field fills automatically after every successful Acquire. If the lock has already expired, just acquire again.</div>`,

  pretest: [
    { level: 'Beginner', q: 'What does a lock guarantee?',
      opts: ['The work finishes faster', 'At most one client holds it at a time', 'Every client eventually gets it first', 'Data is encrypted'], ans: 1,
      ex: ['Locks serialise access; they do not speed it up.', 'Correct: this is mutual exclusion.', 'There is no fairness guarantee.', 'Locks do not encrypt.'] },
    { level: 'Beginner', q: 'What is a lease?',
      opts: ['A permanent lock', 'A lock that expires after a time limit unless renewed', 'A copy of a lock', 'A client password'], ans: 1,
      ex: ['A permanent lock is the opposite.', 'Correct: expiry frees locks held by crashed clients.', 'Leases are not copies.', 'Passwords are unrelated.'] },
    { level: 'Beginner', q: 'Client B asks for a lock that A holds. What should the service answer?',
      opts: ['Grant it to B as well', 'Refuse and say who holds it', 'Delete A\'s lock', 'Crash'], ans: 1,
      ex: ['That would break mutual exclusion.', 'Correct: B is told the lock is held.', 'A still owns it until release or expiry.', 'The service keeps running.'] },
    { level: 'Intermediate', q: 'Why does a release require both owner and token?',
      opts: ['To make requests larger', 'So a client cannot free a lock it does not hold', 'Because tokens are secret keys', 'To track clients'], ans: 1,
      ex: ['Size is irrelevant.', 'Correct: only the grant holder knows the matching token.', 'Tokens order grants; they are not security secrets here.', 'Tracking is not the goal.'] },
    { level: 'Intermediate', q: 'What happens when a client renews its lease in time?',
      opts: ['It gets a new lock with a new token', 'The expiry moves later and the token stays the same', 'The lock is released', 'Other clients are told to wait'], ans: 1,
      ex: ['Renew extends the existing grant.', 'Correct: same holder, same token, later expiry.', 'Renew keeps the lock.', 'Other clients are simply refused while it is held.'] },
    { level: 'Intermediate', q: 'Why does a lock service use a TTL instead of waiting for an explicit release?',
      opts: ['Release messages are too large', 'A crashed client can never send a release', 'TTLs are cheaper than log entries', 'Clients forget their names'], ans: 1,
      ex: ['Release messages are tiny.', 'Correct: expiry is the only way to recover the lock from a dead client.', 'Cost is not the point.', 'Naming is not the problem.'] },
    { level: 'Advanced', q: 'Why does the leader carry its timestamp inside each command?',
      opts: ['To sort the log by time', 'So every replica makes the same expiry decision regardless of its own clock', 'To measure network latency', 'To sign requests'], ans: 1,
      ex: ['The log order is given by indexes.', 'Correct: the state machine stays deterministic.', 'Latency is not measured.', 'Signing is separate.'] },
    { level: 'Advanced', q: 'Why does the leader propose a "sweep" command instead of replicas deleting expired locks themselves?',
      opts: ['It is easier to code', 'Each replica deleting by its own clock could disagree on when a lock disappeared', 'Followers cannot delete', 'Sweeps are faster'], ans: 1,
      ex: ['Correctness is the reason, not convenience.', 'Correct: replicating the sweep keeps all replicas identical.', 'Followers apply commands like any node.', 'Speed is not the reason.'] },
    { level: 'Advanced', q: 'A very long TTL has what main drawback?',
      opts: ['More renewals', 'A crashed holder blocks everyone until the lease runs out', 'Tokens grow faster', 'Elections happen more often'], ans: 1,
      ex: ['Long TTLs need fewer renewals.', 'Correct: recovery time after a crash equals the remaining TTL.', 'Tokens depend on grants.', 'TTL does not affect elections.'] },
  ],

  posttest: [
    { level: 'Beginner', q: 'A holds the lock; B tries to acquire. The result for B is...',
      opts: ['Success', 'held, with the owner\'s name', 'A crash', 'A new token'], ans: 1,
      ex: ['That would allow two holders.', 'Correct: B is refused and told who holds it.', 'The service stays up.', 'Tokens are only for grants.'] },
    { level: 'Beginner', q: 'After A releases, B acquires. B\'s token is...',
      opts: ['The same as A\'s', 'Larger than A\'s', 'Zero', 'Random'], ans: 1,
      ex: ['Each grant gets a new token.', 'Correct: tokens strictly increase.', 'Zero is never reused.', 'Tokens are ordered, not random.'] },
    { level: 'Beginner', q: 'A client stops renewing and does not release. What eventually happens to the lock?',
      opts: ['It stays forever', 'It expires and the leader\'s sweep removes it', 'It moves to B automatically', 'It moves to the follower nodes'], ans: 1,
      ex: ['That is the problem leases solve.', 'Correct: expiry is replicated like any other command.', 'B must still ask for it.', 'Replication is about copies, not ownership transfer.'] },
    { level: 'Intermediate', q: 'client-B tries to renew after its lease expired. What does the service answer?',
      opts: ['OK with a new token', 'not-holder', 'held', 'Nothing'], ans: 1,
      ex: ['A renew cannot resurrect an expired lease.', 'Correct: B must acquire again.', 'held is the answer to a failed acquire.', 'It answers with an error.'] },
    { level: 'Intermediate', q: 'client-A acquires the same key twice within its lease. The second answer is...',
      opts: ['held', 'OK with the same token', 'OK with a new token', 'error'], ans: 1,
      ex: ['A is the owner, so it is not blocked.', 'Correct: acquire is idempotent for the current holder.', 'A new token would imply a new grant.', 'There is no error.'] },
    { level: 'Intermediate', q: 'Why renew after about one third of the TTL, not at the very end?',
      opts: ['To waste fewer messages', 'To leave time to retry if a renew message is lost or delayed', 'Because tokens expire sooner', 'Because leaders change'], ans: 1,
      ex: ['Earlier renewals send more messages.', 'Correct: a margin lets you survive a few failures.', 'Tokens do not expire.', 'Leader changes are rare.'] },
    { level: 'Advanced', q: 'Which property comes from the replicated log and which from the TTL?',
      opts: ['Safety from the TTL, liveness from the log', 'Safety (one holder) from the log, liveness (no stuck locks) from the TTL', 'Both from the TTL', 'Both from the log'], ans: 1,
      ex: ['It is the other way round.', 'Correct: agreement gives exclusion; expiry prevents deadlock.', 'The TTL alone could not stop two grants.', 'The log alone would leave dead locks in place.'] },
    { level: 'Advanced', q: 'A client is paused for longer than its lease, wakes up and keeps working. What does this show?',
      opts: ['The lock service is broken', 'A lease cannot stop a delayed client from acting; a resource-side check (fencing) is needed', 'Leases should be removed', 'The client has a bug in renew'], ans: 1,
      ex: ['The service behaved correctly.', 'Correct: this is exactly the gap Experiment 5 addresses.', 'Removing leases would create stuck locks.', 'The client simply could not run.'] },
    { level: 'Advanced', q: 'A release is sent but the leader crashes before committing it. What is the correct outcome?',
      opts: ['The lock is certainly released', 'The release may not have happened; the client retries or the lease expires', 'The new leader grants B the lock immediately', 'All locks are deleted'], ans: 1,
      ex: ['Only committed commands take effect.', 'Correct: the client should retry; releasing is safe to repeat.', 'B is refused until the lock is really free.', 'Nothing else is deleted.'] },
  ],

  refs: [
    'C. Gray, D. Cheriton. <i>Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency</i>, SOSP 1989.',
    'M. Burrows. <i>The Chubby Lock Service for Loosely-Coupled Distributed Systems</i>, OSDI 2006.',
    'etcd documentation: <a href="https://etcd.io/docs/" target="_blank" rel="noopener">leases and the concurrency API</a>',
    'Project documentation: <code>docs/PHASE1.md</code> (guarantees table, row "Liveness of locks").',
  ],
};
