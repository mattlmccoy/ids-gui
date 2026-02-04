/* ===== errors.js — Error code lookup table + decoder ===== */

/**
 * Severity levels: info | warning | critical
 * Each entry: { title, detail, action, severity }
 */
const ERROR_TABLE = {
  'NO_ERROR': {
    title: 'No Error',
    detail: 'System operating normally.',
    action: 'No action required.',
    severity: 'info'
  },
  'HEATER_ERROR': {
    title: 'Heater Error',
    detail: 'Heater temperature exceeds maximum setpoint or heater control failure.',
    action: 'Check heater wiring and TemperatureMAX setpoint. Power cycle if needed.',
    severity: 'critical'
  },
  'HEATER_TC_ERROR': {
    title: 'Heater Thermocouple Error',
    detail: 'Heater thermocouple is disconnected or reading out of range.',
    action: 'Inspect thermocouple connections on heater assembly.',
    severity: 'critical'
  },
  'FLUID_TC_ERROR': {
    title: 'Fluid Thermocouple Error',
    detail: 'Fluid thermocouple is disconnected or reading out of range.',
    action: 'Inspect fluid thermocouple wiring and connections.',
    severity: 'critical'
  },
  'FLOAT_ERROR': {
    title: 'Float Switch Error',
    detail: 'One or more float switches triggered an unexpected state.',
    action: 'Check fluid levels and inspect float switch wiring.',
    severity: 'warning'
  },
  'I2C_ERROR': {
    title: 'I2C Communication Error',
    detail: 'I2C bus communication failure with a peripheral device.',
    action: 'Check I2C wiring and device addresses. Power cycle peripherals.',
    severity: 'critical'
  },
  'OPEN1_ERROR': {
    title: 'Open Error 1',
    detail: 'Reserved error code (OPEN1).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  },
  'OPEN2_ERROR': {
    title: 'Open Error 2',
    detail: 'Reserved error code (OPEN2).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  },
  'OPEN3_ERROR': {
    title: 'Open Error 3',
    detail: 'Reserved error code (OPEN3).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  },
  'OPEN4_ERROR': {
    title: 'Open Error 4',
    detail: 'Reserved error code (OPEN4).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  },
  'OPEN5_ERROR': {
    title: 'Open Error 5',
    detail: 'Reserved error code (OPEN5).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  },
  'OPEN6_ERROR': {
    title: 'Open Error 6',
    detail: 'Reserved error code (OPEN6).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  },
  'OPEN7_ERROR': {
    title: 'Open Error 7',
    detail: 'Reserved error code (OPEN7).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  },
  'OPEN8_ERROR': {
    title: 'Open Error 8',
    detail: 'Reserved error code (OPEN8).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  },
  'OPEN9_ERROR': {
    title: 'Open Error 9',
    detail: 'Reserved error code (OPEN9).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  },
  'OPEN10_ERROR': {
    title: 'Open Error 10',
    detail: 'Reserved error code (OPEN10).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  },
  'OPEN11_ERROR': {
    title: 'Open Error 11',
    detail: 'Reserved error code (OPEN11).',
    action: 'Contact support if this error persists.',
    severity: 'warning'
  }
};

/** Operational status prefixes */
const OP_STATUS = {
  'RUN': { label: 'Running', className: 'text-success' },
  'STOP': { label: 'Stopped', className: 'text-secondary' },
  'PURGE': { label: 'Purging', className: 'text-warning' },
  'FLUSH': { label: 'Flushing', className: 'text-info' },
  'DRAIN': { label: 'Draining', className: 'text-primary' }
};

/**
 * Decode an AlarmStatus string from firmware.
 * Could be "NO_ERROR", "HEATER_TC_ERROR", "RUN-HEATER_ERROR", etc.
 * Returns { opStatus, error } where:
 *   opStatus = { label, className } or null
 *   error = { code, title, detail, action, severity }
 */
export function decodeAlarmStatus(raw) {
  if (!raw || typeof raw !== 'string') {
    return {
      opStatus: null,
      error: { code: 'UNKNOWN', ...unknownError('(empty)') }
    };
  }

  const trimmed = raw.trim();
  let opStatus = null;
  let errorCode = trimmed;

  // Check for operational prefix like "RUN-", "STOP-", etc.
  const dashIdx = trimmed.indexOf('-');
  if (dashIdx > 0) {
    const prefix = trimmed.substring(0, dashIdx);
    if (OP_STATUS[prefix]) {
      opStatus = OP_STATUS[prefix];
      errorCode = trimmed.substring(dashIdx + 1);
    }
  }

  const entry = ERROR_TABLE[errorCode];
  const error = entry
    ? { code: errorCode, ...entry }
    : { code: errorCode, ...unknownError(errorCode) };

  return { opStatus, error };
}

/** Lookup a single error code */
export function lookupError(code) {
  return ERROR_TABLE[code] || unknownError(code);
}

/** Check if an error code is actually an error (not NO_ERROR) */
export function isActiveError(code) {
  return code && code !== 'NO_ERROR';
}

function unknownError(code) {
  return {
    title: 'Unknown Error',
    detail: `Unrecognized error code: ${code}`,
    action: 'Check firmware documentation or contact support.',
    severity: 'warning'
  };
}
