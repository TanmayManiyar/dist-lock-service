// Vercel serverless proxy: forwards /api/* to the real lock-service gateway running on AWS.
// If the AWS instance is stopped (Learner Lab not started) it answers 503 within a few seconds,
// which tells the landing page to fall back to the in-browser Virtual Lab.
//
// Env vars (Vercel -> Project -> Settings -> Environment Variables):
//   BACKEND_URL        e.g. http://3.90.12.34:8080   (no trailing slash)  -- required
//   BACKEND_AUTH       optional "user:password" if the gateway runs with BASIC_AUTH
//   BACKEND_TIMEOUT_MS optional, default 4000
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  const base = (process.env.BACKEND_URL || '').trim().replace(/\/+$/, '');
  if (!base) { res.status(503).json({ ok: false, error: 'BACKEND_URL is not configured' }); return; }

  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (process.env.BACKEND_AUTH) headers.authorization = 'Basic ' + Buffer.from(process.env.BACKEND_AUTH).toString('base64');

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  }

  try {
    // vercel.json rewrites /api/<anything> to /api/proxy?p=<anything> (nested paths need this)
    const u = new URL(req.url, 'http://x'), p = u.searchParams.get('p');
    u.searchParams.delete('p');
    const target = base + (p !== null ? '/api/' + p : u.pathname) + u.search;
    const r = await fetch(target, {
      method: req.method, headers, body,
      signal: AbortSignal.timeout(+process.env.BACKEND_TIMEOUT_MS || 4000),
    });
    const text = await r.text();
    res.status(r.status);
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'AWS backend unreachable (lab stopped?)' });
  }
};
