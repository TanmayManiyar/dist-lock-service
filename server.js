// Gateway: spawns the replica cluster, routes client requests to the leader,
// exposes fault injection (kill / restart / partition) and serves the dashboard.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// REMOTE_NODES="1=10.0.1.11:7001,2=10.0.1.12:7001,..." -> replicas run on other hosts; faults use their admin API
const REMOTE = {};
for (const kv of (process.env.REMOTE_NODES || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); REMOTE[+k] = v; }
const isRemote = Object.keys(REMOTE).length > 0;
const N = isRemote ? Object.keys(REMOTE).length : +(process.env.NODES || 5);
const PORT = +(process.env.PORT || 8080);
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const BASE_PORT = +process.env.BASE_PORT || 7000;
const PUBLIC = path.join(__dirname, 'public');
if (process.argv.includes('--fresh')) fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const procs = {};
const DEFAULT_CONFIG = { prevote: true, checkQuorum: true, electionMin: 600, electionMax: 1100, fencing: true };
let config = { ...DEFAULT_CONFIG };
function startNode(id) {
  if (isRemote) { call(id, '/admin/start', {}); setTimeout(() => call(id, '/admin/config', config), 700); return; }
  if (procs[id]) return;
  const p = spawn(process.execPath, [path.join(__dirname, 'node.js'), id, N, DATA], { stdio: 'inherit' });
  procs[id] = p;
  setTimeout(() => { if (procs[id] === p) call(id, '/admin/config', config); }, 700); // re-apply lab toggles after a restart
  p.on('exit', () => { if (procs[id] === p) delete procs[id]; });
}
function stopNode(id) { if (isRemote) { call(id, '/admin/crash', {}); return; } const p = procs[id]; if (p) { delete procs[id]; p.kill(); } }
if (!isRemote) for (let i = 1; i <= N; i++) startNode(i);
process.on('exit', () => Object.keys(procs).forEach(stopNode));
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => process.exit(0)));

let partition = null; // array of groups, or null when healed
const actionLog = [];
const logAction = msg => { actionLog.push({ ts: Date.now(), node: 'client', msg }); if (actionLog.length > 60) actionLog.shift(); };

const nodeUrl = id => `http://${REMOTE[id] || '127.0.0.1:' + (BASE_PORT + id)}`;
async function call(id, route, body) {
  try {
    const r = await fetch(nodeUrl(id) + route, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000),
    });
    return await r.json();
  } catch { return null; }
}
async function statuses() {
  const out = await Promise.all([...Array(N).keys()].map(async i => {
    const id = i + 1;
    const s = await Promise.race([call(id, '/status'), new Promise(r => setTimeout(() => r(null), 400))]);
    return { id, up: !!s, ...(s || {}) };
  }));
  return out;
}
const currentLeader = sts => {
  const ls = sts.filter(s => s.up && s.role === 'leader').sort((a, b) => b.term - a.term);
  return ls[0] ? ls[0].id : null;
};

// Route a client op to the leader, following redirects / re-probing (leader discovery).
let leaderCache = null;
async function viaLeader(route, body, retry = false) {
  let hint = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = hint || leaderCache || currentLeader(await statuses());
    hint = null; leaderCache = null;
    if (id) {
      const r = await call(id, route, body);
      if (r && r.error === 'not-leader') hint = r.leader || null;
      else if (r) {
        const stale = r.error === 'leadership-lost' || r.error === 'timeout';
        if (stale && retry && attempt < 4) continue;   // idempotent op: re-probe, the cached leader may be cut off
        if (!stale) leaderCache = id;
        return { ...r, servedBy: id };
      }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return { ok: false, error: 'no-leader' };
}

// Protected resource used to demonstrate fencing tokens: rejects any write carrying a stale token.
const resource = {}; // key -> {maxToken, value, writer}

function applyPartition(groups) {
  partition = groups;
  return Promise.all([...Array(N).keys()].map(i => {
    const id = i + 1;
    const mine = groups ? groups.find(g => g.includes(id)) || [id] : [];
    const ids = groups ? [...Array(N).keys()].map(x => x + 1).filter(x => !mine.includes(x)) : [];
    return call(id, '/admin/block', { ids });
  }));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });

