/* Header "What's new" dropdown — renders the human-readable changelog and tracks what the
   operator has already seen so a small badge appears after each update. */

import { CHANGELOG, unseenCount, latestVersion } from './changelog.js';

const SEEN_KEY = 'ids-changelog-seen-v1';

export function initChangelog() {
  renderBody();
  updateBadge();
  const modalEl = document.getElementById('whatsnew-modal');
  modalEl?.addEventListener('shown.bs.modal', markSeen);
}

function renderBody() {
  const body = document.getElementById('whatsnew-body');
  if (!body) return;
  body.innerHTML = CHANGELOG.map((entry, index) => `
    <div class="mb-3">
      <div class="d-flex align-items-center gap-2 mb-1 flex-wrap">
        <span class="fw-semibold">${escapeText(entry.title)}</span>
        <span class="badge text-bg-secondary">${escapeText(entry.version)}</span>
        ${index === 0 ? '<span class="badge text-bg-success">Latest</span>' : ''}
      </div>
      <ul class="small mb-0">${entry.items.map(item => `<li>${escapeText(item)}</li>`).join('')}</ul>
    </div>`).join('');
}

function updateBadge() {
  const badge = document.getElementById('whatsnew-badge');
  if (!badge) return;
  badge.classList.toggle('d-none', unseenCount(CHANGELOG, readSeen()) === 0);
}

function markSeen() {
  try { localStorage.setItem(SEEN_KEY, latestVersion() || ''); } catch (_) { /* non-persistent browser */ }
  updateBadge();
}

function readSeen() {
  try { return localStorage.getItem(SEEN_KEY); } catch (_) { return null; }
}

function escapeText(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}
