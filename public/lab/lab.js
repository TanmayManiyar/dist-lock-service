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
  const bar = el('<div class="chips" role="group" aria-label="Difficulty"></div>');
  const chips = levels.map(l => { const b = el(`<button type="button" class="chip-btn" data-l="${l}">${l}</button>`); bar.append(b); return b; });
  const cnt = el('<span class="crumb" id="cnt"></span>'); bar.append(cnt);
  const list = el('<div></div>'), result = el('<div></div>');
  const submit = el('<button class="primary">Submit quiz</button>');
  const count = el('<span class="count"></span>');
  const qbar = el('<div class="qbar"></div>'); qbar.append(submit, count);
  const prev = store.get(key);
  host.append(bar, list, qbar, result);
  let level = 'All', shown = [], submitted = false;
  const value = () => level;

  function updateCount() {
    const n = list.querySelectorAll('input:checked').length;
    count.textContent = submitted ? '' : `${n} of ${shown.length} answered`;
  }
  function draw() {
    shown = bank.filter(q => level === 'All' || q.level === level);
    chips.forEach(c => { const on = c.dataset.l === level; c.classList.toggle('on', on); c.setAttribute('aria-pressed', on); });
    cnt.textContent = `${shown.length} questions`;
    result.innerHTML = ''; submit.disabled = false; submitted = false;
    list.innerHTML = '';
    shown.forEach((q, i) => {
      const box = el(`<div class="q"><div class="qh"><span class="qn">${i + 1}</span><span class="qt">${esc(q.q)}</span><span class="lvl">${q.level}</span></div></div>`);
      q.opts.forEach((o, j) => {
        const row = el(`<div class="opt"><label><input type="radio" name="q${i}" value="${j}"><span>${esc(o)}</span></label><button class="xl" type="button">Why?</button><div class="ex">${esc(q.ex[j])}</div></div>`);
        $('.xl', row).onclick = () => $('.ex', row).classList.toggle('show');
        $('input', row).onchange = updateCount;
        box.append(row);
      });
      list.append(box);
    });
    updateCount();
  }
  chips.forEach(c => c.onclick = () => { level = c.dataset.l; draw(); });
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
    submit.disabled = true; submitted = true; updateCount();
    const pct = Math.round(score / shown.length * 100);
    const tone = pct >= 70 ? 'pass' : pct >= 40 ? 'mid' : 'low';
    result.innerHTML = '';
    const card = el(`<div class="scorecard ${tone}" role="status"><div class="big">${pct}%</div><div><b>${score} of ${shown.length} correct</b><div class="crumb">${tone === 'pass' ? 'Well done.' : 'Open "Why?" under each question to see the explanation.'}</div></div></div>`);
    result.append(card);
    store.set(key, { score, total: shown.length, pct, level: value(), at: Date.now() });
    if (onScore) onScore(result, { score, total: shown.length, pct });
    const retry = el('<button type="button">Try again</button>'); retry.onclick = () => { draw(); host.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    result.append(retry);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.dispatchEvent(new Event('vlab:progress'));
  };
  draw();
  if (prev) cnt.textContent += ` · last attempt ${prev.score}/${prev.total} (${prev.pct}%)`;
}

