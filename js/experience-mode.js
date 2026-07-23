/* Shared progressive-disclosure mode. This changes presentation only. */

const STORAGE_KEY = 'ids.experienceMode';
const MODES = new Set(['simple', 'pro']);

export function getExperienceMode() {
  try {
    return normalizeExperienceMode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 'simple';
  }
}

export function normalizeExperienceMode(value) {
  return MODES.has(value) ? value : 'simple';
}

export function initExperienceMode() {
  applyMode(getExperienceMode(), false);
  document.addEventListener('click', event => {
    const modeButton = event.target.closest('[data-experience-mode-option]');
    if (modeButton) {
      setExperienceMode(modeButton.dataset.experienceModeOption);
      return;
    }
    const revealButton = event.target.closest('[data-experience-reveal]');
    if (revealButton) {
      const revealed = document.documentElement.dataset.experienceAdvanced === 'true';
      document.documentElement.dataset.experienceAdvanced = String(!revealed);
      syncExperienceControls();
    }
  });
}

export function setExperienceMode(mode) {
  if (!MODES.has(mode)) return getExperienceMode();
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* non-persistent browser */ }
  applyMode(mode, true);
  return mode;
}

export function syncExperienceControls() {
  const mode = document.documentElement.dataset.experienceMode || 'simple';
  const revealed = document.documentElement.dataset.experienceAdvanced === 'true';
  document.querySelectorAll('[data-experience-mode-option]').forEach(button => {
    const selected = button.dataset.experienceModeOption === mode;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('[data-experience-current]').forEach(element => {
    element.textContent = mode === 'pro' ? 'Pro' : 'Simple';
  });
  document.querySelectorAll('[data-experience-reveal]').forEach(button => {
    button.classList.toggle('d-none', mode === 'pro');
    const showLabel = button.dataset.showLabel || 'Show advanced controls';
    const hideLabel = button.dataset.hideLabel || 'Hide advanced controls';
    const icon = revealed ? 'bi-chevron-up' : 'bi-sliders';
    button.innerHTML = `<i class="bi ${icon} me-1"></i>${revealed ? hideLabel : showLabel}`;
    button.setAttribute('aria-expanded', String(revealed || mode === 'pro'));
  });
}

function applyMode(mode, announce) {
  document.documentElement.dataset.experienceMode = mode;
  document.documentElement.dataset.experienceAdvanced = 'false';
  syncExperienceControls();
  if (announce) window.dispatchEvent(new CustomEvent('ids-experience-mode', { detail: { mode } }));
}
