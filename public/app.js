const qs = new URLSearchParams(location.search);
if (qs.has('embed')) document.documentElement.classList.add('embed');
const $ = id => document.getElementById(id);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COLORS = { leader: '#f5b83d', follower: '#4c9aff', candidate: '#ff8a3d', down: '#9aa3b5' };
const ROLE_LABEL = { leader: 'Leader', follower: 'Follower', candidate: 'Candidate', down: 'Down' };
let cluster = null;

// the lab embeds this page and can limit which cards are shown (?show=cluster,lock,...)
const only = (qs.get('show') || '').split(',').filter(Boolean);
if (only.length) {
  document.querySelectorAll('[data-card]').forEach(c => { c.hidden = !only.includes(c.dataset.card); });
  if (only.length <= 2) document.documentElement.classList.add('stack');
}
// inside the lab the steps refer to the node table, so keep it open
document.querySelectorAll('.more').forEach(d => { d.open = true; });
// fit-to-screen layout: the cluster gets a full-width row, every other visible card gets a column under it
document.documentElement.style.setProperty('--cols', Math.max(1, document.querySelectorAll('[data-card=lock]:not([hidden]),[data-card=fence]:not([hidden])').length));
// lab: highlight the cards the current step needs
window.setFocus = list => document.querySelectorAll('[data-card]').forEach(c => c.classList.toggle('focus', (list || []).includes(c.dataset.card)));

const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg) { const t = $('toast'); if (!t) return; t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2600); }
function nodeState(n) { return n.up ? n.role : 'down'; }

function drawRing(c) {
  const svg = $('ring'), cx = 200, cy = 146, R = 104, pts = {};
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
    s += `<g><title>N${n.id}: ${ROLE_LABEL[st]}${n.up ? ', election round (term) ' + n.term : ''}</title>`
      + (st === 'leader' ? `<circle cx="${x}" cy="${y}" r="36" fill="none" stroke="#f5b83d" stroke-width="2" opacity=".55"/>` : '')
      + `<circle cx="${x}" cy="${y}" r="30" fill="${COLORS[st]}" opacity="${st === 'down' ? .55 : 1}" ${st === 'leader' ? 'stroke="#18202f" stroke-width="2.5"' : 'stroke="#fff" stroke-width="2"'}/>
      <text x="${x}" y="${y - 1}" text-anchor="middle" font-size="15" font-weight="700" fill="#10151f">N${n.id}</text>
      <text x="${x}" y="${y + 13}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#10151f">${n.up ? 'term ' + n.term : 'down'}</text>
      <text x="${x}" y="${y + 47}" text-anchor="middle" font-size="12" font-weight="700" fill="${st === 'leader' ? '#7a5200' : st === 'down' ? '#667085' : '#1d4ed8'}">${ROLE_LABEL[st]}</text></g>`;
  }
  svg.innerHTML = s;
}

// one plain-English sentence describing the cluster right now
function storyOf(c) {
  const up = c.nodes.filter(n => n.up).length, n = c.n, need = Math.floor(n / 2) + 1;
  const cut = c.nodes.some(x => x.up && (x.blocked || []).length);
  if (c.leader) {
    const l = `N${c.leader}`;
    if (cut) return ['warn', `The network is split. ${l} is leading the side that can still reach a majority (${need} or more machines). The other side cannot do anything until you reconnect.`];
    if (up === n) return ['ok', `All ${n} machines are running and ${l} is the leader. The service is healthy and could survive ${n - need} machines failing.`];
    if (up === need) return ['warn', `${l} is the leader, but only ${up} of ${n} machines are running: the bare minimum. One more failure would stop the service. Restart a crashed machine.`];
    return ['ok', `${l} is the leader. ${up} of ${n} machines are running, which is still enough (${need} are needed), so locks keep working.`];
  }
  if (up < need) return ['bad', `The service has stopped. Only ${up} of ${n} machines are running and ${need} are needed to agree on anything. Restart a crashed machine to bring it back.`];
  if (cut) return ['warn', 'No leader yet: the machines on each side of the split are holding elections. Only a side with a majority can win.'];
  return ['warn', 'There is no leader right now. The machines have noticed and are voting for a new one; this usually takes about a second.'];
}

