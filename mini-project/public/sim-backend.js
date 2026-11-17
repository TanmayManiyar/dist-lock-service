// Simulated backend for the dashboard.
// The dashboard (app.js) talks to the gateway through fetch('/api/...'). This file wraps fetch:
//   * if the real gateway answers, nothing changes and the dashboard shows the real cluster;
//   * if it does not answer (e.g. the AWS instance is stopped), the same /api/* calls are answered by a
//     small Raft + lock-service simulator that runs in this browser tab, so every button still works and
//     everything you see is simulated. The simulator follows the same rules as replica.js: terms,
//     pre-vote, randomised election timeouts, check-quorum, majority commit, no-op on election,
//     leases and fencing tokens.
(function () {
  'use strict';
  const realFetch = window.fetch.bind(window);
  const N = 5, MAJ = 3, HB = 120, CQ = 1500;
  const DEFAULT_CONFIG = { prevote: true, checkQuorum: true, electionMin: 600, electionMax: 1100, fencing: true, trace: false };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();

  // ------------------------------------------------------------------ state
  let cfg, nodes, events, term, termSeq, actionLog, partition, resource, timer = null;

  function tlog(node, src, lvl, msg) {
    term.push({ seq: ++termSeq, ts: now(), node, src, lvl, msg });
    if (term.length > 2500) term.splice(0, term.length - 2500);
  }
  const nlog = (n, src, lvl, msg) => tlog('N' + n.id, src, lvl, msg);
  function nev(n, msg) { events.push({ ts: now(), node: n.id, msg }); if (events.length > 200) events.shift(); nlog(n, 'raft', 'INFO', msg); }
  function logAction(msg) { actionLog.push({ ts: now(), node: 'client', msg }); if (actionLog.length > 60) actionLog.shift(); }

  function mk(id) {
    return { id, up: true, role: 'follower', term: 0, votedFor: null, leaderId: null, log: [], commitIndex: 0, lastApplied: 0,
      blocked: [], startedAt: now(), deadline: 0, lastLeaderContact: 0, nextHb: 0, leaderSince: 0, lastAck: {}, sm: { locks: {}, fence: 0 }, pending: {} };
  }
  function init() {
    cfg = { ...DEFAULT_CONFIG }; term = []; termSeq = 0; events = []; actionLog = []; partition = null; resource = {};
    nodes = [...Array(N).keys()].map(i => mk(i + 1));
    tlog('GW', 'boot', 'INFO', `gateway starting on :8080, cluster of ${N} replicas (SIMULATED in this browser, no real servers)`);
    for (const n of nodes) {
      resetDeadline(n);
      tlog('GW', 'proc', 'INFO', `spawned replica N${n.id}: simulated process (port ${7000 + n.id})`);
      events.push({ ts: now(), node: n.id, msg: `started on :${7000 + n.id} (term 0, log 0)` });
      nlog(n, 'boot', 'INFO', `started on :${7000 + n.id} (term 0, log 0)`);
    }
    if (!timer) timer = setInterval(tick, 40);
  }

  const reach = (a, b) => a.up && b.up && !a.blocked.includes(b.id) && !b.blocked.includes(a.id);
  const resetDeadline = n => { n.deadline = now() + rnd(cfg.electionMin, cfg.electionMax); };
  const lastTerm = n => (n.log.length ? n.log[n.log.length - 1].term : 0);
  const upToDate = (c, p) => lastTerm(c) > lastTerm(p) || (lastTerm(c) === lastTerm(p) && c.log.length >= p.log.length);
  const findLeader = () => nodes.filter(n => n.up && n.role === 'leader').sort((a, b) => b.term - a.term)[0] || null;
  const describe = e => (e.type === 'noop' ? 'no-op (new leader)' : `${e.op} "${e.key}" by ${e.owner}`);

  // ------------------------------------------------------------------ raft
  function stepDown(n, t, why) {
    const was = n.role;
    if (t > n.term) { n.term = t; n.votedFor = null; }
    n.role = 'follower'; n.leaderId = null; resetDeadline(n);
    Object.keys(n.pending).forEach(i => { n.pending[i]({ ok: false, error: 'leadership-lost' }); delete n.pending[i]; });
    if (was === 'leader' || was === 'candidate') nev(n, `stepped down to follower (term ${n.term})${why ? ' - ' + why : ''}`);
  }

  function syncLog(L, p) {
    const same = p.log.length === L.log.length && p.log[p.log.length - 1] === L.log[L.log.length - 1];
    if (!same) {
      let i = 0; while (i < p.log.length && i < L.log.length && p.log[i] === L.log[i]) i++;
      if (i < p.log.length) nlog(p, 'wal', 'WARN', `conflict at index ${i + 1}: discarding ${p.log.length - i} uncommitted entr${p.log.length - i === 1 ? 'y' : 'ies'} from an old term`);
      for (let k = i; k < L.log.length; k++) nlog(p, 'wal', 'DEBUG', `append idx=${k + 1} term=${L.log[k].term} ${describe(L.log[k])} (fsync ok)`);
      p.log = L.log.slice();
    }
    p.commitIndex = Math.max(p.commitIndex, Math.min(L.commitIndex, p.log.length));
    applyNode(p);
  }

  function advanceCommit(L) {
    let have = 1;
    for (const p of nodes) if (p !== L && reach(L, p) && p.log.length === L.log.length) have++;
    if (have >= MAJ && L.log.length > L.commitIndex && L.log[L.log.length - 1].term === L.term) {
      L.commitIndex = L.log.length;
      nlog(L, 'raft', 'INFO', `COMMIT index ${L.commitIndex} (stored on ${have} of ${N} replicas, a majority)`);
      applyNode(L);
      for (const p of nodes) if (p !== L && reach(L, p)) { p.commitIndex = Math.max(p.commitIndex, Math.min(L.commitIndex, p.log.length)); applyNode(p); }
    }
  }

  function heartbeat(L) {
    if (!L.up || L.role !== 'leader') return;
    let higher = null;
    for (const p of nodes) {
      if (p === L || !reach(L, p)) continue;
      if (p.term > L.term) { higher = p; break; }
      if (p.term < L.term) { if (p.role === 'leader') stepDown(p, L.term, 'saw a higher term'); p.term = L.term; p.votedFor = null; }
      p.role = 'follower'; p.leaderId = L.id; p.lastLeaderContact = now(); resetDeadline(p);
      syncLog(L, p); L.lastAck[p.id] = now();
      if (cfg.trace) nlog(L, 'raft', 'DEBUG', `heartbeat -> N${p.id} term ${L.term} ok`);
    }
    if (higher) { stepDown(L, higher.term, 'saw a higher term'); return; }
    advanceCommit(L);
  }

  function becomeLeader(n) {
    n.role = 'leader'; n.leaderId = n.id; n.leaderSince = now(); n.lastAck = {};
    for (const p of nodes) n.lastAck[p.id] = now();
    nev(n, `became LEADER for term ${n.term}`);
    n.log.push({ term: n.term, type: 'noop' });
    nlog(n, 'wal', 'DEBUG', `append idx=${n.log.length} term=${n.term} no-op (new leader) (fsync ok)`);
    n.nextHb = now(); heartbeat(n);
  }

  function startElection(n) {
    resetDeadline(n);
    const t = now();
    if (cfg.prevote) {
      let yes = 1;
      for (const p of nodes) {
        if (p === n || !reach(n, p)) continue;
        if (p.term > n.term) { stepDown(n, p.term); return; }
        const quiet = p.role !== 'leader' && t - p.lastLeaderContact >= cfg.electionMin - 50;
        if (quiet && upToDate(n, p)) yes++;
      }
      if (yes < MAJ) { nlog(n, 'raft', 'INFO', `pre-vote failed: only ${yes} of ${N} replicas would vote for me, so no election is started (term stays ${n.term})`); return; }
    }
    n.term++; n.role = 'candidate'; n.votedFor = n.id; n.leaderId = null;
    const T = n.term;
    nev(n, `election started for term ${T}`);
    setTimeout(() => finishElection(n, T), 70 + Math.random() * 60);
  }

  function finishElection(n, T) {
    if (!n.up || n.role !== 'candidate' || n.term !== T) return;
    let votes = 1;
    for (const p of nodes) {
      if (p === n || !reach(n, p)) continue;
      if (p.term > T) { stepDown(n, p.term); return; }
      if (p.term < T) { if (p.role === 'leader') stepDown(p, T, 'saw a higher term'); p.role = 'follower'; p.term = T; p.votedFor = null; p.leaderId = null; }
      if (p.votedFor === null || p.votedFor === n.id) {
        if (upToDate(n, p)) { p.votedFor = n.id; resetDeadline(p); votes++; nlog(p, 'raft', 'INFO', `VOTE GRANTED to N${n.id} for term ${T}`); }
        else nlog(p, 'raft', 'INFO', `vote refused to N${n.id}: its log is behind mine`);
      } else nlog(p, 'raft', 'DEBUG', `vote refused to N${n.id}: already voted for N${p.votedFor} in term ${T}`);
    }
    if (votes >= MAJ) becomeLeader(n);
    else nlog(n, 'raft', 'INFO', `election for term ${T} failed: ${votes} of ${N} votes, ${MAJ} needed`);
  }

  function tick() {
    const t = now();
    for (const n of nodes) {
      if (!n.up) continue;
      if (n.role === 'leader') {
        if (t >= n.nextHb) { n.nextHb = t + HB; heartbeat(n); }
        if (n.role === 'leader' && cfg.checkQuorum && t - n.leaderSince > CQ) {
          let c = 1; for (const p of nodes) if (p !== n && t - (n.lastAck[p.id] || 0) < CQ) c++;
          if (c < MAJ) stepDown(n, n.term, 'lost contact with majority (check-quorum)');
        }
      } else if (t >= n.deadline) startElection(n);
    }
  }

  // ------------------------------------------------------------------ lock state machine (replicated)
  function applyNode(n) {
    while (n.lastApplied < n.commitIndex) {
      const idx = n.lastApplied + 1, e = n.log[idx - 1], res = applyEntry(n, idx, e);
      n.lastApplied = idx;
      if (n.pending[idx]) { n.pending[idx](res); delete n.pending[idx]; }
    }
  }
  function applyEntry(n, idx, e) {
    if (e.type === 'noop') return { ok: true };
    const sm = n.sm, cur = sm.locks[e.key], live = cur && cur.expiresAt > e.at;
    let res;
    if (e.op === 'acquire') {
      if (live && cur.owner !== e.owner) { res = { ok: false, error: 'held', holder: cur.owner, token: cur.token }; nlog(n, 'lock', 'INFO', `APPLY idx=${idx} acquire key=${e.key} owner=${e.owner} -> REFUSED, held by ${cur.owner} (token=${cur.token})`); }
      else if (live) { cur.expiresAt = e.at + e.ttlMs; res = { ok: true, token: cur.token, reentrant: true, expiresAt: cur.expiresAt }; nlog(n, 'lock', 'INFO', `APPLY idx=${idx} acquire key=${e.key} owner=${e.owner} -> GRANTED again (re-entrant), token=${cur.token}`); }
      else { const token = ++sm.fence; sm.locks[e.key] = { owner: e.owner, token, acquiredAt: e.at, expiresAt: e.at + e.ttlMs }; res = { ok: true, token, expiresAt: e.at + e.ttlMs }; nlog(n, 'lock', 'INFO', `APPLY idx=${idx} acquire key=${e.key} owner=${e.owner} -> GRANTED fencing token=${token}, lease ${e.ttlMs}ms`); }
    } else if (e.op === 'renew') {
      if (live && cur.owner === e.owner && (!e.token || e.token === cur.token)) { cur.expiresAt = e.at + e.ttlMs; res = { ok: true, token: cur.token, expiresAt: cur.expiresAt }; nlog(n, 'lock', 'INFO', `APPLY idx=${idx} renew key=${e.key} owner=${e.owner} -> RENEWED token=${cur.token}`); }
      else { res = { ok: false, error: 'not-holder' }; nlog(n, 'lock', 'INFO', `APPLY idx=${idx} renew key=${e.key} owner=${e.owner} -> REFUSED, not the holder`); }
    } else {
      if (live && cur.owner === e.owner && (!e.token || e.token === cur.token)) { delete sm.locks[e.key]; res = { ok: true }; nlog(n, 'lock', 'INFO', `APPLY idx=${idx} release key=${e.key} owner=${e.owner} -> RELEASED`); }
      else { res = { ok: false, error: 'not-holder' }; nlog(n, 'lock', 'INFO', `APPLY idx=${idx} release key=${e.key} owner=${e.owner} -> REFUSED, not the holder`); }
    }
    return res;
  }

  async function leaderOp(L, op, body) {
    const e = { term: L.term, op, key: body.key, owner: body.owner, ttlMs: body.ttlMs || 8000, token: body.token, at: now() };
    L.log.push(e); const idx = L.log.length;
    nlog(L, 'wal', 'DEBUG', `append idx=${idx} term=${L.term} ${describe(e)} (fsync ok)`);
    const done = new Promise(res => { L.pending[idx] = res; });
    await sleep(15 + Math.random() * 25);
    if (!L.up || L.role !== 'leader') return { ok: false, error: 'leadership-lost' };
    heartbeat(L);
    const r = await Promise.race([done, sleep(700).then(() => null)]);
    if (r) return r;
    delete L.pending[idx];
    nlog(L, 'raft', 'WARN', `entry ${idx} could not reach a majority; leadership may be lost`);
    return { ok: false, error: 'leadership-lost' };
  }

  async function viaLeader(op, body, retry) {
    let lost = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const L = findLeader();
      if (!L) { tlog('GW', 'route', 'WARN', 'no leader known yet; waiting 250ms and probing every replica again'); await sleep(250); continue; }
      tlog('GW', 'route', 'DEBUG', `forward /client/${op} -> N${L.id}${attempt ? ' (retry ' + attempt + ')' : ''}`);
      const r = await leaderOp(L, op, body);
      if (r.error === 'leadership-lost' && retry && ++lost < 2) continue;
      return { ...r, servedBy: L.id };
    }
    tlog('GW', 'route', 'WARN', `/client/${op}: no leader found after 5 attempts`);
    return { ok: false, error: 'no-leader' };
  }

  // ------------------------------------------------------------------ faults
  function applyPartition(groups) {
    partition = groups;
    for (const n of nodes) {
      const mine = groups ? (groups.find(g => g.includes(n.id)) || [n.id]) : [];
      n.blocked = groups ? nodes.map(x => x.id).filter(x => !mine.includes(x)) : [];
      if (n.up) nev(n, n.blocked.length ? `network: cut off from nodes [${n.blocked.join(',')}]` : 'network: healed');
    }
  }
  function kill(id) {
    const n = nodes[id - 1]; if (!n) return;
    tlog('GW', 'fault', 'WARN', `FAULT: killing replica N${id} (simulated SIGTERM)`);
    if (n.up) { n.up = false; stepDown(n, n.term); n.role = 'follower'; tlog('GW', 'proc', 'WARN', `replica N${id} process stopped by the gateway (killed by signal)`); }
    logAction(`FAULT: killed node ${id}`);
  }
  function start(id, wiped) {
    const n = nodes[id - 1]; if (!n || n.up) return;
    n.up = true; n.role = 'follower'; n.startedAt = now(); n.lastLeaderContact = 0; resetDeadline(n);
    if (partition) { const mine = partition.find(g => g.includes(id)) || [id]; n.blocked = nodes.map(x => x.id).filter(x => !mine.includes(x)); }
    tlog('GW', 'proc', 'INFO', `spawned replica N${id}: simulated process (port ${7000 + id})`);
    nev(n, wiped ? 'restarted with a wiped disk (term 0, log 0)' : `restarted (term ${n.term}, log ${n.log.length})`);
  }

  // ------------------------------------------------------------------ the /api/* routes (same shapes as server.js)
  const statusOf = n => n.up
    ? { id: n.id, up: true, role: n.role, term: n.term, leaderId: n.leaderId, commitIndex: n.commitIndex, lastApplied: n.lastApplied,
        logLength: n.log.length, votedFor: n.votedFor, blocked: n.blocked.slice(), uptimeMs: now() - n.startedAt }
    : { id: n.id, up: false };

  async function route(url, method, body) {
    const path = url.split('?')[0];
    if (path === '/api/cluster') {
      const ev = [...actionLog, ...events].sort((a, b) => a.ts - b.ts).slice(-80), L = findLeader();
      return { nodes: nodes.map(statusOf), leader: L ? L.id : null, partition, events: ev, clientEvents: actionLog, n: N };
    }
    if (path === '/api/term') {
      const since = +new URLSearchParams(url.split('?')[1] || '').get('since') || 0;
      const lines = since ? term.filter(l => l.seq > since) : term.slice(-300);
      return { ok: true, seq: termSeq, lines: lines.slice(-600) };
    }
    if (path === '/api/locks') { const L = findLeader(); return L ? { ok: true, locks: L.sm.locks, now: now(), servedBy: L.id } : { ok: false, error: 'no-leader' }; }
    if (['/api/acquire', '/api/renew', '/api/release'].includes(path)) {
      const op = path.slice(5), t0 = now();
      tlog('GW', 'http', 'INFO', `POST ${path} key=${body.key} owner=${body.owner}${body.ttlMs ? ' ttl=' + body.ttlMs + 'ms' : ''}${body.token ? ' token=' + body.token : ''}`);
      const r = await viaLeader(op, body, op !== 'release');
      tlog('GW', 'http', r.ok ? 'INFO' : (r.error === 'held' || r.error === 'not-holder' ? 'INFO' : 'WARN'),
        `-> ${r.ok ? '200 OK' + (r.token ? ' token=' + r.token : '') : 'FAILED ' + r.error + (r.holder ? ' (held by ' + r.holder + ')' : '')} served by ${r.servedBy ? 'N' + r.servedBy : 'nobody'} in ${now() - t0}ms`);
      logAction(`${body.owner} ${op} "${body.key}" -> ${r.ok ? 'OK' + (r.token ? ' token ' + r.token : '') : r.error + (r.holder ? ' (held by ' + r.holder + ')' : '')}`);
      return r;
    }
    if (path === '/api/resource/write') {
      const { key, token, owner, value } = body, cur = resource[key] || { maxToken: 0 };
      if (cfg.fencing && token < cur.maxToken) {
        logAction(`RESOURCE rejected stale write to "${key}" from ${owner} (token ${token} < ${cur.maxToken})`);
        tlog('GW', 'fence', 'WARN', `RESOURCE write key=${key} owner=${owner} token=${token} -> REJECTED: stale token (resource has already seen token ${cur.maxToken})`);
        return { ok: false, error: 'stale-token', maxToken: cur.maxToken };
      }
      resource[key] = { maxToken: Math.max(cur.maxToken, token), lastToken: token, value, writer: owner };
      logAction(`RESOURCE accepted write to "${key}" from ${owner} (token ${token})${cfg.fencing ? '' : ' [fencing OFF]'}`);
      tlog('GW', 'fence', 'INFO', `RESOURCE write key=${key} owner=${owner} token=${token} value=${JSON.stringify(value)} -> ACCEPTED${cfg.fencing ? '' : ' (fencing check is OFF)'}; highest token seen is now ${Math.max(cur.maxToken, token)}`);
      return { ok: true };
    }
    if (path === '/api/resource') return resource;
    if (path === '/api/config') {
      if (method === 'POST') {
        cfg = { ...cfg, ...body };
        tlog('GW', 'fault', 'INFO', `config changed: ${JSON.stringify(body)} (applied to all simulated replicas)`);
        logAction(`CONFIG: prevote=${cfg.prevote} checkQuorum=${cfg.checkQuorum} election=${cfg.electionMin}-${cfg.electionMax}ms`);
      }
      return cfg;
    }
    if (path === '/api/reset') { init(); logAction('RESET: cluster reset to a clean state'); tlog('GW', 'fault', 'WARN', 'RESET: all simulated replicas wiped, fresh cluster starting'); return { ok: true }; }
    if (path === '/api/fault/wipe') {
      const n = nodes[body.id - 1];
      if (n) { kill(body.id); n.log = []; n.term = 0; n.votedFor = null; n.commitIndex = 0; n.lastApplied = 0; n.sm = { locks: {}, fence: 0 }; start(body.id, true); }
      logAction(`FAULT: wiped disk of node ${body.id} and restarted it`);
      tlog('GW', 'fault', 'WARN', `FAULT: wiped the disk (WAL + term file) of N${body.id} and restarted it`);
      return { ok: true };
    }
    if (path === '/api/fault/kill') { kill(body.id); return { ok: true }; }
    if (path === '/api/fault/restart') { tlog('GW', 'fault', 'INFO', `FAULT: restarting replica N${body.id}`); start(body.id); logAction(`FAULT: restarted node ${body.id}`); return { ok: true }; }
    if (path === '/api/fault/partition') { tlog('GW', 'fault', 'WARN', `FAULT: network partition ${JSON.stringify(body.groups)}: replicas in different groups can no longer talk`); applyPartition(body.groups); logAction(`FAULT: partition ${JSON.stringify(body.groups)}`); return { ok: true }; }
    if (path === '/api/fault/heal') { tlog('GW', 'fault', 'INFO', 'FAULT: network healed, all replicas can talk again'); applyPartition(null); logAction('FAULT: network healed'); return { ok: true }; }
    return { ok: false, error: 'unknown-route' };
  }

  // ------------------------------------------------------------------ choose real vs simulated
  let mode = null, failures = 0;
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:99999;max-width:92vw;font:13px/1.35 system-ui,sans-serif;' +
    'background:#1b2538ee;color:#fff;padding:8px 14px;border-radius:12px;box-shadow:0 4px 18px #0005;text-align:center';
  const mount = () => { if (!banner.isConnected && document.body) document.body.appendChild(banner); };
  const setBanner = (html) => { banner.innerHTML = html; mount(); };
  document.addEventListener('DOMContentLoaded', mount);
  setBanner('Checking for the live cluster&hellip;');

  function enterSim() {
    mode = 'sim'; init();
    document.title = document.title.replace(/ \(simulated\)$/, '') + ' (simulated)';
    setBanner('<b>SIMULATED MODE</b>: the AWS cluster is offline, so everything on this page runs in a built-in simulation in your browser. ' +
      'Every button works, but nothing here is a real server. <button id="simRetry" style="margin-left:8px;padding:3px 10px;border-radius:8px;border:0;background:#9cf;color:#0b1b33;font-weight:600;cursor:pointer">Retry live cluster</button>');
    const b = document.getElementById('simRetry'); if (b) b.onclick = () => location.reload();
    setInterval(() => { const s = document.getElementById('termStat'); if (s) { s.textContent = '● simulated'; s.className = 'crumb tlive'; } }, 300);
  }

  const decide = (async () => {
    try {
      const r = await realFetch('/api/cluster', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      const j = r.ok ? await r.json() : null;
      if (j && Array.isArray(j.nodes)) { mode = 'live'; setBanner('&#9679; Live cluster connected (real Raft replicas)'); setTimeout(() => { banner.style.display = 'none'; }, 5000); return; }
    } catch (e) { /* fall through */ }
    enterSim();
  })();

  const respond = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

  window.fetch = async function (input, initOpts) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.startsWith('/api/')) return realFetch(input, initOpts);
    await decide;
    if (mode === 'live') {
      try {
        const r = await realFetch(input, initOpts);
        if (url.startsWith('/api/cluster')) {
          if (r.status >= 500) throw new Error('backend down'); failures = 0;
        }
        return r;
      } catch (e) {
        if (url.startsWith('/api/cluster') && ++failures >= 3) { enterSim(); return respond(await route(url, 'GET', {})); }
        throw e;
      }
    }
    const method = ((initOpts && initOpts.method) || 'GET').toUpperCase();
    let body = {}; try { body = initOpts && initOpts.body ? JSON.parse(initOpts.body) : {}; } catch (e) { /* ignore */ }
    return respond(await route(url, method, body));
  };
})();
