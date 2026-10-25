// Phase 2 benchmarks. Starts throw-away clusters of 3, 5 and 7 replicas on private ports and measures
// latency, throughput and failover time. Results: docs/BENCHMARKS.md and results/bench.json.
// Usage: node bench.js [--quick]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const QUICK = process.argv.includes('--quick');
const GW = 8090, BASE = 7100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (url, body) => fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const ms = n => Math.round(n * 100) / 100;

async function withCluster(n, durable, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockbench-'));
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, NODES: n, PORT: GW, BASE_PORT: BASE, DATA_DIR: dir, DURABLE: durable ? '1' : '0' }, stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 60; i++) { try { const c = await J(`http://localhost:${GW}/api/cluster`); if (c.leader && c.nodes.every(x => x.up)) break; } catch {} await sleep(250); }
    await sleep(500);
    return await fn();
  } finally {
    try { await J(`http://localhost:${GW}/api/reset`, {}); } catch {}
    srv.kill(); await sleep(1200);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}
const cluster = () => J(`http://localhost:${GW}/api/cluster`);
const leaderUrl = async () => `http://127.0.0.1:${BASE + (await cluster()).leader}`;
const op = (url, route, body) => J(url + '/client/' + route, body);

async function latency(url) {
  const count = QUICK ? 60 : 300, acq = [], rel = [];
  for (let i = 0; i < count; i++) {
    const key = 'lat' + i;
    let t = performance.now(); const a = await op(url, 'acquire', { key, owner: 'b', ttlMs: 60000 }); acq.push(performance.now() - t);
    t = performance.now(); await op(url, 'release', { key, owner: 'b', token: a.token }); rel.push(performance.now() - t);
  }
  const s = a => ({ p50: ms(pct(a, .5)), p95: ms(pct(a, .95)), p99: ms(pct(a, .99)) });
  return { acquire: s(acq), release: s(rel) };
}

async function throughput(url, workers) {
  const dur = QUICK ? 2000 : 4000, end = Date.now() + dur; let ops = 0, fails = 0;
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    let i = 0;
    while (Date.now() < end) {
      const key = `w${w}-${i++}`;
      const a = await op(url, 'acquire', { key, owner: 'w' + w, ttlMs: 60000 });
      if (!a.ok) { fails++; continue; }
      const r = await op(url, 'release', { key, owner: 'w' + w, token: a.token });
      ops += 2; if (!r.ok) fails++;
    }
  }));
  return { workers, opsPerSec: Math.round(ops / (dur / 1000)), fails };
}

async function failover(trials) {
  const times = [];
  for (let t = 0; t < trials; t++) {
    const c = await cluster(); const dead = c.leader;
    const t0 = performance.now();
    await J(`http://localhost:${GW}/api/fault/kill`, { id: dead });
    let ok = false;
    while (performance.now() - t0 < 15000) { // time until a client can successfully acquire again
      const r = await J(`http://localhost:${GW}/api/acquire`, { key: 'fo' + t + Math.random(), owner: 'b', ttlMs: 5000 }).catch(() => ({}));
      if (r.ok && r.servedBy !== dead) { ok = true; break; }
      await sleep(25);
    }
    times.push(ok ? ms(performance.now() - t0) : null);
    await J(`http://localhost:${GW}/api/fault/restart`, { id: dead });
    for (let i = 0; i < 60; i++) { const x = await cluster(); if (x.nodes.every(n => n.up && n.commitIndex === n.logLength)) break; await sleep(250); }
    await sleep(500);
  }
  const good = times.filter(x => x !== null);
  return { trials, times, min: Math.min(...good), median: pct(good, .5), max: Math.max(...good) };
}

(async () => {
  const results = { when: new Date().toISOString(), machine: `${os.cpus()[0].model.trim()} x${os.cpus().length}, ${os.platform()}, node ${process.version}`, runs: [] };
  const plan = [[3, false], [5, false], [7, false], [5, true]];
  for (const [n, durable] of plan) {
    console.log(`\n== ${n} replicas, fsync ${durable ? 'ON' : 'OFF'} ==`);
    const r = await withCluster(n, durable, async () => {
      const url = await leaderUrl();
      const lat = await latency(url); console.log('latency', JSON.stringify(lat));
      const tp = []; for (const w of [1, 8, 32]) { const x = await throughput(url, w); tp.push(x); console.log('throughput', JSON.stringify(x)); }
      const fo = await failover(QUICK ? 2 : 5); console.log('failover', JSON.stringify(fo));
      return { latency: lat, throughput: tp, failover: fo };
    });
    results.runs.push({ replicas: n, fsync: durable, ...r });
  }
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', 'bench.json'), JSON.stringify(results, null, 2));

  let md = `# Benchmarks\n\nGenerated by \`node bench.js\` on ${results.when}.\nMachine: ${results.machine}.\nAll replicas are local processes on one machine talking over loopback HTTP, so absolute numbers are **not** cloud numbers; the trends (cluster size, durability, failover) are what matters. Latency is measured directly against the leader (excludes the gateway).\n\n`;
  md += '## Latency (ms, per operation, sequential client)\n\n| Replicas | fsync | acquire p50 | p95 | p99 | release p50 | p95 | p99 |\n|---|---|---|---|---|---|---|---|\n';
  for (const r of results.runs) md += `| ${r.replicas} | ${r.fsync ? 'on' : 'off'} | ${r.latency.acquire.p50} | ${r.latency.acquire.p95} | ${r.latency.acquire.p99} | ${r.latency.release.p50} | ${r.latency.release.p95} | ${r.latency.release.p99} |\n`;
  md += '\n## Throughput (committed operations per second)\n\n| Replicas | fsync | 1 client | 8 clients | 32 clients |\n|---|---|---|---|---|\n';
  for (const r of results.runs) md += `| ${r.replicas} | ${r.fsync ? 'on' : 'off'} | ${r.throughput.map(t => t.opsPerSec).join(' | ')} |\n`;
  md += '\n## Failover time (leader killed until a client can acquire a lock again, ms)\n\n| Replicas | fsync | trials | min | median | max |\n|---|---|---|---|---|---|\n';
  for (const r of results.runs) md += `| ${r.replicas} | ${r.fsync ? 'on' : 'off'} | ${r.failover.trials} | ${r.failover.min} | ${r.failover.median} | ${r.failover.max} |\n`;
  md += '\nSee docs/PHASE2.md for the interpretation of these numbers. Re-run on the target machine (or the cloud deployment) for real figures.\n';
  fs.writeFileSync(path.join(__dirname, 'docs', 'BENCHMARKS.md'), md);
  console.log('\nWritten docs/BENCHMARKS.md');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
