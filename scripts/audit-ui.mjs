import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = path.join(root, 'js');
const jsFiles = fs.readdirSync(jsDir)
  .filter(name => name.endsWith('.js'))
  .map(name => path.join(jsDir, name));

for (const file of [...jsFiles, path.join(root, 'main.js'), path.join(root, 'preload.js')]) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) throw new Error(`Syntax check failed for ${file}\n${checked.stderr}`);
}

const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const serial = read('js/serial.js');
const operation = read('js/ui-operation.js');
const monitor = read('js/ui-monitor.js');
const settings = read('js/ui-settings.js');
const charts = read('js/ui-charts.js');
const validation = read('js/ui-validation.js');
const ink = read('js/ui-ink.js');
const pagesWorkflow = read('.github/workflows/deploy-pages.yml');
const pagesBuilder = read('scripts/build-pages.mjs');
const indexHtml = read('index.html');
const updatePage = read('update.html');

const expectedCommands = [
  '{"GET":"ALL"}',
  '{"Run_MODE":"1"}',
  '{"Run_MODE":"0"}',
  '{"WatchdogTrigger_MODE":"1"}',
  '{"Purge_MODE":"1"}',
  '{"Purge_MODE":"0"}',
  '{"Flush_MODE":"1"}',
  '{"Flush_MODE":"0"}',
  '{"Drain_MODE":"1"}',
  '{"Drain_MODE":"0"}',
  '{"Bypass_MODE":"1"}',
  '{"Bypass_MODE":"0"}'
];
const commandSource = serial + operation;
for (const command of expectedCommands) {
  if (!commandSource.includes(command)) throw new Error(`Missing firmware command: ${command}`);
}

for (const stateKey of [
  'flushPump_STATE',
  'BypassValve_STATE',
  'ManifoldValve2_STATE',
  'WeirOverflowFloat_STATE'
]) {
  if (!(operation + monitor + charts).includes(stateKey)) {
    throw new Error(`Known firmware state is not represented in the UI: ${stateKey}`);
  }
}

if (!settings.includes('toggle-weir-ovf-invert')) throw new Error('Missing Weir OVF inversion control');
for (const key of ['weirOverflow', 'supplyOverflow', 'firmwareAlarm', 'controllerConnection', 'staleData']) {
  if (!settings.includes(key) || !read('js/notifications.js').includes(key)) {
    throw new Error(`Missing remote notification selection: ${key}`);
  }
}
if (!charts.includes('state-track-checkbox')) throw new Error('Missing selectable state trend controls');
for (const stateKey of ['VacuumPump_STATE', 'ManifoldValve1_STATE']) {
  if (!charts.includes(stateKey)) throw new Error(`Missing state trend trace: ${stateKey}`);
}
if (!charts.includes("shown.bs.tab")) throw new Error('Trending charts do not resize when shown');
if (!charts.includes('pressureChart.options.scales.x.min = cutoff') || !charts.includes('stateChart.options.scales.x.min = cutoff')) {
  throw new Error('Pressure and state histories do not share explicit time bounds');
}
for (const code of ["'HTC_ERROR'", "'HTC'", "'8192'"]) {
  if (!read('js/errors.js').includes(code)) throw new Error(`HTC firmware representation ${code} is not decoded`);
}
if (!validation.includes('the analyzer observes controller telemetry but never proves physical safety')) throw new Error('Missing guided lab validation safety boundary');
if (!validation.includes('Finish certification')) throw new Error('Lab validation certification workflow is missing');
if (!ink.includes('defaultSampleVolumeUl: 1000')) throw new Error('Ink checker sample default is not 1 mL');
if (!ink.includes('Calibration required:')) throw new Error('Ink checker calibration warning is missing');
if (!ink.includes('interpolateCalibration')) throw new Error('Ink checker empirical calibration model is missing');
if (!ink.includes('assessDensity')) throw new Error('Ink checker plausibility guard is missing');
if (!pagesWorkflow.includes('actions/deploy-pages@v4')) throw new Error('Missing GitHub Pages deployment action');
if (!pagesWorkflow.includes('npm run build:pages')) throw new Error('Pages workflow does not build a clean artifact');
for (const entry of ['index.html', 'css', 'js', 'vendor']) {
  if (!pagesBuilder.includes(`'${entry}'`)) throw new Error(`Pages builder is missing ${entry}`);
}
if (!indexHtml.includes('ids-build-commit') || !pagesBuilder.includes('ids-build-commit')) throw new Error('Pages build identity is not embedded');
if (!indexHtml.includes('update-banner') || !read('js/app.js').includes('checkDeploymentInfo')) throw new Error('Web update notification flow is missing');
if (!updatePage.includes('getRegistrations') || !updatePage.includes("startsWith('ids-gui-')")) throw new Error('Force-update cache recovery page is incomplete');

console.log(`UI audit passed: ${jsFiles.length + 2} scripts parsed, ${expectedCommands.length} commands verified.`);
