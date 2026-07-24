/* ===== ui-dialogs.js — Confirmation dialog system ===== */

let modalInstance = null;
let resolvePromise = null;

/** Initialize the confirmation modal (call once on startup) */
export function initDialogs() {
  const modalEl = document.getElementById('confirm-modal');
  modalInstance = new bootstrap.Modal(modalEl);

  document.getElementById('confirm-modal-ok').addEventListener('click', () => {
    if (resolvePromise) resolvePromise(true);
    resolvePromise = null;
    modalInstance.hide();
  });

  modalEl.addEventListener('hidden.bs.modal', () => {
    if (resolvePromise) resolvePromise(false);
    resolvePromise = null;
  });
}

/**
 * Show a confirmation dialog and return a promise that resolves to true/false.
 * @param {string} title - Modal title
 * @param {string} body - Modal body HTML
 * @param {string} [btnLabel='Confirm'] - Confirm button text
 * @param {string} [btnClass='btn-danger'] - Confirm button class
 * @returns {Promise<boolean>}
 */
export function confirm(title, body, btnLabel = 'Confirm', btnClass = 'btn-danger') {
  return new Promise(resolve => {
    resolvePromise = resolve;
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-body').innerHTML = body;
    const okBtn = document.getElementById('confirm-modal-ok');
    okBtn.textContent = btnLabel;
    okBtn.className = `btn ${btnClass}`;
    modalInstance.show();
  });
}

/** Pre-defined confirmation dialogs for dangerous operations */
export const CONFIRMATIONS = {
  reboot: () => confirm(
    'Reboot System',
    '<p class="mb-1"><strong>This will trigger a watchdog reset.</strong></p>' +
    '<p class="text-danger mb-0">All operations will stop immediately. The system will restart in approximately 10 seconds.</p>',
    'Reboot',
    'btn-danger'
  ),
  run: () => confirm(
    'Start System',
    '<p class="mb-1"><strong>This will start ink recirculation.</strong></p>' +
    '<p class="text-warning mb-0">Verify all fluid connections are secure before proceeding.</p>',
    'Start',
    'btn-success'
  ),
  stop: () => confirm(
    'Stop Run Mode',
    '<p class="mb-1"><strong>This sends Run_MODE OFF and begins the R17 wind-down.</strong></p>' +
    '<p class="text-warning mb-0">It does not turn Purge, Flush, or Drain off. Use “All Modes Off” for a verified controlled shutdown.</p>',
    'Stop Run',
    'btn-warning'
  ),
  purgeOn: () => confirm(
    'Enable Purge Mode',
    '<p class="mb-1"><strong>R17 pulses the recirculation pump; the input pump is conditional on the Weir OVF raw state.</strong></p>' +
    '<p class="text-warning mb-0">The firmware does not independently open flush/drain hardware. Verify the actual hose route and waste destination.</p>',
    'Enable Purge',
    'btn-warning'
  ),
  flushOn: () => confirm(
    'Enable Flush Mode',
    '<p class="mb-1"><strong>This requests the flush pump and flush valve for five seconds.</strong></p>' +
    '<p class="text-danger mb-0">Known R17 defect: the firmware timer is not reset for a new cycle, so the mode may clear immediately. The UI will report the readback and will not retry automatically.</p>',
    'Enable Flush',
    'btn-warning'
  ),
  drainOn: () => confirm(
    'Enable Drain Mode',
    '<p class="mb-1"><strong>R17 runs the drain pump and opens manifold valves 1 and 2.</strong></p>' +
    '<p class="text-warning mb-0">It commands the separate drain valve OFF. Confirm the physical route and waste container before proceeding.</p>',
    'Enable Drain',
    'btn-warning'
  )
};
