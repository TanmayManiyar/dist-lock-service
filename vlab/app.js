if (location.search.includes('embed')) document.documentElement.classList.add('embed');
const $ = id => document.getElementById(id);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COLORS = { leader: '#f5b83d', follower: '#4c9aff', candidate: '#ff8a3d', down: '#9aa3b5' };
let cluster = null;

function nodeState(n) { return n.up ? n.role : 'down'; }

function drawRing(c) {
  const svg = $('ring'), cx = 200, cy = 150, R = 105, pts = {};
  c.nodes.forEach((n, i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / c.nodes.length;
    pts[n.id] = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  });
  let s = '';
  for (const a of c.nodes) for (const b of c.nodes) {
    if (a.id >= b.id) continue;
    const cut = (a.blocked || []).includes(b.id) || (b.blocked || []).includes(a.id);
    const dead = !a.up || !b.up;
    s += `<line x1="${pts[a.id][0]}" y1="${pts[a.id][1]}" x2="${pts[b.id][0]}" y2="${pts[b.id][1]}" stroke="${cut ? '#ff5d6c' : '#c3cad8'}" stroke-width="${cut ? 1.5 : 1}" stroke-dasharray="${cut ? '4 4' : dead ? '2 4' : ''}" opacity="${cut || !dead ? 1 : .4}"/>`;
  }
  for (const n of c.nodes) {
    const [x, y] = pts[n.id], st = nodeState(n);
    s += `<circle cx="${x}" cy="${y}" r="26" fill="${COLORS[st]}" opacity="${st === 'down' ? .5 : 1}" ${st === 'leader' ? 'stroke="#1a2233" stroke-width="2.5"' : ''}/>
      <text x="${x}" y="${y - 2}" text-anchor="middle" font-size="14" font-weight="700" fill="#0f1420">N${n.id}</text>
      <text x="${x}" y="${y + 12}" text-anchor="middle" font-size="10" fill="#0f1420">${n.up ? 't' + n.term : 'down'}</text>`;
  }
  svg.innerHTML = s;
}