function render(c) {
  cluster = c;
  const up = c.nodes.filter(n => n.up).length, maj = Math.floor(c.n / 2) + 1;
  const el = $('summary');
  el.textContent = c.leader ? `Leader: N${c.leader} · ${up}/${c.n} machines up (need ${maj})` : `No leader · ${up}/${c.n} machines up (need ${maj})`;
  el.className = 'status ' + (c.leader ? 'ok' : 'bad');
  const [tone, text] = storyOf(c);
  const st = $('story'); if (st) { st.className = 'story ' + tone; st.textContent = text; }
  drawRing(c);

  $('nodeBtns').innerHTML = c.nodes.map(n =>
    n.up ? `<button class="kill sm" title="Crash machine ${n.id}" onclick="post('/api/fault/kill',{id:${n.id}})">Kill N${n.id}</button>`
         : `<button class="good sm" title="Bring machine ${n.id} back online" onclick="post('/api/fault/restart',{id:${n.id}})">Restart N${n.id}</button>`).join('');

  $('nodeTable').querySelector('tbody').innerHTML = c.nodes.map(n => n.up
    ? `<tr><td><b>N${n.id}</b></td><td><span class="badge ${n.role}">${n.role}</span></td><td>${n.term}</td><td>${n.logLength}</td><td>${n.commitIndex}</td><td>${(n.blocked || []).map(b => `<span class="chip">N${b}</span>`).join('') || '<span style="color:var(--faint)">&mdash;</span>'}</td></tr>`
    : `<tr><td><b>N${n.id}</b></td><td><span class="badge down">down</span></td><td colspan="4" style="color:var(--faint)">crashed: not running</td></tr>`).join('');

  const log = $('log'), atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
  log.innerHTML = c.events.map(e => {
    const f = friendly(e.msg);
    const who = e.node === 'client' ? 'You' : 'N' + e.node;
    return `<div class="ev ${f.cls}" title="${esc(e.msg)}"><time>${new Date(e.ts).toLocaleTimeString([], { hour12: false })}</time><span class="who">${who}</span><span>${esc(f.text)}</span></div>`;
  }).join('');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// translate the raw protocol messages into plain English (the raw text stays in the tooltip)
const FRIENDLY = [
  [/^started on :\d+ \(term (\d+), log (\d+)\)/, (a, t) => `started up (election round ${t})`, ''],
  [/^started \(term (\d+), log (\d+)\)/, (a, t) => `started up (election round ${t})`, ''],
  [/^restarted with a wiped disk/, () => 'came back online with an EMPTY disk and has to catch up from the others', 'fault'],
  [/^restarted \(term (\d+), log (\d+)\)/, (a, t, l) => `came back online and reloaded its saved data (${l} operations)`, 'ok'],
  [/^election started for term (\d+)/, (a, t) => `lost contact with the leader and started an election for round ${t}`, 'lead'],
  [/^became LEADER for term (\d+)/, (a, t) => `won the election and is now the leader (round ${t})`, 'lead'],
  [/^stepped down to follower \(term (\d+)\)(?: - (.*))?/, (a, t, why) => `stepped down to follower (round ${t})${why ? ': ' + why.replace('lost contact with majority (check-quorum)', 'it could not reach a majority of machines') : ''}`, 'fault'],
  [/^network: cut off from nodes \[(.*)\]/, (a, l) => `can no longer reach ${l.split(',').map(x => 'N' + x).join(', ')}`, 'fault'],
  [/^network: healed/, () => 'network reconnected', 'ok'],
  [/^config: prevote=(\w+) checkQuorum=(\w+) election=(\S+)/, (a, p, q, e) => `settings changed (PreVote ${p === 'true' ? 'on' : 'off'}, check-quorum ${q === 'true' ? 'on' : 'off'}, election timeout ${e})`, ''],
  [/^acquire "(.+)" by (.+) -> token (\d+)/, (a, k, o, t) => `granted lock "${k}" to ${o} (token #${t})`, ''],
  [/^renew "(.+)" by (.+) -> token (\d+)/, (a, k, o, t) => `extended ${o}'s lease on "${k}" (token #${t})`, ''],
  [/^release "(.+)" by (.+)/, (a, k, o) => `lock "${k}" released by ${o}`, ''],
  [/^FAULT: killed node (\d+)/, (a, n) => `crashed machine N${n}`, 'fault'],
  [/^FAULT: restarted node (\d+)/, (a, n) => `restarted machine N${n}`, 'ok'],
  [/^FAULT: wiped disk of node (\d+)/, (a, n) => `wiped the disk of N${n} and restarted it`, 'fault'],
  [/^FAULT: partition (.*)/, (a, g) => `cut the network into groups ${g}`, 'fault'],
  [/^FAULT: network healed/, () => 'reconnected the network', 'ok'],
  [/^LAB: cluster reset.*/, () => 'reset the simulation to a fresh cluster', 'ok'],
  [/^CONFIG: prevote=(\w+) checkQuorum=(\w+) election=(\S+)/, (a, p, q, e) => `changed settings (PreVote ${p === 'true' ? 'on' : 'off'}, check-quorum ${q === 'true' ? 'on' : 'off'}, election ${e})`, ''],
  [/^RESOURCE rejected stale write to "(.+)" from (.+) \(token (\d+) < (\d+)\)/, (a, k, o, t, mx) => `✖ storage REFUSED a write to "${k}" from ${o}: token #${t} is older than #${mx} already seen`, 'fault'],
  [/^RESOURCE accepted write to "(.+)" from (.+) \(token (\d+)\)(.*)/, (a, k, o, t, x) => `✔ storage accepted a write to "${k}" from ${o} (token #${t})${x ? ' - fencing is OFF, so nothing was checked' : ''}`, 'ok'],
  [/^(\S+) (acquire|renew|release) "(.+)" -> OK(?: token (\d+))?/, (a, o, op, k, t) => `${o} ${op === 'acquire' ? 'asked for' : op === 'renew' ? 'renewed' : 'released'} "${k}": granted${t ? ' (token #' + t + ')' : ''}`, 'ok'],
  [/^(\S+) (acquire|renew|release) "(.+)" -> (\S+)(?: \(held by (.+)\))?/, (a, o, op, k, e, h) => `${o} tried to ${op} "${k}": refused${h ? ' (held by ' + h + ')' : ' (' + e + ')'}`, 'fault'],
];
function friendly(msg) {
  for (const [re, fn, cls] of FRIENDLY) { const mm = re.exec(msg); if (mm) return { text: fn(...mm), cls }; }
  return { text: msg, cls: '' };
}

function renderLocks(r) {
  const tb = $('lockTable').querySelector('tbody');
  if (!r.ok) { tb.innerHTML = `<tr><td colspan="4" class="empty">${r.error === 'no-leader' || r.error === 'not-leader' ? 'The service cannot answer right now: fewer than 3 machines can reach each other.' : esc(r.error)}</td></tr>`; return; }
  const rows = Object.entries(r.locks).filter(([, l]) => l.expiresAt > r.now);
  tb.innerHTML = rows.length ? rows.map(([k, l]) => {
    const total = l.expiresAt - l.acquiredAt, left = Math.max(0, l.expiresAt - r.now), pct = Math.min(100, left / total * 100);
    return `<tr><td><b>${esc(k)}</b></td><td>${esc(l.owner)}</td><td class="token">#${l.token}</td><td>${(left / 1000).toFixed(1)}s<div class="bar"><i class="${pct < 20 ? 'low' : pct < 50 ? 'mid' : ''}" style="width:${pct}%"></i></div></td></tr>`;
  }).join('') : '<tr><td colspan="4" class="empty">Nobody holds a lock. Press Acquire to take one.</td></tr>';
}

async function poll() {
  try {
    const [c, l] = await Promise.all([fetch('/api/cluster').then(r => r.json()), fetch('/api/locks').then(r => r.json())]);
    render(c); renderLocks(l);
  } catch { $('summary').textContent = 'gateway unreachable'; $('summary').className = 'status bad'; }
  setTimeout(poll, 500);
}

// ----- client actions -----
function say(r, op, f) {
  const el = $('result');
  el.className = 'result ' + (r.ok ? 'ok' : 'err');
  if (r.ok) {
    el.textContent = op === 'acquire' ? `✔ Granted: ${f.owner} now holds "${f.key}". Fencing token #${r.token}${r.reentrant ? ' (it already held this lock)' : ''}.`
      : op === 'renew' ? `✔ Lease extended: ${f.owner} keeps "${f.key}" for another ${(f.ttlMs / 1000).toFixed(1)} s.`
      : `✔ Released: "${f.key}" is free again.`;
    if (r.token && op === 'acquire') $('token').value = r.token;
  } else if (r.error === 'held') {
    el.textContent = `✖ Refused: "${f.key}" is already held by ${r.holder} (token #${r.token}). Wait for it to be released or for its lease to run out.`;
  } else if (r.error === 'not-holder') {
    el.textContent = `✖ Refused: ${f.owner} does not hold "${f.key}" with that token (wrong name or token, or the lease already ran out).`;
  } else if (r.error === 'leadership-lost') {
    el.textContent = '✖ The leader changed while your request was being processed. Press the button again.';
  } else {
    el.textContent = `✖ No answer (${r.error}). Probably fewer than 3 machines can reach each other.`;
  }
}
const form = () => ({ key: $('key').value, owner: $('owner').value, ttlMs: +$('ttl').value, token: +$('token').value });
const act = op => async () => { const f = form(); say(await post('/api/' + op, f), op, f); };
$('acq').onclick = act('acquire');
$('ren').onclick = act('renew');
$('rel').onclick = act('release');

const crashLeader = () => { if (!cluster || !cluster.leader) { toast('There is no leader to crash right now.'); return; } post('/api/fault/kill', { id: cluster.leader }); };
const isolate = () => {
  if (!cluster || !cluster.leader) { toast('There is no leader to isolate right now.'); return; }
  const others = cluster.nodes.map(n => n.id).filter(i => i !== cluster.leader);
  post('/api/fault/partition', { groups: [[cluster.leader], others] });
};
$('crashLeader').onclick = crashLeader;
$('isolateLeader').onclick = isolate;
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
  step(`client-A takes the lock "${key}" for 1.5 s and gets token #${a.token}.`, 'ok');
  await post('/api/resource/write', { key, token: a.token, owner: 'client-A', value: 'A-1' });
  step('client-A writes to the storage: accepted.', 'ok');
  step('client-A freezes (imagine a long pause or a network stall)…');
  await sleep(2200);
  const b = await post('/api/acquire', { key, owner: 'client-B', ttlMs: 5000 });
  step(`client-A's lease ran out, so client-B takes the lock and gets token #${b.token}.`, 'ok');
  await post('/api/resource/write', { key, token: b.token, owner: 'client-B', value: 'B-1' });
  step('client-B writes to the storage: accepted.', 'ok');
  const w = await post('/api/resource/write', { key, token: a.token, owner: 'client-A', value: 'A-2 (stale!)' });
  step(w.ok ? 'client-A wakes up, still thinks it owns the lock, and writes: ACCEPTED (unsafe: it overwrote B)' : `client-A wakes up, still thinks it owns the lock, and writes with token #${a.token}: REFUSED, because the storage has already seen #${w.maxToken}. The data is safe.`, w.ok ? 'bad' : 'ok');
  await post('/api/release', { key, owner: 'client-B', token: b.token });
  btn.disabled = false;
};

