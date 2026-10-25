// Shared lab engine: tab shell, quiz engine, simulation lab panel. An experiment file sets window.EXP.
const $ = (s, r = document) => r.querySelector(s);
const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstChild; };
const api = (url, body) => fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const store = {
  get(k, d) { try { const v = localStorage.getItem('vlab.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vlab.' + k, JSON.stringify(v)); } catch {} },
};
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------------- quiz engine ----------------
// q = { level: 'Beginner'|'Intermediate'|'Advanced', q, opts[4], ans, ex[4] }
function renderQuiz(host, bank, key, onScore) {
  // stable per-question shuffle so the correct answer is not always in the same position
  bank = bank.map((q, qi) => {
    let seed = (qi + 1) * 7919; // mulberry32
    const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    return { ...q, opts: order.map(i => q.opts[i]), ex: order.map(i => q.ex[i]), ans: order.indexOf(q.ans) };
  });
  const levels = ['All', 'Beginner', 'Intermediate', 'Advanced'];
  host.innerHTML = '';
  const bar = el(`<div class="row"><label>Difficulty&nbsp;<select>${levels.map(l => `<option>${l}</option>`).join('')}</select></label>
    <span class="crumb" id="cnt"></span></div>`);
  const list = el('<div></div>'), result = el('<div></div>');
  const submit = el('<button class="primary">Submit Quiz</button>');
  const prev = store.get(key);
  host.append(bar, list, submit, result);
  const sel = $('select', bar);
  let shown = [];

  function draw() {
    shown = bank.filter(q => sel.value === 'All' || q.level === sel.value);
    $('#cnt', bar).textContent = `${shown.length} questions`;
    result.innerHTML = ''; submit.disabled = false;
    list.innerHTML = '';
    shown.forEach((q, i) => {
      const box = el(`<div class="q"><span class="lvl">${q.level}</span><b>${i + 1}. ${esc(q.q)}</b></div>`);
      q.opts.forEach((o, j) => {
        const row = el(`<div class="opt"><label><input type="radio" name="q${i}" value="${j}"> ${esc(o)}</label><button class="xl" type="button">Explanation</button><div class="ex">${esc(q.ex[j])}</div></div>`);
        $('.xl', row).onclick = () => $('.ex', row).classList.toggle('show');
        box.append(row);
      });
      list.append(box);
    });
  }
  sel.onchange = draw;
  submit.onclick = () => {
    let score = 0;
    [...list.children].forEach((box, i) => {
      const q = shown[i], pick = box.querySelector('input:checked');
      const ok = pick && +pick.value === q.ans;
      if (ok) score++;
      box.classList.add(ok ? 'right' : 'wrong');
      box.querySelectorAll('.opt').forEach((row, j) => {
        if (j === q.ans) row.classList.add('correct');
        else if (pick && +pick.value === j) row.classList.add('bad');
        $('.ex', row).classList.toggle('show', j === q.ans || (pick && +pick.value === j));
      });
      box.querySelectorAll('input').forEach(x => x.disabled = true);
    });
    submit.disabled = true;
    const pct = Math.round(score / shown.length * 100);
    result.innerHTML = `<div class="score">Score: ${score} / ${shown.length} (${pct}%)</div>`;
    store.set(key, { score, total: shown.length, pct, level: sel.value, at: Date.now() });
    if (onScore) onScore(result, { score, total: shown.length, pct });
    result.append(el('<button>Retry</button>'));
    result.lastChild.onclick = draw;
  };
  draw();
  if (prev) bar.append(el(`<span class="crumb">Last attempt: ${prev.score}/${prev.total} (${prev.level})</span>`));
}

