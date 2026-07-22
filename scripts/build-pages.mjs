import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '_site');
const publicEntries = [
  'index.html',
  'remote.html',
  'manifest.webmanifest',
  'service-worker.js',
  'assets',
  'nominal-config.json',
  'ink-check-sample-data-2weeks.json',
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
fs.writeFileSync(path.join(output, 'build-info.json'), JSON.stringify({
  commit: process.env.GITHUB_SHA || 'local',
  builtAt: new Date().toISOString(),
  channel: process.env.GITHUB_ACTIONS ? 'github-pages' : 'local-preview'
}, null, 2));

console.log(`Pages artifact created at ${output}`);
