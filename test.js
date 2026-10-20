// Smoke / fault-injection test. Run while the server is up: npm run fresh  (other terminal) npm test
const B = 'http://localhost:8080';
const post = (u, b) => fetch(B + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());
const get = u => fetch(B + u).then(r => r.json());
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) fails++; };
async function waitLeader(excl) {
  for (let i = 0; i < 40; i++) { const c = await get('/api/cluster'); if (c.leader && c.leader !== excl) return c.leader; await sleep(250); }
  return null;
}

(async () => {
  await post('/api/fault/heal');
  let c = await get('/api/cluster');
  for (const n of c.nodes) if (!n.up) await post('/api/fault/restart', { id: n.id });
  let leader = await waitLeader();
  check('leader elected', !!leader, 'N' + leader);

  const key = 'k' + Date.now();
  const a = await post('/api/acquire', { key, owner: 'A', ttlMs: 30000 });
  check('A acquires', a.ok, 'token ' + a.token);
  const b = await post('/api/acquire', { key, owner: 'B', ttlMs: 30000 });
  check('B is denied (mutual exclusion)', !b.ok && b.error === 'held');

  await post('/api/fault/kill', { id: leader });
  const l2 = await waitLeader(leader);
  check('new leader after leader crash', !!l2 && l2 !== leader, 'N' + l2);
  const locks = await get('/api/locks');
  check('lock survives failover', locks.ok && locks.locks[key] && locks.locks[key].owner === 'A');
  const b2 = await post('/api/acquire', { key, owner: 'B', ttlMs: 30000 });
  check('still exclusive after failover', !b2.ok);
  await post('/api/release', { key, owner: 'A', token: a.token });

  const k2 = key + 'x';
  const t1 = await post('/api/acquire', { key: k2, owner: 'A', ttlMs: 600 });
  await sleep(1500);
  const t2 = await post('/api/acquire', { key: k2, owner: 'B', ttlMs: 5000 });
  check('lease expiry lets B acquire', t2.ok);
  check('fencing tokens strictly increase', t2.token > t1.token && t1.token > a.token, `${a.token} < ${t1.token} < ${t2.token}`);

  // partition the current leader away from the majority
  c = await get('/api/cluster');
  const cur = c.leader, others = c.nodes.filter(n => n.up && n.id !== cur).map(n => n.id);
  await post('/api/fault/partition', { groups: [[cur], others] });
  const l3 = await waitLeader(cur);
  check('majority side elects new leader under partition', !!l3 && l3 !== cur, 'N' + l3);
  const k3 = key + 'y';
  const p = await post('/api/acquire', { key: k3, owner: 'C', ttlMs: 5000 });
  check('majority side serves writes', p.ok && p.servedBy !== cur);
  await post('/api/fault/heal');
  await sleep(2000);
  c = await get('/api/cluster');
  const leaders = c.nodes.filter(n => n.up && n.role === 'leader');
  check('single leader after heal (no split brain)', leaders.length === 1);
  const after = await get('/api/locks');
  check('state converged after heal', after.ok && after.locks[k3] && after.locks[k3].owner === 'C');

  for (const n of c.nodes) if (!n.up) await post('/api/fault/restart', { id: n.id });
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
