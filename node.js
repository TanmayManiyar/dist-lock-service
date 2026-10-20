// One replica of the lock service: Raft consensus + a lock state machine with fencing tokens.
// Usage: node node.js <id> <clusterSize> <dataDir>
const http = require('http');
const fs = require('fs');
const path = require('path');

const ID = +process.argv[2];
const N = +process.argv[3];
const DATA = process.argv[4];
const BASE_PORT = +process.env.BASE_PORT || 7000;
// NODE_ADDRS="1=10.0.1.11:7001,2=10.0.1.12:7001,..." for real multi-host deployments; default is localhost:700<id>
const ADDRS = {};
for (const kv of (process.env.NODE_ADDRS || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); ADDRS[+k] = v; }
const addrOf = id => ADDRS[id] || `127.0.0.1:${BASE_PORT + id}`;
const PORT = +addrOf(ID).split(':')[1];
const HOST = process.env.NODE_HOST || '127.0.0.1';
const peers = [...Array(N).keys()].map(i => i + 1).filter(i => i !== ID);
const MAJORITY = Math.floor(N / 2) + 1;

const HEARTBEAT_MS = 120;
let ELECTION_MIN = 600, ELECTION_MAX = 1100;
const QUORUM_LOSS_MS = 1500;
const cfg = { prevote: true, checkQuorum: true }; // protocol toggles used by the virtual lab

// ---------- persistent state (term, vote, log) ----------
// meta file = {term, votedFor} (tiny, atomic rename); log file = append-only JSON lines, entry 0 is implicit.
const META = path.join(DATA, `node${ID}.json`);
const WAL = path.join(DATA, `node${ID}.wal`);
const DURABLE = process.env.DURABLE === '1';   // fsync every write (production setting; slower)
let st = { term: 0, votedFor: null, log: [{ term: 0 }] };
let walFd = null, walLen = 1, metaWritten = '';
function fsyncIf(fd) { if (DURABLE) fs.fsyncSync(fd); }
function loadDisk() {
  st = { term: 0, votedFor: null, log: [{ term: 0 }] };
  try { const m = JSON.parse(fs.readFileSync(META, 'utf8')); st.term = m.term; st.votedFor = m.votedFor; } catch {}
  try {
    for (const line of fs.readFileSync(WAL, 'utf8').split('\n')) {
      if (!line) continue;
      try { st.log.push(JSON.parse(line)); } catch { break; } // torn last line after a crash: stop here
    }
  } catch {}
  metaWritten = JSON.stringify({ term: st.term, votedFor: st.votedFor });
  walLen = st.log.length;
  if (walFd !== null) { try { fs.closeSync(walFd); } catch {} }
  walFd = fs.openSync(WAL, 'a');
}
function persist(rewriteLog = false) {
  const meta = JSON.stringify({ term: st.term, votedFor: st.votedFor });
  if (meta !== metaWritten) {
    fs.writeFileSync(META + '.tmp', meta);
    if (DURABLE) { const fd = fs.openSync(META + '.tmp', 'r+'); fs.fsyncSync(fd); fs.closeSync(fd); }
    fs.renameSync(META + '.tmp', META);
    metaWritten = meta;
  }
  if (rewriteLog) {
    fs.closeSync(walFd);
    fs.writeFileSync(WAL + '.tmp', st.log.slice(1).map(e => JSON.stringify(e) + '\n').join(''));
    fs.renameSync(WAL + '.tmp', WAL);
    walFd = fs.openSync(WAL, 'a');
    walLen = st.log.length;
  } else if (st.log.length > walLen) {
    fs.writeSync(walFd, st.log.slice(walLen).map(e => JSON.stringify(e) + '\n').join(''));
    fsyncIf(walFd);
    walLen = st.log.length;
  }
}
loadDisk();

// ---------- volatile state ----------
let role = 'follower', leaderId = null;
let commitIndex = 0, lastApplied = 0;
let nextIndex = {}, matchIndex = {}, lastAck = {}, inflight = {};
let lastLeaderContact = 0;
let electionDeadline = 0;
let crashed = false;             // simulated process crash (used when replicas run on remote hosts)
const blocked = new Set();       // simulated network partition (peer ids we cannot talk to)
const pending = new Map();       // log index -> {term, res}
const events = [];
let startedAt = Date.now();

function ev(msg) {
  events.push({ ts: Date.now(), node: ID, msg });
  if (events.length > 60) events.shift();
}
function resetElectionTimer() {
  electionDeadline = Date.now() + ELECTION_MIN + Math.random() * (ELECTION_MAX - ELECTION_MIN);
}
const lastIndex = () => st.log.length - 1;
const lastTerm = () => st.log[lastIndex()].term;

