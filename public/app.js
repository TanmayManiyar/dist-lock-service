if (location.search.includes('embed')) document.documentElement.classList.add('embed');
const $ = id => document.getElementById(id);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COLORS = { leader: '#f5b83d', follower: '#4c9aff', candidate: '#ff8a3d', down: '#9aa3b5' };
let cluster = null;

function nodeState(n) { return n.up ? n.role : 'down'; }
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function drawRing(c) {
  const svg = $('ring'), cx = 200, cy = 150, R = 108, pts = {};
  c.nodes.forEach((n, i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / c.nodes.length;
    pts[n.id] = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  });
  let s = '';
  for (const a of c.nodes) for (const b of c.nodes) {
    if (a.id >= b.id) continue;
    const cut = (a.blocked || []).includes(b.id) || (b.blocked || []).includes(a.id);
    const dead = !a.up || !b.up;
    s += `<line x1="${pts[a.id][0]}" y1="${pts[a.id][1]}" x2="${pts[b.id][0]}" y2="${pts[b.id][1]}" stroke="${cut ? '#d1344a' : '#c9d0de'}" stroke-width="${cut ? 2 : 1.2}" stroke-dasharray="${cut ? '5 4' : dead ? '2 4' : ''}" opacity="${cut || !dead ? 1 : .45}"/>`;
  }
  for (const n of c.nodes) {
    const [x, y] = pts[n.id], st = nodeState(n);
    s += `<g><title>N${n.id}: ${st}${n.up ? ', term ' + n.term : ''}</title>`
      + (st === 'leader' ? `<circle cx="${x}" cy="${y}" r="34" fill="none" stroke="#f5b83d" stroke-width="2" opacity=".55"/>` : '')
      + `<circle cx="${x}" cy="${y}" r="28" fill="${COLORS[st]}" opacity="${st === 'down' ? .55 : 1}" ${st === 'leader' ? 'stroke="#18202f" stroke-width="2.5"' : 'stroke="#fff" stroke-width="2"'}/>
      <text x="${x}" y="${y - 1}" text-anchor="middle" font-size="15" font-weight="700" fill="#10151f">N${n.id}</text>
      <text x="${x}" y="${y + 13}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#10151f">${n.up ? 'term ' + n.term : 'down'}</text></g>`;
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
    n.up ? `<button class="kill sm" title="Crash node ${n.id}" onclick="post('/api/fault/kill',{id:${n.id}})">Kill N${n.id}</button>`
         : `<button class="good sm" title="Restart node ${n.id}" onclick="post('/api/fault/restart',{id:${n.id}})">Restart N${n.id}</button>`).join('');

  $('nodeTable').querySelector('tbody').innerHTML = c.nodes.map(n => n.up
    ? `<tr><td><b>N${n.id}</b></td><td><span class="badge ${n.role}">${n.role}</span></td><td>${n.term}</td><td>${n.logLength}</td><td>${n.commitIndex}</td><td>${(n.blocked || []).map(b => `<span class="chip">N${b}</span>`).join('') || '<span style="color:var(--faint)">&mdash;</span>'}</td></tr>`
    : `<tr><td><b>N${n.id}</b></td><td><span class="badge down">down</span></td><td colspan="4" style="color:var(--faint)">not running</td></tr>`).join('');

  const log = $('log'), atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
  log.innerHTML = c.events.map(e => {
    const cls = /FAULT|network|stepped down/.test(e.msg) ? 'fault' : /LEADER|election/.test(e.msg) ? 'lead' : '';
    const who = e.node === 'client' ? 'client' : 'N' + e.node;
    return `<div class="ev ${cls}"><time>${new Date(e.ts).toLocaleTimeString()}</time><span class="who">${who}</span><span>${esc(e.msg)}</span></div>`;
  }).join('');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderLocks(r) {
  const tb = $('lockTable').querySelector('tbody');
  if (!r.ok) { tb.innerHTML = `<tr><td colspan="4" class="empty">${r.error === 'no-leader' || r.error === 'not-leader' ? 'No quorum: the lock table is unavailable' : esc(r.error)}</td></tr>`; return; }
  const rows = Object.entries(r.locks).filter(([, l]) => l.expiresAt > r.now);
  tb.innerHTML = rows.length ? rows.map(([k, l]) => {
    const total = l.expiresAt - l.acquiredAt, left = Math.max(0, l.expiresAt - r.now), pct = Math.min(100, left / total * 100);
    return `<tr><td><b>${esc(k)}</b></td><td>${esc(l.owner)}</td><td class="token">#${l.token}</td><td>${(left / 1000).toFixed(1)}s<div class="bar"><i class="${pct < 20 ? 'low' : pct < 50 ? 'mid' : ''}" style="width:${pct}%"></i></div></td></tr>`;
  }).join('') : '<tr><td colspan="4" class="empty">No locks held. Press Acquire to take one.</td></tr>';
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
  el.textContent = r.ok ? `✔ OK${r.token ? ' · fencing token #' + r.token : ''}${r.servedBy ? ' · via leader N' + r.servedBy : ''}`
    : `✖ ${r.error}${r.holder ? ' · held by ' + r.holder + ' (token #' + r.token + ')' : ''}`;
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
  el.textContent = r.ok ? `✔ Write accepted (token #${f.token})` : `✖ REJECTED: stale token #${f.token} (resource has seen #${r.maxToken})`;
};
async function pollResource() {
  try {
    const r = await fetch('/api/resource').then(x => x.json()), rows = Object.entries(r);
    $('resTable').querySelector('tbody').innerHTML = rows.length
      ? rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td class="token">#${v.maxToken}</td><td>${esc(v.writer)}</td><td>${esc(v.value)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">No writes yet</td></tr>';
  } catch {}
  setTimeout(pollResource, 700);
}
pollResource();
poll();
