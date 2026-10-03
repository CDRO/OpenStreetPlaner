// Startet den Go-Server mit leerem Datenordner und führt die Browser-Tests
// nacheinander aus. Braucht Go und ein installiertes Playwright mit Chromium.
//   node web/tests/browser/run.cjs
//   ONLY=roads.test.cjs node web/tests/browser/run.cjs   (nur eine Datei)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // noch nicht bereit
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server antwortet nicht: ${url}`);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stadtplaner-'));
  const bin = path.join(tmp, 'stadtplaner');
  const build = spawnSync('go', ['build', '-o', bin, '.'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status || 1);
  const port = await freePort();
  const server = spawn(bin, ['-addr', `127.0.0.1:${port}`, '-data', path.join(tmp, 'data'), '-tile-url', `http://127.0.0.1:${port}/nope/{z}/{x}/{y}.png`], { stdio: ['ignore', 'inherit', 'inherit'] });
  let failed = false;
  try {
    const base = `http://127.0.0.1:${port}/`;
    await waitFor(base + 'healthz');
    const files = process.env.ONLY ? process.env.ONLY.split(',') : ['basics.test.cjs', 'osm-editing.test.cjs', 'ux.test.cjs', 'roads.test.cjs', 'analysis.test.cjs', 'dossier.test.cjs', 'reach.test.cjs', 'plan.test.cjs', 'lang.test.cjs', 'bus.test.cjs', 'edit.test.cjs', 'theme.test.cjs', 'offline.test.cjs', 'race.test.cjs', 'merge.test.cjs'];
    const ci = !!process.env.GITHUB_ACTIONS;
    for (const file of files) {
      if (ci) console.log(`::group::${file}`);
      // Ausgabe durchreichen, aber behalten: in der CI landet die Fehlstelle als Annotation am Check,
      // die auch ohne Zugriff auf das Log-Archiv lesbar ist.
      const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, BASE_URL: base } });
      process.stdout.write(r.stdout || '');
      process.stderr.write(r.stderr || '');
      if (ci) console.log('::endgroup::');
      if (r.status !== 0) {
        failed = true;
        if (ci) {
          const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map((l) => l.trim()).filter((l) => l && !/^\d{4}\/\d{2}\/\d{2} /.test(l));
          const tail = lines.slice(-12).join(' | ').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
          console.log(`::error file=web/tests/browser/${file},title=Browser-Test ${file} fehlgeschlagen::${tail}`);
        }
      }
    }
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