// ---------- lock state machine (deterministic: time comes from the command) ----------
let sm = { locks: {}, fence: 0 };
function applyCmd(cmd) {
  switch (cmd.type) {
    case 'noop': return { ok: true };
    case 'acquire': {
      const l = sm.locks[cmd.key];
      if (l && l.expiresAt > cmd.now) {
        if (l.owner === cmd.owner) return { ok: true, token: l.token, expiresAt: l.expiresAt, reentrant: true };
        return { ok: false, error: 'held', holder: l.owner, token: l.token, expiresAt: l.expiresAt };
      }
      const token = ++sm.fence;
      sm.locks[cmd.key] = { owner: cmd.owner, token, acquiredAt: cmd.now, expiresAt: cmd.now + cmd.ttlMs };
      return { ok: true, token, expiresAt: cmd.now + cmd.ttlMs };
    }
    case 'renew': {
      const l = sm.locks[cmd.key];
      if (!l || l.owner !== cmd.owner || l.token !== cmd.token || l.expiresAt <= cmd.now)
        return { ok: false, error: 'not-holder' };
      l.expiresAt = cmd.now + cmd.ttlMs;
      return { ok: true, token: l.token, expiresAt: l.expiresAt };
    }
    case 'release': {
      const l = sm.locks[cmd.key];
      if (!l || l.owner !== cmd.owner || l.token !== cmd.token) return { ok: false, error: 'not-holder' };
      delete sm.locks[cmd.key];
      return { ok: true };
    }
    case 'sweep': {
      let n = 0;
      for (const k of Object.keys(sm.locks)) if (sm.locks[k].expiresAt <= cmd.now) { delete sm.locks[k]; n++; }
      return { ok: true, expired: n };
    }
  }
  return { ok: false, error: 'bad-command' };
}

function applyCommitted() {
  while (lastApplied < commitIndex) {
    lastApplied++;
    const entry = st.log[lastApplied];
    const result = applyCmd(entry.cmd || { type: 'noop' });
    const p = pending.get(lastApplied);
    if (p) {
      pending.delete(lastApplied);
      p.res(p.term === entry.term ? result : { ok: false, error: 'leadership-lost' });
    }
  }
}

// ---------- role transitions ----------
function stepDown(term, why) {
  const wasLeader = role === 'leader';
  if (term > st.term) { st.term = term; st.votedFor = null; persist(); }
  if (role !== 'follower') ev(`stepped down to follower (term ${st.term})${why ? ' - ' + why : ''}`);
  role = 'follower';
  if (wasLeader) {
    for (const [, p] of pending) p.res({ ok: false, error: 'leadership-lost' });
    pending.clear();
  }
  resetElectionTimer();
}

function becomeLeader() {
  role = 'leader'; leaderId = ID;
  nextIndex = {}; matchIndex = {}; lastAck = {};
  for (const p of peers) { nextIndex[p] = lastIndex() + 1; matchIndex[p] = 0; lastAck[p] = Date.now(); }
  st.log.push({ term: st.term, cmd: { type: 'noop' } }); // commit prior-term entries
  persist();
  ev(`became LEADER for term ${st.term}`);
  broadcast();
}

