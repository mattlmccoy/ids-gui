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
const debug = read('js/ui-debug.js');
const ink = read('js/ui-ink.js');
const modeControl = read('js/mode-control.js');
const experienceMode = read('js/experience-mode.js');
const diagnostics = read('js/diagnostics.js');
const pagesWorkflow = read('.github/workflows/deploy-pages.yml');
const pagesBuilder = read('scripts/build-pages.mjs');
const indexHtml = read('index.html');
const updatePage = read('update.html');

const expectedCommands = [
  '{"GET":"ALL"}',
  '{"WatchdogTrigger_MODE":"1"}'
];
const commandSource = serial + operation;
for (const command of expectedCommands) {
  if (!commandSource.includes(command)) throw new Error(`Missing firmware command: ${command}`);
}
for (const key of ['Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE']) {
  if (!modeControl.includes(key) || !operation.includes('requestMode')) throw new Error(`Missing shared operating-mode command path: ${key}`);
}
if (!operation.includes('commandAllModesOff') || !modeControl.includes('allModesOffCommands')) throw new Error('Missing verified All Modes Off control');
for (const marker of ['data-experience-mode-option="simple"', 'data-experience-mode-option="pro"', 'Show all settings']) {
  if (!settings.includes(marker)) throw new Error(`Settings experience selector is missing ${marker}`);
}
for (const source of [operation, settings, debug]) {
  if (!source.includes('data-experience-reveal') || !source.includes('experience-advanced')) throw new Error('Simple mode is missing an advanced-feature escape hatch');
}
if (!read('js/app.js').includes('initExperienceMode()') || !experienceMode.includes("STORAGE_KEY = 'ids.experienceMode'")) {
  throw new Error('Persistent Simple/Pro experience mode is not initialized');
}
for (const marker of ['operation-mode-help', 'What do these modes do?', 'GUI auto-off assist', 'scheduleAutoOffTimer', 'severity-ok', 'mini-tach']) {
  if (!operation.includes(marker)) throw new Error(`Operation context/safeguard UI is missing ${marker}`);
}
if (operation.includes('kpi-error d-none')) throw new Error('Active error summary is hidden by default');
for (const key of ['Purge_MODE', 'Drain_MODE']) {
  if (!modeControl.includes(`${key}:`) || !operation.includes(`timer-${key}`)) throw new Error(`Missing GUI auto-off assistance for ${key}`);
}

for (const stateKey of [
  'flushPump_STATE',
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
if ((settings.match(/data-alert-test=/g) || []).length !== 1 || !settings.includes('REMOTE_NOTIFICATION_OPTIONS.map')) {
  throw new Error('Missing per-category remote alert test-fire controls');
}
for (const type of ['test_weir_ovf', 'test_supply_ovf', 'test_firmware_alarm', 'test_controller_disconnected', 'test_data_stale']) {
  if (!read('js/notifications.js').includes(type) || !read('worker/src/index.js').includes(type)) {
    throw new Error(`Missing safe test-only Worker event: ${type}`);
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
if (!validation.includes('controller readback never proves physical safety')) throw new Error('Missing guided lab validation safety boundary');
for (const marker of ['automationReady', 'safeShutdownCommands', 'Stop & command all OFF', 'VacuumPump_STATE', 'drawEvidenceChart', 'testCurrentAlert', 'complete linked checks']) {
  if (!validation.includes(marker)) throw new Error(`Automated commissioning runner is missing ${marker}`);
}
if (!validation.includes('Finish certification')) throw new Error('Lab validation certification workflow is missing');
if (!indexHtml.includes('panel-debug') || !read('js/app.js').includes('initDebugTab')) throw new Error('Debug page is not wired into the application');
for (const [tab, initializer] of [
  ['operation', 'initOperationTab'], ['trending', 'initChartsTab'], ['monitor', 'initMonitorTab'],
  ['ink', 'initInkTab'], ['log', 'initLogTab'], ['debug', 'initDebugTab'],
  ['settings', 'initSettingsTab'], ['validation', 'initValidationTab']
]) {
  if (!indexHtml.includes(`id="tab-${tab}"`) || !indexHtml.includes(`id="panel-${tab}"`) || !read('js/app.js').includes(`${initializer}()`)) {
    throw new Error(`Tab regression: ${tab} is not fully wired to ${initializer}`);
  }
}
const expectedTabOrder = [
  'tab-operation', 'tab-trending', 'tab-log', 'tab-monitor',
  'tab-debug', 'tab-settings', 'tab-validation', 'tab-ink'
];
const actualTabOrder = [...indexHtml.matchAll(/<button class="nav-link(?: active)?" id="(tab-[^"]+)"/g)]
  .map(match => match[1]);
if (actualTabOrder.join(',') !== expectedTabOrder.join(',')) {
  throw new Error(`Unexpected primary tab order: ${actualTabOrder.join(' → ')}`);
}
for (const marker of ['Conceptual plumbing map', 'data-map-preview', 'debug-telemetry-body', 'Advanced raw command', 'downloadDiagnosticBundle']) {
  if (!debug.includes(marker)) throw new Error(`Debug page is missing ${marker}`);
}
for (const marker of ['Firmware simulator', 'no-response', 'vacuum-decay', 'excessive-cycling', 'slow-start']) {
  if (!debug.includes(marker)) throw new Error(`Debug simulator is missing ${marker}`);
}
for (const marker of ['Commanded but no hydraulic response', 'Rapid vacuum decay', 'Excessive cycling', 'Slow hydraulic start']) {
  if (!diagnostics.includes(marker)) throw new Error(`Extended diagnostic engine is missing ${marker}`);
}
for (const sourceMarker of ['InletPressure_STATE', 'ReturnPressure_STATE', 'DifferentialPressureDerived', 'MeniscusPressureEstimated']) {
  if (!(operation + charts + settings + read('js/notifications.js')).includes(sourceMarker)) throw new Error(`Dual-pressure pipeline is missing ${sourceMarker}`);
}
if (!diagnostics.includes("schema: 'ids-diagnostic-v2'") || !debug.includes('debug-export')) throw new Error('One-click diagnostic bundle v2 is missing');
if (operation.includes('ACK OFF') || operation.includes('ACK ON')) throw new Error('Operation page still exposes engineering ACK terminology');
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
if (!pagesBuilder.includes('Stamp every local module edge') || !pagesBuilder.includes('remote-dashboard.js?v=')) throw new Error('Pages assets are not consistently cache-versioned');
if (!indexHtml.includes('update-banner') || !read('js/app.js').includes('checkDeploymentInfo')) throw new Error('Web update notification flow is missing');
if (!updatePage.includes('getRegistrations') || !updatePage.includes("startsWith('ids-gui-')")) throw new Error('Force-update cache recovery page is incomplete');

console.log(`UI audit passed: ${jsFiles.length + 2} scripts parsed, shared mode commands and ${expectedCommands.length} fixed commands verified.`);