// ---------------- tab shell ----------------
function buildExperiment(EXP) {
  document.title = EXP.title + ' - Distributed Lock Service Virtual Lab';
  $('#expTitle').textContent = EXP.title;
  $('#crumb').textContent = 'Computer Science and Engineering > Fault-Tolerant Distributed Lock Service > ' + EXP.title;
  const names = ['Aim', 'Theory', 'Pretest', 'Procedure', 'Simulation', 'Posttest', 'References', 'Feedback'];
  const tabs = $('#tabs'), panes = $('#panes');
  const sims = {};
  names.forEach(n => {
    const b = el(`<button class="tab" data-t="${n}">${n}</button>`);
    const p = el(`<section class="pane" id="p-${n}"></section>`);
    tabs.append(b); panes.append(p);
    b.onclick = () => show(n);
  });
  function show(n) {
    tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.t === n));
    panes.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'p-' + n));
    store.set(EXP.id + '.tab', n);
    if (n === 'Simulation') startSim(); else stopSim();
    history.replaceState(null, '', '#' + n);
  }
  $('#p-Aim').innerHTML = `<div class="prose">${EXP.aim}</div>`;
  $('#p-Theory').innerHTML = `<div class="prose">${EXP.theory}</div>`;
  $('#p-Procedure').innerHTML = `<div class="prose"><p>Open the <b>Simulation</b> tab and follow these steps. The lab panel checks each step automatically.</p><ol>${EXP.steps.map(s => `<li><b>${esc(s.title)}</b> - ${s.text}</li>`).join('')}</ol>${EXP.procedureExtra || ''}</div>`;
  $('#p-Pretest').innerHTML = '<div class="prose"><p>Check what you already know. Your score is saved so you can compare it with the Posttest.</p></div><div id="preq"></div>';
  renderQuiz($('#preq'), EXP.pretest, EXP.id + '.pre');
  $('#p-Posttest').innerHTML = '<div class="prose"><p>Take this after completing the simulation.</p></div><div id="postq"></div>';
  renderQuiz($('#postq'), EXP.posttest, EXP.id + '.post', (res, s) => {
    const pre = store.get(EXP.id + '.pre');
    if (pre) res.append(el(`<div class="box tip">Pretest: ${pre.pct}% &rarr; Posttest: ${s.pct}% (${s.pct - pre.pct >= 0 ? '+' : ''}${s.pct - pre.pct} points)</div>`));
    else res.append(el('<div class="box">Take the Pretest too, so you can compare your scores.</div>'));
  });
  $('#p-References').innerHTML = `<div class="prose"><ul>${EXP.refs.map(r => `<li>${r}</li>`).join('')}</ul><p class="crumb">Licence: CC BY-NC-SA 4.0</p></div>`;
  buildFeedback($('#p-Feedback'), EXP);
  buildSim($('#p-Simulation'), EXP);

  // ---- simulation lab panel ----
  function buildSim(pane, EXP) {
    pane.innerHTML = `<div class="sim"><iframe id="dash" title="Lock service dashboard"></iframe>
      <aside class="panel">
        <h3>Lab panel</h3>
        <ul class="steps" id="stepList"></ul>
        <div class="cur-step" id="curStep"></div>
        <h3>Your observations</h3>
        <textarea id="obs" placeholder="Write what you predicted and what actually happened..."></textarea>
        ${EXP.tools ? `<h3>Extra tools</h3><div id="tools"></div>` : ''}
        <h3>Protocol settings</h3>
        <div id="toggles"></div>
        <div class="row"><button class="warn" id="reset">Reset cluster</button><button id="restartLab">Restart experiment</button></div>
        <div class="live" id="live">connecting...</div>
      </aside></div>`;
  }
  let timer = null, cluster = null, cur = 0, done = store.get(EXP.id + '.done', []), base = {};
  function startSim() {
    const f = $('#dash');
    if (!f.src) f.src = '/?embed=1';
    $('#obs').value = store.get(EXP.id + '.obs', '');
    $('#obs').oninput = e => store.set(EXP.id + '.obs', e.target.value);
    $('#reset').onclick = async () => { $('#reset').disabled = true; await api('/api/reset', {}); base = {}; setTimeout(() => { $('#reset').disabled = false; renderToggles(); }, 1500); };
    $('#restartLab').onclick = () => { done = []; store.set(EXP.id + '.done', done); cur = 0; base = {}; drawSteps(); };
    if (EXP.tools && !$('#tools').children.length) {
      EXP.tools.forEach(t => {
        const row = el(`<div class="tog"><span>${t.label}</span><span><select>${[1, 2, 3, 4, 5].map(n => `<option value="${n}">N${n}</option>`).join('')}</select> <button class="warn">${t.button}</button></span></div>`);
        $('button', row).onclick = () => api(t.url, { id: +$('select', row).value });
        $('#tools').append(row);
      });
    }
    renderToggles(); drawSteps();
    if (!timer) timer = setInterval(tick, 500);
    tick();
  }
  function stopSim() { clearInterval(timer); timer = null; }
  async function renderToggles() {
    const c = await api('/api/config');
    const t = $('#toggles');
    const sw = (id, label, on) => `<div class="tog"><span>${label}</span><button data-k="${id}" class="${on ? 'good' : 'warn'}">${on ? 'ON' : 'OFF'}</button></div>`;
    t.innerHTML = sw('prevote', 'PreVote', c.prevote) + sw('checkQuorum', 'Leader check-quorum', c.checkQuorum) + sw('fencing', 'Fencing check at resource', c.fencing) +
      `<div class="tog"><span>Election timeout</span><select id="et">
        <option value="600-1100">600-1100 ms (default)</option><option value="1500-2500">1500-2500 ms (slow)</option>
        <option value="50-100">50-100 ms (shorter than heartbeat)</option></select></div>`;
    $('#et').value = `${c.electionMin}-${c.electionMax}`;
    $('#et').onchange = async e => { const [a, b] = e.target.value.split('-').map(Number); await api('/api/config', { electionMin: a, electionMax: b }); };
    t.querySelectorAll('button[data-k]').forEach(b => b.onclick = async () => { await api('/api/config', { [b.dataset.k]: b.textContent !== 'ON' }); renderToggles(); });
  }
  function drawSteps() {
    $('#stepList').innerHTML = EXP.steps.map((s, i) => `<li class="${done.includes(i) ? 'done' : ''} ${i === cur ? 'cur' : ''}" data-i="${i}"><span class="ic">${done.includes(i) ? '&#10003;' : i + 1}</span><span>${esc(s.title)}</span></li>`).join('');
    $('#stepList').querySelectorAll('li').forEach(li => li.onclick = () => { cur = +li.dataset.i; base = {}; drawSteps(); });
    const s = EXP.steps[cur];
    const all = done.length === EXP.steps.length;
    $('#curStep').innerHTML = all
      ? '<b>All steps complete.</b><p>Write up your observations, then take the Posttest.</p>'
      : `<b>Step ${cur + 1}: ${esc(s.title)}</b><p>${s.text}</p><div class="predict">Predict first: ${s.predict}</div><div class="chk no" id="chk">Waiting for you to do this step...</div>${s.confirm ? '<button id="ackBtn">I have noted this</button>' : ''}`;
    if (s.confirm && $('#ackBtn')) $('#ackBtn').onclick = () => { base.ack = true; $('#ackBtn').remove(); tick(); };
  }
  async function tick() {
    try {
      cluster = await api('/api/cluster');
      cluster.locks = await api('/api/locks'); cluster.resource = await api('/api/resource'); cluster.config = await api('/api/config');
      const up = cluster.nodes.filter(n => n.up).length;
      $('#live').textContent = cluster.leader ? `Live: leader N${cluster.leader}, term ${Math.max(0, ...cluster.nodes.filter(n => n.up).map(n => n.term))}, ${up}/${cluster.n} up` : `Live: no leader, ${up}/${cluster.n} up`;
      if (done.length === EXP.steps.length) return;
      const s = EXP.steps[cur];
      if (!base.set) { base = { ...base, set: true, ...(s.baseline ? s.baseline(cluster) : {}) }; }
      if (base.locked) return;
      if (s.check(cluster, base) && (!s.confirm || base.ack)) {
        if (!done.includes(cur)) done.push(cur);
        store.set(EXP.id + '.done', done);
        const next = EXP.steps.findIndex((_, i) => !done.includes(i));
        const c = $('#chk');
        if (c) {
          c.className = 'chk ok'; c.textContent = 'Step complete: ' + s.ok + ' ';
          // never auto-advance: the learner reads the result, then moves on when ready
          const b = el(`<button class="primary" id="nextStep">${next >= 0 ? 'Next step &rarr;' : 'Finish'}</button>`);
          b.onclick = () => { if (next >= 0) { cur = next; base = {}; } drawSteps(); };
          c.append(document.createElement('br'), b);
        }
        base.locked = true;
      } else if (s.confirm && s.check(cluster, base)) {
        const c = $('#chk'); if (c) c.textContent = 'Observe the cluster, then press "I have noted this" to continue.';
      } else if (s.hint) {
        const c = $('#chk'); if (c && !c.classList.contains('ok')) c.textContent = s.hint(cluster, base) || 'Waiting for you to do this step...';
      }
    } catch { $('#live').textContent = 'gateway unreachable'; }
  }
  show(location.hash.slice(1) && names.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'Aim');
  window.__show = show;
}