// ---------- RPC ----------
async function rpc(to, route, body) {
  if (blocked.has(to) || crashed) return null;
  try {
    const r = await fetch(`http://${addrOf(to)}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, from: ID }), signal: AbortSignal.timeout(300),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const upToDate = (llIdx, llTerm) => llTerm > lastTerm() || (llTerm === lastTerm() && llIdx >= lastIndex());

const raftHandlers = {
  '/raft/prevote': b => {
    // Pre-vote: would I vote for you? Does not change any state, so partitioned nodes can't inflate terms.
    const recentLeader = Date.now() - lastLeaderContact < ELECTION_MIN;
    const grant = role !== 'leader' && !recentLeader && b.term > st.term && upToDate(b.lastLogIndex, b.lastLogTerm);
    return { term: st.term, granted: grant };
  },
  '/raft/vote': b => {
    if (b.term > st.term) stepDown(b.term);
    let grant = false;
    if (b.term === st.term && (st.votedFor === null || st.votedFor === b.from) && upToDate(b.lastLogIndex, b.lastLogTerm)) {
      st.votedFor = b.from; persist(); grant = true; resetElectionTimer();
    }
    return { term: st.term, granted: grant };
  },
  '/raft/append': b => {
    if (b.term < st.term) return { term: st.term, success: false };
    if (b.term > st.term || role !== 'follower') stepDown(b.term);
    leaderId = b.from; lastLeaderContact = Date.now(); resetElectionTimer();
    if (b.prevLogIndex > lastIndex() || st.log[b.prevLogIndex].term !== b.prevLogTerm)
      return { term: st.term, success: false, hint: Math.min(b.prevLogIndex, st.log.length) };
    let changed = false, truncated = false;
    b.entries.forEach((e, i) => {
      const idx = b.prevLogIndex + 1 + i;
      if (idx <= lastIndex() && st.log[idx].term !== e.term) { st.log.length = idx; changed = true; truncated = true; }
      if (idx > lastIndex()) { st.log.push(e); changed = true; }
    });
    if (changed) persist(truncated);
    const match = b.prevLogIndex + b.entries.length;
    if (b.leaderCommit > commitIndex) { commitIndex = Math.min(b.leaderCommit, match); applyCommitted(); }
    return { term: st.term, success: true, match };
  },
};

// ---------- election ----------
let electing = false;
async function tryElection() {
  if (electing) return;
  electing = true;
  resetElectionTimer();
  try {
    const probe = { term: st.term + 1, lastLogIndex: lastIndex(), lastLogTerm: lastTerm() };
    if (cfg.prevote) {
      const pre = await Promise.all(peers.map(p => rpc(p, '/raft/prevote', probe)));
      if (role === 'leader') return;
      if (1 + pre.filter(r => r && r.granted).length < MAJORITY) return;
    }
    st.term++; st.votedFor = ID; role = 'candidate'; leaderId = null; persist();
    const term = st.term;
    ev(`election started for term ${term}`);
    const req = { term, lastLogIndex: lastIndex(), lastLogTerm: lastTerm() };
    const res = await Promise.all(peers.map(p => rpc(p, '/raft/vote', req)));
    if (role !== 'candidate' || st.term !== term) return;
    const hi = Math.max(0, ...res.filter(Boolean).map(r => r.term));
    if (hi > term) return stepDown(hi);
    if (1 + res.filter(r => r && r.granted).length >= MAJORITY) becomeLeader();
  } finally { electing = false; }
}

// ---------- replication ----------
function advanceCommit() {
  for (let n = lastIndex(); n > commitIndex; n--) {
    if (st.log[n].term !== st.term) break;
    const count = 1 + peers.filter(p => matchIndex[p] >= n).length;
    if (count >= MAJORITY) { commitIndex = n; applyCommitted(); break; }
  }
}
async function replicate(p) {
  if (inflight[p] || role !== 'leader') return;
  inflight[p] = true;
  let again = false;
  try {
    const term = st.term, ni = nextIndex[p], prev = ni - 1;
    const entries = st.log.slice(ni, ni + 64);
    const r = await rpc(p, '/raft/append', {
      term, prevLogIndex: prev, prevLogTerm: st.log[prev].term, entries, leaderCommit: commitIndex,
    });
    if (!r || role !== 'leader' || st.term !== term) return;
    if (r.term > st.term) return stepDown(r.term);
    lastAck[p] = Date.now();
    if (r.success) { matchIndex[p] = Math.max(matchIndex[p], r.match); nextIndex[p] = matchIndex[p] + 1; advanceCommit(); again = nextIndex[p] <= lastIndex(); }
    else { nextIndex[p] = Math.max(1, Math.min(r.hint ?? ni - 1, ni - 1)); again = true; }
  } finally {
    inflight[p] = false;
    if (again && role === 'leader') setImmediate(() => replicate(p)); // pipeline: entries arrived while the RPC was in flight
  }
}
function broadcast() { for (const p of peers) replicate(p); advanceCommit(); }
const hasQuorumLease = () =>
  role === 'leader' && 1 + peers.filter(p => Date.now() - lastAck[p] < QUORUM_LOSS_MS).length >= MAJORITY;

function propose(cmd) {
  return new Promise(res => {
    if (role !== 'leader') return res({ ok: false, error: 'not-leader', leader: leaderId });
    st.log.push({ term: st.term, cmd });
    persist();
    const idx = lastIndex();
    pending.set(idx, { term: st.term, res });
    setTimeout(() => { if (pending.get(idx)) { pending.delete(idx); res({ ok: false, error: 'timeout' }); } }, 3000);
    broadcast();
  });
}

// ---------- timers ----------
setInterval(() => {
  if (crashed) return;
  if (role === 'leader') {
    broadcast();
    if (cfg.checkQuorum && !hasQuorumLease()) stepDown(st.term, 'lost contact with majority (check-quorum)');
  } else if (Date.now() > electionDeadline) tryElection();
}, HEARTBEAT_MS);

setInterval(() => { // leader-driven lease expiry, replicated like any other command
  if (crashed || role !== 'leader') return;
  const now = Date.now();
  if (Object.values(sm.locks).some(l => l.expiresAt <= now)) propose({ type: 'sweep', now });
}, 300);

// ---------- HTTP ----------
function readBody(req) {
  return new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
}
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const body = req.method === 'POST' ? await readBody(req) : {};
  const url = req.url.split('?')[0];
  if (crashed && !['/admin/start', '/admin/wipe'].includes(url)) return req.socket.destroy();
  if (url === '/admin/crash') { crash(); return send(res, 200, { ok: true }); }
  if (url === '/admin/start') { if (crashed) boot('restarted'); return send(res, 200, { ok: true }); }
  if (url === '/admin/wipe') {
    crash();
    for (const f of [META, WAL]) { try { fs.rmSync(f, { force: true }); } catch {} }
    boot('restarted with a wiped disk');
    return send(res, 200, { ok: true });
  }

  if (url.startsWith('/raft/')) {
    if (blocked.has(body.from)) return req.socket.destroy(); // partitioned: drop silently
    return send(res, 200, raftHandlers[url](body));
  }
  if (url === '/status') {
    return send(res, 200, {
      id: ID, role, term: st.term, leaderId, commitIndex, lastApplied, logLength: lastIndex(),
      votedFor: st.votedFor, blocked: [...blocked], events, uptimeMs: Date.now() - startedAt,
      config: { ...cfg, electionMin: ELECTION_MIN, electionMax: ELECTION_MAX },
      lockCount: Object.keys(sm.locks).length, fence: sm.fence,
    });
  }
  if (url === '/admin/config') {
    if (typeof body.prevote === 'boolean') cfg.prevote = body.prevote;
    if (typeof body.checkQuorum === 'boolean') cfg.checkQuorum = body.checkQuorum;
    if (body.electionMin >= 50 && body.electionMax > body.electionMin) { ELECTION_MIN = body.electionMin; ELECTION_MAX = body.electionMax; resetElectionTimer(); }
    ev(`config: prevote=${cfg.prevote} checkQuorum=${cfg.checkQuorum} election=${ELECTION_MIN}-${ELECTION_MAX}ms`);
    return send(res, 200, { ok: true, ...cfg, electionMin: ELECTION_MIN, electionMax: ELECTION_MAX });
  }
  if (url === '/admin/block') {
    blocked.clear(); (body.ids || []).forEach(i => blocked.add(i));
    ev(blocked.size ? `network: cut off from nodes [${[...blocked]}]` : 'network: healed');
    return send(res, 200, { ok: true });
  }
  if (url === '/client/locks') {
    if (!hasQuorumLease()) return send(res, 200, { ok: false, error: 'not-leader', leader: leaderId });
    return send(res, 200, { ok: true, locks: sm.locks, fence: sm.fence, now: Date.now() });
  }
  if (url.startsWith('/client/')) {
    const op = url.slice(8);
    const ttlMs = Math.min(120000, Math.max(500, +body.ttlMs || 10000));
    const cmd = { type: op, key: String(body.key || ''), owner: String(body.owner || ''), token: body.token, ttlMs, now: Date.now() };
    if (!['acquire', 'renew', 'release'].includes(op) || !cmd.key || !cmd.owner)
      return send(res, 400, { ok: false, error: 'bad-request' });
    const r = await propose(cmd);
    if (op !== 'release' && r.ok) ev(`${op} "${cmd.key}" by ${cmd.owner} -> token ${r.token}`);
    else if (op === 'release' && r.ok) ev(`release "${cmd.key}" by ${cmd.owner}`);
    return send(res, 200, r);
  }
  send(res, 404, { error: 'not-found' });
}).listen(PORT, HOST, () => { resetElectionTimer(); ev(`started on :${PORT} (term ${st.term}, log ${lastIndex()})`); });

// Simulated process crash / restart. A real crash loses all memory; boot() rebuilds from disk only.
function crash() {
  if (crashed) return;
  crashed = true; role = 'follower'; leaderId = null;
  for (const [, p] of pending) p.res({ ok: false, error: 'leadership-lost' });
  pending.clear();
}
function boot(why) {
  loadDisk();
  role = 'follower'; leaderId = null; commitIndex = 0; lastApplied = 0;
  nextIndex = {}; matchIndex = {}; lastAck = {}; inflight = {};
  lastLeaderContact = 0; sm = { locks: {}, fence: 0 };
  blocked.clear(); startedAt = Date.now(); crashed = false;
  resetElectionTimer();
  ev(`${why} (term ${st.term}, log ${lastIndex()})`);
}