function render(c) {
  cluster = c;
  const up = c.nodes.filter(n => n.up).length, maj = Math.floor(c.n / 2) + 1;
  const el = $('summary');
  el.textContent = c.leader ? `Leader: N${c.leader} · ${up}/${c.n} nodes up (quorum ${maj})` : `No leader · ${up}/${c.n} nodes up (quorum ${maj})`;
  el.className = 'status ' + (c.leader ? 'ok' : 'bad');
  drawRing(c);

  $('nodeBtns').innerHTML = c.nodes.map(n =>
    n.up ? `<button class="kill" onclick="post('/api/fault/kill',{id:${n.id}})">Kill N${n.id}</button>`
         : `<button class="good" onclick="post('/api/fault/restart',{id:${n.id}})">Restart N${n.id}</button>`).join('');

  $('nodeTable').querySelector('tbody').innerHTML = c.nodes.map(n => n.up
    ? `<tr><td>N${n.id}</td><td>${n.role}</td><td>${n.term}</td><td>${n.logLength}</td><td>${n.commitIndex}</td><td>${(n.blocked || []).map(b => 'N' + b).join(', ') || '—'}</td></tr>`
    : `<tr><td>N${n.id}</td><td colspan="5" style="color:var(--mute)">down</td></tr>`).join('');

  const log = $('log'), atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.innerHTML = c.events.map(e => {
    const cls = /FAULT|network|stepped down/.test(e.msg) ? 'fault' : /LEADER|election/.test(e.msg) ? 'lead' : '';
    const who = e.node === 'client' ? 'client' : 'N' + e.node;
    return `<div class="${cls}">${new Date(e.ts).toLocaleTimeString()} <b>${who}</b> ${e.msg}</div>`;
  }).join('');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderLocks(r) {
  const tb = $('lockTable').querySelector('tbody');
  if (!r.ok) { tb.innerHTML = `<tr><td colspan="4" class="empty">${r.error === 'no-leader' || r.error === 'not-leader' ? 'No quorum – lock table unavailable' : r.error}</td></tr>`; return; }
  const rows = Object.entries(r.locks).filter(([, l]) => l.expiresAt > r.now);
  tb.innerHTML = rows.length ? rows.map(([k, l]) => {
    const total = l.expiresAt - l.acquiredAt, left = Math.max(0, l.expiresAt - r.now);
    return `<tr><td>${k}</td><td>${l.owner}</td><td>#${l.token}</td><td>${(left / 1000).toFixed(1)}s<div class="bar"><i style="width:${Math.min(100, left / total * 100)}%"></i></div></td></tr>`;
  }).join('') : '<tr><td colspan="4" class="empty">No locks held</td></tr>';
}

async function poll() {
  try {
    const [c, l] = await Promise.all([fetch('/api/cluster').then(r => r.json()), fetch('/api/locks').then(r => r.json())]);
    render(c); renderLocks(l);
  } catch { $('summary').textContent = 'gateway unreachable'; $('summary').className = 'status bad'; }
  setTimeout(poll, 500);
}

// ----- client actions -----
function show(r) {
  const el = $('result');
  el.className = 'result ' + (r.ok ? 'ok' : 'err');
  el.textContent = r.ok ? `OK${r.token ? ' · fencing token #' + r.token : ''}${r.servedBy ? ' · via leader N' + r.servedBy : ''}`
    : `FAILED: ${r.error}${r.holder ? ' · held by ' + r.holder + ' (token #' + r.token + ')' : ''}`;
  if (r.ok && r.token) $('token').value = r.token;
}
const form = () => ({ key: $('key').value, owner: $('owner').value, ttlMs: +$('ttl').value, token: +$('token').value });
$('acq').onclick = async () => show(await post('/api/acquire', form()));
$('ren').onclick = async () => show(await post('/api/renew', form()));
$('rel').onclick = async () => show(await post('/api/release', form()));

$('isolateLeader').onclick = () => {
  if (!cluster || !cluster.leader) return;
  const others = cluster.nodes.map(n => n.id).filter(i => i !== cluster.leader);
  post('/api/fault/partition', { groups: [[cluster.leader], others] });
};
$('splitMajority').onclick = () => {
  if (!cluster) return;
  const ids = cluster.nodes.map(n => n.id), k = Math.floor(ids.length / 2) + 1;
  post('/api/fault/partition', { groups: [ids.slice(0, k), ids.slice(k)] });
};
$('healBtn').onclick = () => post('/api/fault/heal');

// ----- fencing demo -----
$('fenceDemo').onclick = async () => {
  const btn = $('fenceDemo'), ol = $('fenceSteps');
  btn.disabled = true; ol.innerHTML = '';
  const step = (t, cls) => { const li = document.createElement('li'); li.textContent = t; if (cls) li.className = cls; ol.appendChild(li); };
  const key = 'fence-demo-' + Date.now() % 10000;
  const a = await post('/api/acquire', { key, owner: 'client-A', ttlMs: 1500 });
  if (!a.ok) { step('Could not acquire: ' + a.error, 'bad'); btn.disabled = false; return; }
  step(`client-A acquires "${key}" (1.5s lease) → token #${a.token}`, 'ok');
  await post('/api/resource/write', { key, token: a.token, owner: 'client-A', value: 'A-1' });
  step('client-A writes to the resource: accepted', 'ok');
  step('client-A stalls (simulated GC pause / network stall)…');
  await sleep(2200);
  const b = await post('/api/acquire', { key, owner: 'client-B', ttlMs: 5000 });
  step(`lease expired; client-B acquires the lock → token #${b.token}`, 'ok');
  await post('/api/resource/write', { key, token: b.token, owner: 'client-B', value: 'B-1' });
  step('client-B writes to the resource: accepted', 'ok');
  const w = await post('/api/resource/write', { key, token: a.token, owner: 'client-A', value: 'A-2 (stale!)' });
  step(w.ok ? 'client-A wakes up and writes: ACCEPTED (unsafe!)' : `client-A wakes up, still believes it holds the lock, writes with token #${a.token}: REJECTED (resource has seen #${w.maxToken})`, w.ok ? 'bad' : 'ok');
  await post('/api/release', { key, owner: 'client-B', token: b.token });
  btn.disabled = false;
};

$('rwrite').onclick = async () => {
  const f = form(), r = await post('/api/resource/write', { key: f.key, token: f.token, owner: f.owner, value: $('rvalue').value });
  const el = $('rresult');
  el.className = 'result ' + (r.ok ? 'ok' : 'err');
  el.textContent = r.ok ? `Write accepted (token #${f.token})` : `REJECTED: stale token #${f.token} (resource has seen #${r.maxToken})`;
};
async function pollResource() {
  try {
    const r = await fetch('/api/resource').then(x => x.json()), rows = Object.entries(r);
    $('resTable').querySelector('tbody').innerHTML = rows.length
      ? rows.map(([k, v]) => `<tr><td>${k}</td><td>#${v.maxToken}</td><td>${v.writer}</td><td>${v.value}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">No writes yet</td></tr>';
  } catch {}
  setTimeout(pollResource, 700);
}
pollResource();
poll();
