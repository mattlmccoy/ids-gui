/* ===== state.js — Singleton event bus + state store ===== */

/**
 * Events emitted:
 *   'data'         — new firmware data frame parsed       (payload: object)
 *   'connection'   — connection state changed             (payload: string)
 *   'error'        — alarm/error status changed           (payload: { raw, decoded })
 *   'log'          — new log entry                        (payload: { severity, message, timestamp })
 *   'command-sent' — command sent to firmware              (payload: string)
 *   'heater-visibility' — heater visibility changed        (payload: object)
 *   'disconnect-reason' — manual or unexpected disconnect   (payload: string)
 */

class StateStore {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();

    /** Last complete firmware data frame */
    this.data = {};

    /** Connection state: DISCONNECTED | CONNECTING | CONNECTED | ERROR */
    this.connection = 'DISCONNECTED';

    /** Last raw AlarmStatus string */
    this.alarmRaw = '';

    /** Session start time */
    this.sessionStart = null;

    /** True while a saved telemetry recording is being replayed */
    this.replayActive = false;
    this.simulationActive = false;
    this.simulationScenario = '';

    /** Heater visibility flags used for UI/chart/log filtering */
    this.heaterVisibility = {
      MainHeater: true,
      AuxHeater: true
    };
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} fn
   * @returns {Function} unsubscribe function
   */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} event
   * @param {*} payload
   */
  emit(event, payload) {
    const fns = this._listeners.get(event);
    if (fns) fns.forEach(fn => { try { fn(payload); } catch (e) { console.error(`[state] listener error on '${event}':`, e); } });
  }

  /** Update firmware data and emit */
  setData(obj) {
    this.data = { ...this.data, ...obj };
    this.emit('data', this.data);

    // Check for alarm change
    const alarm = obj.AlarmStatus ?? obj.ErrorCode_STATE;
    if (alarm !== undefined && alarm !== this.alarmRaw) {
      this.alarmRaw = alarm;
      this.emit('error', { raw: alarm });
    }
  }

  /** Update connection state and emit */
  setConnection(state) {
    this.connection = state;
    if (state === 'CONNECTED' && !this.sessionStart) {
      this.sessionStart = new Date();
    }
    if (state === 'DISCONNECTED') {
      this.sessionStart = null;
    }
    this.emit('connection', state);
  }

  /** Add a log entry and emit */
  log(severity, message) {
    const entry = { severity, message, timestamp: new Date() };
    this.emit('log', entry);
  }

  /** Set heater visibility and emit */
  setHeaterVisibility(heater, visible) {
    if (!(heater in this.heaterVisibility)) return;
    const next = !!visible;
    if (this.heaterVisibility[heater] === next) return;
    this.heaterVisibility = { ...this.heaterVisibility, [heater]: next };
    this.emit('heater-visibility', this.heaterVisibility);
  }

  /** Get heater visibility map */
  getHeaterVisibility() {
    return this.heaterVisibility;
  }

  setReplayActive(active) {
    this.replayActive = !!active;
    this.emit('replay', this.replayActive);
  }

  setSimulationActive(active, scenario = '') {
    this.simulationActive = !!active;
    this.simulationScenario = this.simulationActive ? String(scenario) : '';
    this.emit('simulation', { active: this.simulationActive, scenario: this.simulationScenario });
  }

  replaceData(obj = {}) {
    this.data = { ...obj };
    this.alarmRaw = this.data.AlarmStatus ?? this.data.ErrorCode_STATE ?? '';
    this.emit('data', this.data);
    this.emit('error', { raw: this.alarmRaw });
  }
}

/** Singleton instance */
const store = new StateStore();
export default store;
