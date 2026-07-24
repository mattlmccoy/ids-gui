/* Single I/O entry point. Holds the active transport (serial or cloud) and
   delegates. Feature modules import send/connect/... from here, not serial.js. */
import { SerialTransport } from './serial.js';

let active = SerialTransport;

export function setActiveTransport(t) { active = t; }
export function getActiveTransport() { return active; }

export function connect() { return active.connect(); }
export function disconnect(reason) { return active.disconnect(reason); }
export function send(json) { return active.send(json); }
export function isSerialSupported() { return SerialTransport.isSupported(); }
export function isMirror() { return active.id === 'cloud'; }
export function getPollIntervalMs() { return active.getPollIntervalMs(); }
export function getNominalPollIntervalMs() { return active.getNominalPollIntervalMs(); }
export function setPollIntervalMs(ms) { return active.setPollIntervalMs(ms); }