const AUTH = process.env.BASIC_AUTH ? 'Basic ' + Buffer.from(process.env.BASIC_AUTH).toString('base64') : null;
http.createServer(async (req, res) => {
  if (AUTH && req.headers.authorization !== AUTH) { res.writeHead(401, { 'www-authenticate': 'Basic realm="lock-service"' }); return res.end('authentication required'); }
  const url = req.url.split('?')[0];
  const body = req.method === 'POST' ? await readBody(req) : {};

  if (url === '/api/cluster') {
    const nodes = await statuses();
    const leader = currentLeader(nodes);
    const events = [...actionLog, ...nodes.flatMap(n => n.events || [])].sort((a, b) => a.ts - b.ts).slice(-80);
    nodes.forEach(n => delete n.events);
    return json(res, 200, { nodes, leader, partition, events, clientEvents: actionLog, n: N });
  }
  if (url === '/api/locks') {
    const r = await viaLeader('/client/locks');
    return json(res, 200, r);
  }
  if (['/api/acquire', '/api/renew', '/api/release'].includes(url)) {
    const op = url.slice(5);
    const r = await viaLeader('/client/' + op, body, op !== 'release');
    logAction(`${body.owner} ${op} "${body.key}" -> ${r.ok ? 'OK' + (r.token ? ' token ' + r.token : '') : r.error + (r.holder ? ' (held by ' + r.holder + ')' : '')}`);
    return json(res, 200, r);
  }
  if (url === '/api/resource/write') {
    const { key, token, owner, value } = body;
    const cur = resource[key] || { maxToken: 0 };
    if (config.fencing && token < cur.maxToken) {
      logAction(`RESOURCE rejected stale write to "${key}" from ${owner} (token ${token} < ${cur.maxToken})`);
      return json(res, 200, { ok: false, error: 'stale-token', maxToken: cur.maxToken });
    }
    resource[key] = { maxToken: Math.max(cur.maxToken, token), lastToken: token, value, writer: owner };
    logAction(`RESOURCE accepted write to "${key}" from ${owner} (token ${token})${config.fencing ? '' : ' [fencing OFF]'}`);
    return json(res, 200, { ok: true });
  }
  if (url === '/api/resource') return json(res, 200, resource);

  if (url === '/api/config') {
    if (req.method === 'POST') {
      config = { ...config, ...body };
      await Promise.all([...Array(N).keys()].map(i => call(i + 1, '/admin/config', config)));
      logAction(`CONFIG: prevote=${config.prevote} checkQuorum=${config.checkQuorum} election=${config.electionMin}-${config.electionMax}ms`);
    }
    return json(res, 200, config);
  }
  if (url === '/api/reset') { // fresh cluster for the next lab experiment
    if (isRemote) {
      await Promise.all([...Array(N).keys()].map(i => call(i + 1, '/admin/wipe', {})));
    } else {
      Object.keys(procs).forEach(stopNode);
      await new Promise(r => setTimeout(r, 700));
      fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
      fs.mkdirSync(DATA, { recursive: true });
    }
    partition = null; config = { ...DEFAULT_CONFIG };
    for (const k of Object.keys(resource)) delete resource[k];
    actionLog.length = 0; logAction('LAB: cluster reset to a clean state');
    if (!isRemote) for (let i = 1; i <= N; i++) startNode(i);
    return json(res, 200, { ok: true });
  }
  if (url === '/api/feedback' && req.method === 'POST') {
    fs.appendFileSync(path.join(DATA, 'feedback.jsonl'), JSON.stringify({ ts: Date.now(), ...body }) + '\n');
    return json(res, 200, { ok: true });
  }
  if (url === '/api/fault/wipe') { // simulate losing a node's disk
    if (isRemote) await call(body.id, '/admin/wipe', {});
    else {
      stopNode(body.id);
      await new Promise(r => setTimeout(r, 600));
      for (const ext of ['json', 'wal']) fs.rmSync(path.join(DATA, `node${body.id}.${ext}`), { force: true, maxRetries: 5 });
      startNode(body.id);
    }
    logAction(`FAULT: wiped disk of node ${body.id} and restarted it`);
    return json(res, 200, { ok: true });
  }
  if (url === '/api/fault/kill') { stopNode(body.id); logAction(`FAULT: killed node ${body.id}`); return json(res, 200, { ok: true }); }
  if (url === '/api/fault/restart') { startNode(body.id); logAction(`FAULT: restarted node ${body.id}`); return json(res, 200, { ok: true }); }
  if (url === '/api/fault/partition') { await applyPartition(body.groups); logAction(`FAULT: partition ${JSON.stringify(body.groups)}`); return json(res, 200, { ok: true }); }
  if (url === '/api/fault/heal') { await applyPartition(null); logAction('FAULT: network healed'); return json(res, 200, { ok: true }); }

  const file = path.join(PUBLIC, url === '/' ? 'index.html' : url.endsWith('/') ? url + 'index.html' : url);
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => console.log(`Lock service dashboard: http://localhost:${PORT}  (${N} replicas${isRemote ? ', remote' : ' on :' + (BASE_PORT + 1) + '-:' + (BASE_PORT + N)})`));
