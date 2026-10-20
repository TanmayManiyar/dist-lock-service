// In-browser simulation of the lock service: five Raft replicas + gateway, no server needed.
// Same algorithm as node.js (PreVote, check-quorum, WAL semantics, fencing counter), but the "network" is
// in-memory message passing with a few ms of latency, and each replica's "disk" is a JS object that survives
// crashes (and is dropped by "wipe"). Exposes window.__SIM and routes fetch('/api/...') to it.
(function () {
  const shim = sim => {
    const orig = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      const u = typeof url === 'string' ? url : url.url;
      if (!u.startsWith('/api/')) return orig(url, opts);
      let body = {};
      try { body = opts && opts.body ? JSON.parse(opts.body) : {}; } catch {}
      return sim.handle(u.split('?')[0], body).then(r => new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
  };
  // embedded dashboard (iframe) shares the parent page's cluster
  try { if (window.parent !== window && window.parent.__SIM) { window.__SIM = window.parent.__SIM; shim(window.__SIM); return; } } catch {}

  const N = 5, MAJORITY = 3, HEARTBEAT_MS = 120, QUORUM_LOSS_MS = 1500;
  const DEFAULT_CONFIG = { prevote: true, checkQuorum: true, electionMin: 600, electionMax: 1100, fencing: true };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  class Node {
    constructor(id, sim) {
      this.id = id; this.sim = sim;
      this.peers = [...Array(N).keys()].map(i => i + 1).filter(i => i !== id);
      this.disk = { term: 0, votedFor: null, log: [{ term: 0 }] };   // survives crash
      this.cfg = { prevote: true, checkQuorum: true, electionMin: 600, electionMax: 1100 };
      this.events = []; this.blocked = new Set(); this.crashed = false;
      this.boot('started');
      setInterval(() => this.tick(), HEARTBEAT_MS);
      setInterval(() => this.sweepTick(), 300);
    }
    get st() { return this.disk; }
    persist() { /* the disk object is the durable state; mutating it is the write */ }
    ev(msg) { this.events.push({ ts: Date.now(), node: this.id, msg }); if (this.events.length > 60) this.events.shift(); }
    resetElectionTimer() { this.electionDeadline = Date.now() + this.cfg.electionMin + Math.random() * (this.cfg.electionMax - this.cfg.electionMin); }
    lastIndex() { return this.st.log.length - 1; }
    lastTerm() { return this.st.log[this.lastIndex()].term; }
    upToDate(i, t) { return t > this.lastTerm() || (t === this.lastTerm() && i >= this.lastIndex()); }

    boot(why) {
      this.role = 'follower'; this.leaderId = null; this.commitIndex = 0; this.lastApplied = 0;
      this.nextIndex = {}; this.matchIndex = {}; this.lastAck = {}; this.inflight = {};
      this.lastLeaderContact = 0; this.sm = { locks: {}, fence: 0 }; this.pending = new Map();
      this.blocked = new Set(); this.startedAt = Date.now(); this.crashed = false; this.electing = false;
      this.resetElectionTimer();
      this.ev(`${why} (term ${this.st.term}, log ${this.lastIndex()})`);
    }
    crash() {
      if (this.crashed) return;
      this.crashed = true; this.role = 'follower'; this.leaderId = null;
      for (const [, p] of this.pending) p.res({ ok: false, error: 'leadership-lost' });
      this.pending.clear();
    }
    wipe() { this.crash(); this.disk = { term: 0, votedFor: null, log: [{ term: 0 }] }; this.boot('restarted with a wiped disk'); }

    // ---- lock state machine (deterministic: time comes from the command) ----
    applyCmd(cmd) {
      const sm = this.sm;
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
          if (!l || l.owner !== cmd.owner || l.token !== cmd.token || l.expiresAt <= cmd.now) return { ok: false, error: 'not-holder' };
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
    applyCommitted() {
      while (this.lastApplied < this.commitIndex) {
        this.lastApplied++;
        const entry = this.st.log[this.lastApplied];
        const result = this.applyCmd(entry.cmd || { type: 'noop' });
        const p = this.pending.get(this.lastApplied);
        if (p) { this.pending.delete(this.lastApplied); p.res(p.term === entry.term ? result : { ok: false, error: 'leadership-lost' }); }
      }
    }

    // ---- role transitions ----
    stepDown(term, why) {
      const wasLeader = this.role === 'leader';
      if (term > this.st.term) { this.st.term = term; this.st.votedFor = null; }
      if (this.role !== 'follower') this.ev(`stepped down to follower (term ${this.st.term})${why ? ' - ' + why : ''}`);
      this.role = 'follower';
      if (wasLeader) { for (const [, p] of this.pending) p.res({ ok: false, error: 'leadership-lost' }); this.pending.clear(); }
      this.resetElectionTimer();
    }
    becomeLeader() {
      this.role = 'leader'; this.leaderId = this.id;
      this.nextIndex = {}; this.matchIndex = {}; this.lastAck = {};
      for (const p of this.peers) { this.nextIndex[p] = this.lastIndex() + 1; this.matchIndex[p] = 0; this.lastAck[p] = Date.now(); }
      this.st.log.push({ term: this.st.term, cmd: { type: 'noop' } });
      this.ev(`became LEADER for term ${this.st.term}`);
      this.broadcast();
    }

    // ---- RPC (simulated network) ----
    async rpc(to, route, body) {
      const peer = this.sim.nodes[to - 1];
      if (this.crashed || this.blocked.has(to)) return null;
      await sleep(2 + Math.random() * 6);
      if (this.crashed || peer.crashed || peer.blocked.has(this.id) || this.blocked.has(to)) return null;
      const reply = peer.handleRaft(route, { ...JSON.parse(JSON.stringify(body)), from: this.id });
      await sleep(2 + Math.random() * 6);
      return this.crashed ? null : JSON.parse(JSON.stringify(reply));
    }
    handleRaft(route, b) {
      if (route === '/raft/prevote') {
        const recent = Date.now() - this.lastLeaderContact < this.cfg.electionMin;
        return { term: this.st.term, granted: this.role !== 'leader' && !recent && b.term > this.st.term && this.upToDate(b.lastLogIndex, b.lastLogTerm) };
      }
      if (route === '/raft/vote') {
        if (b.term > this.st.term) this.stepDown(b.term);
        let grant = false;
        if (b.term === this.st.term && (this.st.votedFor === null || this.st.votedFor === b.from) && this.upToDate(b.lastLogIndex, b.lastLogTerm)) {
          this.st.votedFor = b.from; grant = true; this.resetElectionTimer();
        }
        return { term: this.st.term, granted: grant };
      }
      // append
      if (b.term < this.st.term) return { term: this.st.term, success: false };
      if (b.term > this.st.term || this.role !== 'follower') this.stepDown(b.term);
      this.leaderId = b.from; this.lastLeaderContact = Date.now(); this.resetElectionTimer();
      if (b.prevLogIndex > this.lastIndex() || this.st.log[b.prevLogIndex].term !== b.prevLogTerm)
        return { term: this.st.term, success: false, hint: Math.min(b.prevLogIndex, this.st.log.length) };
      b.entries.forEach((e, i) => {
        const idx = b.prevLogIndex + 1 + i;
        if (idx <= this.lastIndex() && this.st.log[idx].term !== e.term) this.st.log.length = idx;
        if (idx > this.lastIndex()) this.st.log.push(e);
      });
      const match = b.prevLogIndex + b.entries.length;
      if (b.leaderCommit > this.commitIndex) { this.commitIndex = Math.min(b.leaderCommit, match); this.applyCommitted(); }
      return { term: this.st.term, success: true, match };
    }

    // ---- election ----
    async tryElection() {
      if (this.electing) return;
      this.electing = true; this.resetElectionTimer();
      try {
        const probe = { term: this.st.term + 1, lastLogIndex: this.lastIndex(), lastLogTerm: this.lastTerm() };
        if (this.cfg.prevote) {
          const pre = await Promise.all(this.peers.map(p => this.rpc(p, '/raft/prevote', probe)));
          if (this.role === 'leader' || this.crashed) return;
          if (1 + pre.filter(r => r && r.granted).length < MAJORITY) return;
        }
        this.st.term++; this.st.votedFor = this.id; this.role = 'candidate'; this.leaderId = null;
        const term = this.st.term;
        this.ev(`election started for term ${term}`);
        const req = { term, lastLogIndex: this.lastIndex(), lastLogTerm: this.lastTerm() };
        const res = await Promise.all(this.peers.map(p => this.rpc(p, '/raft/vote', req)));
        if (this.role !== 'candidate' || this.st.term !== term) return;
        const hi = Math.max(0, ...res.filter(Boolean).map(r => r.term));
        if (hi > term) return this.stepDown(hi);
        if (1 + res.filter(r => r && r.granted).length >= MAJORITY) this.becomeLeader();
      } finally { this.electing = false; }
    }

    // ---- replication ----
    advanceCommit() {
      for (let n = this.lastIndex(); n > this.commitIndex; n--) {
        if (this.st.log[n].term !== this.st.term) break;
        if (1 + this.peers.filter(p => this.matchIndex[p] >= n).length >= MAJORITY) { this.commitIndex = n; this.applyCommitted(); break; }
      }
    }
    async replicate(p) {
      if (this.inflight[p] || this.role !== 'leader') return;
      this.inflight[p] = true; let again = false;
      try {
        const term = this.st.term, ni = this.nextIndex[p], prev = ni - 1;
        const r = await this.rpc(p, '/raft/append', { term, prevLogIndex: prev, prevLogTerm: this.st.log[prev].term, entries: this.st.log.slice(ni, ni + 64), leaderCommit: this.commitIndex });
        if (!r || this.role !== 'leader' || this.st.term !== term) return;
        if (r.term > this.st.term) return this.stepDown(r.term);
        this.lastAck[p] = Date.now();
        if (r.success) { this.matchIndex[p] = Math.max(this.matchIndex[p], r.match); this.nextIndex[p] = this.matchIndex[p] + 1; this.advanceCommit(); again = this.nextIndex[p] <= this.lastIndex(); }
        else { this.nextIndex[p] = Math.max(1, Math.min(r.hint ?? ni - 1, ni - 1)); again = true; }
      } finally { this.inflight[p] = false; if (again && this.role === 'leader') setTimeout(() => this.replicate(p), 0); }
    }
    broadcast() { for (const p of this.peers) this.replicate(p); this.advanceCommit(); }
    hasQuorumLease() { return this.role === 'leader' && 1 + this.peers.filter(p => Date.now() - this.lastAck[p] < QUORUM_LOSS_MS).length >= MAJORITY; }
    propose(cmd) {
      return new Promise(res => {
        if (this.role !== 'leader') return res({ ok: false, error: 'not-leader', leader: this.leaderId });
        this.st.log.push({ term: this.st.term, cmd });
        const idx = this.lastIndex();
        this.pending.set(idx, { term: this.st.term, res });
        setTimeout(() => { if (this.pending.get(idx)) { this.pending.delete(idx); res({ ok: false, error: 'timeout' }); } }, 3000);
        this.broadcast();
      });
    }
    tick() {
      if (this.crashed) return;
      if (this.role === 'leader') {
        this.broadcast();
        if (this.cfg.checkQuorum && !this.hasQuorumLease()) this.stepDown(this.st.term, 'lost contact with majority (check-quorum)');
      } else if (Date.now() > this.electionDeadline) this.tryElection();
    }
    sweepTick() {
      if (this.crashed || this.role !== 'leader') return;
      const now = Date.now();
      if (Object.values(this.sm.locks).some(l => l.expiresAt <= now)) this.propose({ type: 'sweep', now });
    }

    // ---- client / admin API ----
    status() {
      return {
        id: this.id, role: this.role, term: this.st.term, leaderId: this.leaderId, commitIndex: this.commitIndex, lastApplied: this.lastApplied,
        logLength: this.lastIndex(), votedFor: this.st.votedFor, blocked: [...this.blocked], events: this.events.slice(), uptimeMs: Date.now() - this.startedAt,
        config: { ...this.cfg }, lockCount: Object.keys(this.sm.locks).length, fence: this.sm.fence,
      };
    }
    async client(op, body) {
      const ttlMs = Math.min(120000, Math.max(500, +body.ttlMs || 10000));
      const cmd = { type: op, key: String(body.key || ''), owner: String(body.owner || ''), token: body.token, ttlMs, now: Date.now() };
      if (!cmd.key || !cmd.owner) return { ok: false, error: 'bad-request' };
      const r = await this.propose(cmd);
      if (op !== 'release' && r.ok) this.ev(`${op} "${cmd.key}" by ${cmd.owner} -> token ${r.token}`);
      else if (op === 'release' && r.ok) this.ev(`release "${cmd.key}" by ${cmd.owner}`);
      return r;
    }
    locks() {
      if (!this.hasQuorumLease()) return { ok: false, error: 'not-leader', leader: this.leaderId };
      return { ok: true, locks: JSON.parse(JSON.stringify(this.sm.locks)), fence: this.sm.fence, now: Date.now() };
    }
    setConfig(c) {
      if (typeof c.prevote === 'boolean') this.cfg.prevote = c.prevote;
      if (typeof c.checkQuorum === 'boolean') this.cfg.checkQuorum = c.checkQuorum;
      if (c.electionMin >= 50 && c.electionMax > c.electionMin) { this.cfg.electionMin = c.electionMin; this.cfg.electionMax = c.electionMax; this.resetElectionTimer(); }
      this.ev(`config: prevote=${this.cfg.prevote} checkQuorum=${this.cfg.checkQuorum} election=${this.cfg.electionMin}-${this.cfg.electionMax}ms`);
    }
  }

  // ---- gateway ----
  class Sim {
    constructor() {
      this.config = { ...DEFAULT_CONFIG }; this.partition = null; this.resource = {}; this.actionLog = [];
      this.nodes = [...Array(N).keys()].map(i => new Node(i + 1, this));
      this.leaderCache = null;
    }
    log(msg) { this.actionLog.push({ ts: Date.now(), node: 'client', msg }); if (this.actionLog.length > 60) this.actionLog.shift(); }
    statuses() { return this.nodes.map(n => n.crashed ? { id: n.id, up: false } : { id: n.id, up: true, ...n.status() }); }
    leader(sts) { const l = sts.filter(s => s.up && s.role === 'leader').sort((a, b) => b.term - a.term); return l[0] ? l[0].id : null; }
    async viaLeader(op, body, retry) {
      let hint = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = hint || this.leaderCache || this.leader(this.statuses());
        hint = null; this.leaderCache = null;
        if (id) {
          const node = this.nodes[id - 1];
          const r = node.crashed ? null : op === 'locks' ? node.locks() : await node.client(op, body);
          if (r && r.error === 'not-leader') hint = r.leader || null;
          else if (r) {
            const stale = r.error === 'leadership-lost' || r.error === 'timeout';
            if (stale && retry && attempt < 4) continue;
            if (!stale) this.leaderCache = id;
            return { ...r, servedBy: id };
          }
        }
        await sleep(250);
      }
      return { ok: false, error: 'no-leader' };
    }
    applyPartition(groups) {
      this.partition = groups;
      for (const n of this.nodes) {
        const mine = groups ? (groups.find(g => g.includes(n.id)) || [n.id]) : [];
        n.blocked = new Set(groups ? this.nodes.map(x => x.id).filter(x => !mine.includes(x)) : []);
        n.ev(n.blocked.size ? `network: cut off from nodes [${[...n.blocked]}]` : 'network: healed');
      }
    }
    reset() {
      for (const n of this.nodes) { n.crash(); n.disk = { term: 0, votedFor: null, log: [{ term: 0 }] }; n.cfg = { prevote: true, checkQuorum: true, electionMin: 600, electionMax: 1100 }; n.events = []; n.boot('started'); }
      this.partition = null; this.config = { ...DEFAULT_CONFIG }; this.resource = {}; this.actionLog = []; this.leaderCache = null;
      this.log('LAB: cluster reset to a clean state');
    }
    async handle(url, body) {
      const nodes = this.nodes;
      switch (url) {
        case '/api/cluster': {
          const sts = this.statuses(), events = [...this.actionLog, ...sts.flatMap(n => n.events || [])].sort((a, b) => a.ts - b.ts).slice(-80);
          sts.forEach(n => delete n.events);
          return { nodes: sts, leader: this.leader(sts), partition: this.partition, events, clientEvents: this.actionLog.slice(), n: N };
        }
        case '/api/locks': return this.viaLeader('locks', {}, true);
        case '/api/acquire': case '/api/renew': case '/api/release': {
          const op = url.slice(5);
          const r = await this.viaLeader(op, body, op !== 'release');
          this.log(`${body.owner} ${op} "${body.key}" -> ${r.ok ? 'OK' + (r.token ? ' token ' + r.token : '') : r.error + (r.holder ? ' (held by ' + r.holder + ')' : '')}`);
          return r;
        }
        case '/api/resource/write': {
          const { key, token, owner, value } = body, cur = this.resource[key] || { maxToken: 0 };
          if (this.config.fencing && token < cur.maxToken) {
            this.log(`RESOURCE rejected stale write to "${key}" from ${owner} (token ${token} < ${cur.maxToken})`);
            return { ok: false, error: 'stale-token', maxToken: cur.maxToken };
          }
          this.resource[key] = { maxToken: Math.max(cur.maxToken, token), lastToken: token, value, writer: owner };
          this.log(`RESOURCE accepted write to "${key}" from ${owner} (token ${token})${this.config.fencing ? '' : ' [fencing OFF]'}`);
          return { ok: true };
        }
        case '/api/resource': return JSON.parse(JSON.stringify(this.resource));
        case '/api/config':
          if (Object.keys(body).length) {
            this.config = { ...this.config, ...body };
            nodes.forEach(n => n.setConfig(this.config));
            this.log(`CONFIG: prevote=${this.config.prevote} checkQuorum=${this.config.checkQuorum} election=${this.config.electionMin}-${this.config.electionMax}ms`);
          }
          return { ...this.config };
        case '/api/reset': this.reset(); return { ok: true };
        case '/api/feedback':
          try { const k = 'vlab.feedback'; const a = JSON.parse(localStorage.getItem(k) || '[]'); a.push({ ts: Date.now(), ...body }); localStorage.setItem(k, JSON.stringify(a)); } catch {}
          return { ok: true };
        case '/api/fault/kill': nodes[body.id - 1].crash(); this.log(`FAULT: killed node ${body.id}`); return { ok: true };
        case '/api/fault/restart': { const n = nodes[body.id - 1]; if (n.crashed) n.boot('restarted'); this.log(`FAULT: restarted node ${body.id}`); return { ok: true }; }
        case '/api/fault/wipe': nodes[body.id - 1].wipe(); this.log(`FAULT: wiped disk of node ${body.id} and restarted it`); return { ok: true };
        case '/api/fault/partition': this.applyPartition(body.groups); this.log(`FAULT: partition ${JSON.stringify(body.groups)}`); return { ok: true };
        case '/api/fault/heal': this.applyPartition(null); this.log('FAULT: network healed'); return { ok: true };
      }
      return { ok: false, error: 'not-found' };
    }
  }

  window.__SIM = new Sim();
  shim(window.__SIM);
})();