$('rwrite').onclick = async () => {
  const f = form(), r = await post('/api/resource/write', { key: f.key, token: f.token, owner: f.owner, value: $('rvalue').value });
  const el = $('rresult');
  el.className = 'result ' + (r.ok ? 'ok' : 'err');
  el.textContent = r.ok ? `✔ Write accepted: token #${f.token} is new enough.` : `✖ Write REFUSED: token #${f.token} is older than #${r.maxToken}, which the storage has already seen.`;
};
async function pollResource() {
  try {
    const r = await fetch('/api/resource').then(x => x.json()), rows = Object.entries(r);
    $('resTable').querySelector('tbody').innerHTML = rows.length
      ? rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td class="token">#${v.maxToken}</td><td>${esc(v.writer)}</td><td>${esc(v.value)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">Nothing written yet.</td></tr>';
  } catch {}
  setTimeout(pollResource, 700);
}

// ----- reset + guided walkthrough -----
async function resetSim() {
  toast('Resetting the simulation…');
  await post('/api/reset', {});
  $('token').value = ''; $('owner').value = 'client-A'; $('key').value = 'orders-db'; $('ttl').value = 8000;
  $('result').className = 'result'; $('result').textContent = 'The answer to your last request appears here.';
  $('rresult').className = 'result'; $('rresult').textContent = '—';
  $('fenceSteps').innerHTML = '';
  setTimeout(() => toast('Simulation reset: a fresh cluster is starting.'), 900);
}
window.resetSim = resetSim;
$('resetAll').onclick = resetSim;
$('w-reset').onclick = resetSim;

function flash(id) {
  const c = $(id); if (!c) return;
  c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  c.classList.add('focus'); setTimeout(() => c.classList.remove('focus'), 2600);
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => flash('card-' + b.dataset.go));
$('w-acq').onclick = async () => { $('key').value = 'orders-db'; $('owner').value = 'client-A'; $('ttl').value = 8000; flash('card-lock'); await sleep(500); $('acq').click(); };
$('w-other').onclick = async () => { const prev = $('owner').value; flash('card-lock'); await sleep(500); $('owner').value = 'client-B'; $('acq').click(); await sleep(900); $('owner').value = prev; };
$('w-crash').onclick = () => { flash('card-cluster'); crashLeader(); };
$('w-iso').onclick = () => { flash('card-cluster'); isolate(); };
$('w-heal').onclick = () => { flash('card-cluster'); $('healBtn').click(); };
$('w-fence').onclick = async () => { flash('card-fence'); await sleep(500); $('fenceDemo').click(); };
try { if (localStorage.getItem('dash.guide') === 'closed') $('guide').open = false; } catch {}
$('guide').addEventListener('toggle', () => { try { localStorage.setItem('dash.guide', $('guide').open ? 'open' : 'closed'); } catch {} });

pollResource();
poll();
