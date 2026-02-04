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
    'Stop System',
    '<p class="mb-0"><strong>This will stop the recirculation system.</strong></p>',
    'Stop',
    'btn-warning'
  ),
  purgeOn: () => confirm(
    'Enable Purge Mode',
    '<p class="mb-1"><strong>This will activate purge mode.</strong></p>' +
    '<p class="text-warning mb-0">Ensure waste container is in place and fluid lines are connected.</p>',
    'Enable Purge',
    'btn-warning'
  ),
  flushOn: () => confirm(
    'Enable Flush Mode',
    '<p class="mb-1"><strong>This will activate flush mode.</strong></p>' +
    '<p class="text-warning mb-0">Ensure flush fluid supply is connected and waste container is ready.</p>',
    'Enable Flush',
    'btn-warning'
  ),
  drainOn: () => confirm(
    'Enable Drain Mode',
    '<p class="mb-1"><strong>This will activate drain mode.</strong></p>' +
    '<p class="text-warning mb-0">Ensure waste container is in place. System fluid will be drained.</p>',
    'Enable Drain',
    'btn-warning'
  )
};