// ---------------- tab shell ----------------
function buildExperiment(EXP) {
  document.title = EXP.title + ' - Distributed Lock Service Virtual Lab';
  const m = EXP.title.match(/^(Experiment \d+):\s*(.*)$/);
  $('#expNum').textContent = m ? m[1] : 'Experiment';
  $('#expTitle').textContent = m ? m[2] : EXP.title;
  $('#crumb').textContent = 'Computer Science and Engineering > Fault-Tolerant Distributed Lock Service > ' + EXP.title;
  const names = ['Aim', 'Theory', 'Pretest', 'Procedure', 'Simulation', 'Posttest', 'References', 'Feedback'];
  const tabs = $('#tabs'), panes = $('#panes');
  tabs.setAttribute('role', 'tablist');
  names.forEach((n, i) => {
    const b = el(`<button class="tab" role="tab" data-t="${n}"><span class="num">${i + 1}</span><span class="t">${n}</span></button>`);
    const p = el(`<section class="pane" id="p-${n}" role="tabpanel" aria-label="${n}"></section>`);
    tabs.append(b); panes.append(p);
    b.onclick = () => { show(n); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  });
  function marks() {
    const doneAll = (store.get(EXP.id + '.done', []).length === EXP.steps.length);
    const flags = { Pretest: !!store.get(EXP.id + '.pre'), Simulation: doneAll, Posttest: !!store.get(EXP.id + '.post') };
    tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('done', !!flags[t.dataset.t]));
  }
  window.addEventListener('vlab:progress', marks);
  function show(n) {
    tabs.querySelectorAll('.tab').forEach(t => { const on = t.dataset.t === n; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
    panes.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'p-' + n));
    store.set(EXP.id + '.tab', n);
    if (n === 'Simulation') startSim(); else stopSim();
    history.replaceState(null, '', '#' + n);
    marks();
  }
  $('#p-Aim').innerHTML = `<div class="prose">${EXP.aim}</div>`;
  $('#p-Theory').innerHTML = `<div class="prose">${EXP.theory}</div>`;
  $('#p-Procedure').innerHTML = `<div class="prose"><p>Open the <b>Simulation</b> tab and follow these steps. The lab panel checks each step automatically as you work.</p><ol>${EXP.steps.map(s => `<li><b>${esc(s.title)}</b> - ${s.text}</li>`).join('')}</ol>${EXP.procedureExtra || ''}</div>`;
  $('#p-Pretest').innerHTML = '<div class="prose"><p>Check what you already know. Your score is saved so you can compare it with the Posttest.</p></div><div id="preq"></div>';
  renderQuiz($('#preq'), EXP.pretest, EXP.id + '.pre');
  $('#p-Posttest').innerHTML = '<div class="prose"><p>Take this after completing the simulation.</p></div><div id="postq"></div>';
  renderQuiz($('#postq'), EXP.posttest, EXP.id + '.post', (res, s) => {
    const pre = store.get(EXP.id + '.pre');
    if (pre) res.append(el(`<div class="box tip" style="max-width:860px"><b class="t">Your progress</b>Pretest ${pre.pct}% &rarr; Posttest ${s.pct}% (${s.pct - pre.pct >= 0 ? '+' : ''}${s.pct - pre.pct} points)</div>`));
    else res.append(el('<div class="box" style="max-width:860px">Take the Pretest too, so you can compare your scores.</div>'));
  });
  $('#p-References').innerHTML = `<div class="prose"><ul>${EXP.refs.map(r => `<li>${r}</li>`).join('')}</ul><p class="crumb">Licence: CC BY-NC-SA 4.0</p></div>`;
  buildFeedback($('#p-Feedback'), EXP);
  buildSim($('#p-Simulation'), EXP);
  // previous / next navigation at the bottom of every tab
  names.forEach((n, i) => {
    const pg = el('<div class="pager"></div>');
    pg.append(i > 0 ? el(`<button type="button">&larr; ${names[i - 1]}</button>`) : el('<span></span>'));
    pg.append(i < names.length - 1 ? el(`<button type="button" class="primary">${names[i + 1]} &rarr;</button>`) : el('<a class="btn-link primary" href="/lab/">All experiments</a>'));
    const [bp, bn] = pg.children;
    if (bp.tagName === 'BUTTON') bp.onclick = () => { show(names[i - 1]); window.scrollTo({ top: 0 }); };
    if (bn.tagName === 'BUTTON') bn.onclick = () => { show(names[i + 1]); window.scrollTo({ top: 0 }); };
    $('#p-' + n).append(pg);
  });

  // ---- simulation lab panel ----
  function buildSim(pane, EXP) {
    pane.innerHTML = `<div class="sim"><div class="sim-main"><iframe id="dash" title="Lock service dashboard" scrolling="no"></iframe></div>
      <aside class="panel" aria-label="Lab panel">
        <div class="panel-h"><div><div class="eyebrow">Lab panel</div><div class="prog-text" id="progText"></div></div><div class="live" id="live">connecting...</div></div>
        <div class="prog"><i id="progBar"></i></div>
        <div class="cur-step" id="curStep"></div>
        <details class="fold"><summary>All steps</summary><ul class="steps" id="stepList"></ul></details>
        <details class="fold" id="foldObs"><summary>Your observations</summary><textarea id="obs" placeholder="Write what you predicted and what actually happened..."></textarea></details>
        ${EXP.tools ? '<details class="fold" id="foldTools"><summary>Extra tools</summary><div id="tools"></div></details>' : ''}
        <details class="fold" id="foldSet"><summary>Protocol settings</summary><div id="toggles"></div></details>
        <div class="row"><button class="warn" id="reset" title="Wipe all nodes and start from a clean cluster">Reset cluster</button><button id="restartLab" title="Mark all steps as not done">Restart experiment</button></div>
      </aside></div>`;
  }
  let timer = null, cluster = null, cur = 0, done = store.get(EXP.id + '.done', []), base = {}, ro = null;
  function startSim() {
    const f = $('#dash');
    if (!f.src) {
      f.onload = () => { // size the embedded dashboard to its content so the page has one scrollbar, not two
        try {
          const d = f.contentDocument, fit = () => { f.style.height = Math.max(640, d.documentElement.scrollHeight) + 'px'; };
          fit(); if (ro) ro.disconnect(); ro = new ResizeObserver(fit); ro.observe(d.body);
        } catch {}
      };
      f.src = '/?embed=1';
    }
    $('#obs').value = store.get(EXP.id + '.obs', '');
    $('#obs').oninput = e => store.set(EXP.id + '.obs', e.target.value);
    $('#reset').onclick = async () => { $('#reset').disabled = true; await api('/api/reset', {}); base = {}; setTimeout(() => { $('#reset').disabled = false; renderToggles(); }, 1500); };
    $('#restartLab').onclick = () => { done = []; store.set(EXP.id + '.done', done); cur = 0; base = {}; drawSteps(); window.dispatchEvent(new Event('vlab:progress')); };
    if (EXP.tools && !$('#tools').children.length) {
      EXP.tools.forEach(t => {
        const row = el(`<div class="tog"><span>${t.label}</span><span><select aria-label="Node">${[1, 2, 3, 4, 5].map(n => `<option value="${n}">N${n}</option>`).join('')}</select> <button class="warn sm">${t.button}</button></span></div>`);
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
    const sw = (id, label, on) => `<div class="tog"><span>${label}</span><button data-k="${id}" class="sm ${on ? 'good' : 'warn'}" aria-pressed="${on}">${on ? 'ON' : 'OFF'}</button></div>`;
    t.innerHTML = sw('prevote', 'PreVote', c.prevote) + sw('checkQuorum', 'Leader check-quorum', c.checkQuorum) + sw('fencing', 'Fencing check at resource', c.fencing) +
      `<div class="tog"><span>Election timeout</span><select id="et" aria-label="Election timeout">
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
    $('#progText').textContent = all ? 'All steps complete' : `Step ${cur + 1} of ${EXP.steps.length}`;
    $('#progBar').style.width = Math.round(done.length / EXP.steps.length * 100) + '%';
    const cs = $('#curStep'); cs.classList.toggle('done', all);
    cs.innerHTML = all
      ? '<div class="st">&#10003; All steps complete</div><p>Write up your observations, then take the Posttest.</p><button class="primary" id="toPost">Go to the Posttest &rarr;</button>'
      : `<div class="st">${esc(s.title)}</div><p>${s.text}</p><div class="predict"><b>Predict first:</b> ${s.predict}</div><div class="chk no" id="chk">Waiting for you to do this step...</div>`;
    if (all) $('#toPost').onclick = () => { show('Posttest'); window.scrollTo({ top: 0 }); };
    // open the folds a step refers to, so the control is in view
    if (!all) {
      const t = s.text;
      if (/Protocol settings/.test(t)) $('#foldSet').open = true;
      if (/Extra tools/.test(t) && $('#foldTools')) $('#foldTools').open = true;
    }
    window.dispatchEvent(new Event('vlab:progress'));
  }
  async function tick() {
    try {
      cluster = await api('/api/cluster');
      cluster.locks = await api('/api/locks'); cluster.resource = await api('/api/resource'); cluster.config = await api('/api/config');
      const up = cluster.nodes.filter(n => n.up).length;
      $('#live').textContent = cluster.leader ? `leader N${cluster.leader} · term ${Math.max(0, ...cluster.nodes.filter(n => n.up).map(n => n.term))} · ${up}/${cluster.n} up` : `no leader · ${up}/${cluster.n} up`;
      if (done.length === EXP.steps.length) return;
      const s = EXP.steps[cur];
      if (!base.set) { base = { set: true, ...(s.baseline ? s.baseline(cluster) : {}) }; }
      if (base.locked) return;
      if (s.check(cluster, base)) {
        if (!done.includes(cur)) done.push(cur);
        store.set(EXP.id + '.done', done);
        const c = $('#chk'); if (c) { c.className = 'chk ok'; c.textContent = 'Step complete: ' + s.ok; $('#curStep').classList.add('done'); }
        $('#progBar').style.width = Math.round(done.length / EXP.steps.length * 100) + '%';
        const next = EXP.steps.findIndex((_, i) => !done.includes(i));
        // take the next step's baseline now, so anything the learner does during the pause still counts
        const nb = next >= 0 ? { set: true, ...(EXP.steps[next].baseline ? EXP.steps[next].baseline(cluster) : {}) } : {};
        setTimeout(() => { if (next >= 0) { cur = next; base = nb; } drawSteps(); }, 1800);
        base.locked = true;
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
    <div class="rate" role="group" aria-label="Rating from 1 to 5">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" aria-label="${n} out of 5">${n}</button>`).join('')}</div>
    <textarea id="fbtext" placeholder="What was clear? What was confusing?"></textarea>
    <p><button class="primary" id="fbsend">Submit feedback</button> <span id="fbmsg" class="crumb" role="status"></span></p></div>`;
  pane.querySelectorAll('.rate button').forEach(b => b.onclick = () => { rating = +b.dataset.n; pane.querySelectorAll('.rate button').forEach(x => x.classList.toggle('sel', +x.dataset.n <= rating)); });
  $('#fbsend', pane).onclick = async () => {
    if (!rating) { $('#fbmsg', pane).textContent = 'Please pick a rating (1-5).'; return; }
    try { await api('/api/feedback', { exp: EXP.id, rating, text: $('#fbtext', pane).value }); $('#fbmsg', pane).textContent = 'Thank you! Feedback saved.'; }
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
