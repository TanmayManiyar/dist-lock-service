// Fault-injection + safety test (Phase 2). Starts its own 5-node cluster, runs concurrent lock clients
// while injecting random crashes, restarts, partitions and leader isolations, then checks:
//   1. mutual exclusion: no two grants on a key overlap in time (history checker)
//   2. fencing tokens are unique and each token belongs to one key
//   3. every acknowledged grant is durable (final counter >= highest token seen)
//   4. after healing: one leader, identical committed logs and counters on all nodes
//   5. liveness: a fresh lock can be acquired after the chaos
// Usage: node test-chaos.js [--quick] [--seconds=60] [--seed=1]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (n, d) => (process.argv.find(a => a.startsWith('--' + n + '=')) || '').split('=')[1] || d;
const QUICK = process.argv.includes('--quick');
const SECONDS = +arg('seconds', QUICK ? 20 : 60);
let seed = +arg('seed', Date.now() % 100000);
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const GW = 8091, BASE = 7200, N = 5, KEYS = ['k1', 'k2', 'k3'], CLIENTS = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (route, body) => fetch(`http://localhost:${GW}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

const grants = new Map();   // token -> {key, owner, tResp, expiresAt, relStart|null}
const stats = { acquireOk: 0, held: 0, errors: {}, renews: 0, releases: 0, chaos: [] };
const bump = e => { stats.errors[e] = (stats.errors[e] || 0) + 1; };

async function client(id, stopAt) {
  const owner = 'c' + id;
  while (Date.now() < stopAt) {
    const key = pick(KEYS);
    const ttlMs = 500 + Math.floor(rnd() * 1500);
    let r; const tStart = Date.now();
    try { r = await J('/api/acquire', { key, owner, ttlMs }); } catch { bump('fetch'); await sleep(100); continue; }
    const tResp = Date.now();
    if (!r.ok) { r.error === 'held' ? stats.held++ : bump(r.error); await sleep(20 + rnd() * 80); continue; }
    stats.acquireOk++;
    let g = grants.get(r.token);
    if (!g) { g = { key, owner, tStart, tResp, expiresAt: r.expiresAt, firstExpiry: r.expiresAt, relStart: null, renews: [], servedBy: r.servedBy, reentrant: !!r.reentrant }; grants.set(r.token, g); }
    else if (g.key !== key) { g.conflict = true; }
    await sleep(rnd() * 250);
    if (rnd() < 0.3) { // renew
      try { const n = await J('/api/renew', { key, owner, token: r.token, ttlMs }); if (n.ok) { stats.renews++; g.renews.push([Date.now(), n.expiresAt]); g.expiresAt = Math.max(g.expiresAt, n.expiresAt); } } catch {}
    }
    if (rnd() < 0.8) { // release (otherwise simulate a client that crashed while holding the lock)
      const t0 = Date.now(); g.relAttempt = t0; // even a failed release may have committed, so it bounds the earliest possible end
      try { const x = await J('/api/release', { key, owner, token: r.token }); if (x.ok) { g.relStart = t0; stats.releases++; } } catch {}
    }
  }
}

async function chaos(stopAt) {
  const down = new Set(); let partitioned = false;
  while (Date.now() < stopAt - 1500) {
    await sleep(900 + rnd() * 1800);
    const c = await J('/api/cluster').catch(() => null); if (!c) continue;
    const roll = rnd();
    let what;
    if (roll < 0.30 && down.size < 2) { const id = pick(c.nodes.filter(n => n.up).map(n => n.id)); await J('/api/fault/kill', { id }); down.add(id); what = `kill N${id}`; }
    else if (roll < 0.50 && c.leader && down.size < 2) { await J('/api/fault/kill', { id: c.leader }); down.add(c.leader); what = `kill leader N${c.leader}`; }
    else if (roll < 0.70 && down.size) { const id = pick([...down]); await J('/api/fault/restart', { id }); down.delete(id); what = `restart N${id}`; }
    else if (roll < 0.82 && !partitioned && c.leader) { await J('/api/fault/partition', { groups: [[c.leader], c.nodes.map(n => n.id).filter(i => i !== c.leader)] }); partitioned = true; what = `isolate leader N${c.leader}`; }
    else if (roll < 0.90 && !partitioned) { const ids = c.nodes.map(n => n.id).sort(() => rnd() - .5); await J('/api/fault/partition', { groups: [ids.slice(0, 3), ids.slice(3)] }); partitioned = true; what = 'split 3|2'; }
    else if (partitioned) { await J('/api/fault/heal'); partitioned = false; what = 'heal'; }
    else what = 'idle';
    stats.chaos.push(what); console.log('  chaos:', what);
  }
  await J('/api/fault/heal');
  for (const id of down) await J('/api/fault/restart', { id });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockchaos-'));
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, NODES: N, PORT: GW, BASE_PORT: BASE, DATA_DIR: dir }, stdio: 'ignore' });
  let failed = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!ok) failed++; };
  try {
    for (let i = 0; i < 60; i++) { try { const c = await J('/api/cluster'); if (c.leader && c.nodes.every(n => n.up)) break; } catch {} await sleep(250); }
    console.log(`Running ${CLIENTS} clients for ${SECONDS}s with random faults (seed ${arg('seed', 'time-based')})`);
    const stopAt = Date.now() + SECONDS * 1000;
    await Promise.all([chaos(stopAt), ...Array.from({ length: CLIENTS }, (_, i) => client(i, stopAt))]);
    console.log(`\nHistory: ${grants.size} distinct grants, ${stats.acquireOk} acquire OK, ${stats.held} refused (held), ${stats.renews} renews, ${stats.releases} releases`);
    console.log('Errors:', JSON.stringify(stats.errors));

    // 1. mutual exclusion
    let overlaps = 0;
    for (const key of KEYS) {
      const list = [...grants.entries()].filter(([, g]) => g.key === key).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < list.length; i++) {
        const [, a] = list[i - 1], [tb, b] = list[i];
        const end = a.relAttempt ? Math.min(a.relAttempt, a.expiresAt) : a.expiresAt;
        if (b.tResp < end) { overlaps++; console.log(`  OVERLAP on ${key}: token ${list[i - 1][0]} (${a.owner}) ended ${end}, token ${tb} (${b.owner}) granted ${b.tResp}`); console.log('    A:', JSON.stringify(a)); console.log('    B:', JSON.stringify(b)); }
      }
    }
    check('mutual exclusion: no overlapping grants', overlaps === 0, `(${grants.size} grants checked)`);
    // 2. tokens
    check('fencing tokens unique, one key each', ![...grants.values()].some(g => g.conflict));

    // heal and settle
    await J('/api/fault/heal');
    for (let i = 1; i <= N; i++) await J('/api/fault/restart', { id: i });
    let c;
    for (let i = 0; i < 60; i++) {
      c = await J('/api/cluster');
      const u = c.nodes.filter(n => n.up);
      if (u.length === N && c.nodes.filter(n => n.role === 'leader').length === 1 && u.every(n => n.logLength === u[0].logLength && n.commitIndex === n.logLength && n.lastApplied === n.logLength)) break;
      await sleep(500);
    }
    const u = c.nodes.filter(n => n.up);
    // 3. durability
    const maxTok = Math.max(0, ...grants.keys());
    check('acknowledged grants are durable (counter >= max token)', u.length > 0 && u.every(n => n.fence >= maxTok), `(max token ${maxTok}, counters ${u.map(n => n.fence)})`);
    // 4. convergence
    check('all nodes up', u.length === N);
    check('exactly one leader after healing', c.nodes.filter(n => n.role === 'leader').length === 1);
    check('logs identical and fully committed on all nodes', u.every(n => n.logLength === u[0].logLength && n.commitIndex === n.logLength && n.lastApplied === n.logLength), `(log ${u.map(n => n.logLength)})`);
    check('lock counters identical on all nodes', new Set(u.map(n => n.fence)).size === 1);
    // 5. liveness
    const live = await J('/api/acquire', { key: 'fresh-' + Date.now(), owner: 'final', ttlMs: 2000 });
    check('service available after chaos (fresh acquire works)', !!live.ok);
    console.log(`\nChaos actions: ${stats.chaos.length}`);
  } finally {
    srv.kill(); await sleep(800);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
