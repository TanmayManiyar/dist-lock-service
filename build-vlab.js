// Builds the static, server-free virtual lab into vlab/ (deployable to Vercel / any static host).
// The lock cluster runs inside the visitor's browser (sim.js) instead of on a server.
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, 'public'), OUT = path.join(__dirname, 'vlab');
fs.rmSync(OUT, { recursive: true, force: true });
(function copy(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const f of fs.readdirSync(a)) {
    const s = path.join(a, f), d = path.join(b, f);
    fs.statSync(s).isDirectory() ? copy(s, d) : fs.copyFileSync(s, d);
  }
})(SRC, OUT);
fs.copyFileSync(path.join(__dirname, 'sim.js'), path.join(OUT, 'sim.js'));

const edit = (file, pairs) => {
  const p = path.join(OUT, file); let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(file + ': missing ' + a); s = s.replace(a, b); }
  fs.writeFileSync(p, s);
};
edit('index.html', [['<script src="app.js"></script>', '<script src="/sim.js"></script>\n<script src="app.js"></script>']]);
edit('lab/experiment.html', [
  ['<script src="lab.js"></script>', '<script src="/sim.js"></script>\n<script src="lab.js"></script>'],
  ['<div class="tabs" id="tabs"></div>', '<p class="crumb">The lock cluster in this lab is a simulation that runs entirely in your browser: nothing is sent to a server, and every visitor gets a private cluster. Keep this tab in the foreground while you work (browsers slow down background tabs, which can trigger extra elections).</p>\n  <div class="tabs" id="tabs"></div>'],
]);
edit('lab/lab.js', [['Thank you! Feedback saved.', 'Thank you! Feedback saved in this browser.']]);
fs.writeFileSync(path.join(OUT, 'vercel.json'), JSON.stringify({ cleanUrls: false, trailingSlash: false }, null, 2));
console.log('built', OUT);
