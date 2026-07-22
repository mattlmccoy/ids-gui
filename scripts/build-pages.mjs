import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '_site');
const publicEntries = [
  'index.html',
  'remote.html',
  'update.html',
  'manifest.webmanifest',
  'service-worker.js',
  'assets',
  'nominal-config.json',
  'css',
  'js',
  'vendor'
];

if (path.dirname(output) !== root || path.basename(output) !== '_site') {
  throw new Error(`Refusing to clean unexpected output path: ${output}`);
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const entry of publicEntries) {
  const source = path.join(root, entry);
  if (!fs.existsSync(source)) throw new Error(`Missing Pages asset: ${entry}`);
  fs.cpSync(source, path.join(output, entry), { recursive: true });
}

fs.writeFileSync(path.join(output, '.nojekyll'), '');
const buildCommit = process.env.GITHUB_SHA || 'local';
fs.writeFileSync(path.join(output, 'build-info.json'), JSON.stringify({
  commit: buildCommit,
  builtAt: new Date().toISOString(),
  channel: process.env.GITHUB_ACTIONS ? 'github-pages' : 'local-preview'
}, null, 2));

const builtIndex = path.join(output, 'index.html');
fs.writeFileSync(builtIndex, fs.readFileSync(builtIndex, 'utf8')
  .replace('<meta name="ids-build-commit" content="local">', `<meta name="ids-build-commit" content="${buildCommit}">`)
  .replace("./js/app.js?v=local", `./js/app.js?v=${buildCommit}`)
  .replace('href="css/styles.css"', `href="css/styles.css?v=${buildCommit}"`));

// A new query on app.js alone is not enough: browsers may reuse its nested
// modules from the HTTP cache. Stamp every local module edge so one deployment
// always resolves to one complete, internally consistent JavaScript build.
const jsOutput = path.join(output, 'js');
for (const filename of fs.readdirSync(jsOutput).filter(name => name.endsWith('.js'))) {
  const target = path.join(jsOutput, filename);
  const source = fs.readFileSync(target, 'utf8');
  const versioned = source
    .replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"]+\.js)(['"])/g, `$1$2?v=${buildCommit}$3`)
    .replace(/(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+\.js)(['"]\s*\))/g, `$1$2?v=${buildCommit}$3`);
  fs.writeFileSync(target, versioned);
}

const builtRemote = path.join(output, 'remote.html');
fs.writeFileSync(builtRemote, fs.readFileSync(builtRemote, 'utf8')
  .replace('href="css/styles.css"', `href="css/styles.css?v=${buildCommit}"`)
  .replace('src="js/remote-dashboard.js"', `src="js/remote-dashboard.js?v=${buildCommit}"`));

console.log(`Pages artifact created at ${output}`);