// ---------------- feedback ----------------
function buildFeedback(pane, EXP) {
  let rating = 0;
  pane.innerHTML = `<div class="prose"><p>Tell us how this experiment worked for you.</p>
    <div class="rate">${[1, 2, 3, 4, 5].map(n => `<button data-n="${n}">${n}</button>`).join('')}</div>
    <textarea id="fbtext" placeholder="What was clear? What was confusing?"></textarea>
    <p><button class="primary" id="fbsend">Submit feedback</button> <span id="fbmsg" class="crumb"></span></p></div>`;
  pane.querySelectorAll('.rate button').forEach(b => b.onclick = () => { rating = +b.dataset.n; pane.querySelectorAll('.rate button').forEach(x => x.classList.toggle('sel', +x.dataset.n <= rating)); });
  $('#fbsend', pane).onclick = async () => {
    if (!rating) { $('#fbmsg', pane).textContent = 'Please pick a rating (1-5).'; return; }
    try { await api('/api/feedback', { exp: EXP.id, rating, text: $('#fbtext', pane).value }); $('#fbmsg', pane).textContent = 'Thank you! Feedback saved in this browser.'; }
    catch { $('#fbmsg', pane).textContent = 'Could not reach the server.'; }
  };
}

// ---------------- helpers for step checks ----------------
window.H = {
  up: c => c.nodes.filter(n => n.up),
  upCount: c => c.nodes.filter(n => n.up).length,
  maxTerm: c => Math.max(0, ...c.nodes.filter(n => n.up).map(n => n.term)),
  node: (c, id) => c.nodes.find(n => n.id === id),
  fence: c => Math.max(0, ...c.nodes.filter(n => n.up).map(n => n.fence)),
  // every running node has the same log and has committed all of it
  inSync: c => { const u = c.nodes.filter(n => n.up); return u.length > 0 && u.every(n => n.logLength === u[0].logLength && n.commitIndex === n.logLength && n.lastApplied === n.logLength); },
  leaders: c => c.nodes.filter(n => n.up && n.role === 'leader'),
  client: (c, re, since) => (c.clientEvents || []).filter(e => e.ts >= (since || 0) && re.test(e.msg)),
};
