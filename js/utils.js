/* ===== utils.js — Shared utility functions ===== */

/** Clamp a number between min and max */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Format a Date to HH:MM:SS.mmm */
export function formatTimestamp(date = new Date()) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/** Format a Date to YYYY-MM-DD_HH-MM-SS (for file names) */
export function formatFileDate(date = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

/**
 * Convert a firmware key like "MainHeaterTemperature_STATE" to
 * "Main Heater Temperature" by splitting on underscores and capitals.
 */
export function humanizeKey(key) {
  // Remove common suffixes
  let base = key.replace(/_(STATE|SETPOINT|SETUP|MODE)$/, '');
  // Insert spaces before capitals in camelCase
  base = base.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Replace underscores
  base = base.replace(/_/g, ' ');
  return base;
}

/** Get the unit suffix for a firmware key */
export function unitForKey(key) {
  if (/Temperature/i.test(key)) return '\u00B0C';
  if (/Vacuum/i.test(key) && key.includes('STATE')) return ' cmH\u2082O';
  if (/Vacuum/i.test(key) && key.includes('SETPOINT')) return '%';
  if (/Flow/i.test(key)) return '%';
  if (/Speed|PumpSpeed/i.test(key)) return '%';
  if (/IP\d/i.test(key)) return '';
  if (/Timeout/i.test(key)) return 's';
  if (/Pressure/i.test(key)) return ' psi';
  return '';
}

/** Flash a button to show "Sent" state, then revert after 1s */
export function flashSentButton(btn, originalText = 'Send') {
  const origClass = btn.className;
  btn.textContent = 'Sent';
  btn.classList.add('btn-sent');
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = originalText;
    btn.classList.remove('btn-sent');
    btn.className = origClass;
    btn.disabled = false;
  }, 1000);
}

/** Create a DOM element with optional attributes and children */
export function el(tag, attrs = {}, ...children) {
  const elem = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') elem.className = v;
    else if (k === 'textContent') elem.textContent = v;
    else if (k === 'innerHTML') elem.innerHTML = v;
    else if (k.startsWith('on')) elem.addEventListener(k.slice(2).toLowerCase(), v);
    else elem.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') elem.appendChild(document.createTextNode(child));
    else if (child) elem.appendChild(child);
  }
  return elem;
}
