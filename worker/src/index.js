const EVENT_DEFINITIONS = {
  weir_ovf_active: {
    alertKey: 'weir_ovf', phase: 'active', severity: 'urgent',
    title: 'IDS Weir OVF activated', tags: 'rotating_light,droplet'
  },
  weir_ovf_recovered: {
    alertKey: 'weir_ovf', phase: 'recovered', severity: 'info',
    title: 'IDS Weir OVF cleared', tags: 'white_check_mark,droplet'
  },
  supply_ovf_active: {
    alertKey: 'supply_ovf', phase: 'active', severity: 'urgent',
    title: 'IDS Supply OVF activated', tags: 'rotating_light,droplet'
  },
  supply_ovf_recovered: {
    alertKey: 'supply_ovf', phase: 'recovered', severity: 'info',
    title: 'IDS Supply OVF cleared', tags: 'white_check_mark,droplet'
  },
  firmware_alarm_active: {
    alertKey: 'firmware_alarm', phase: 'active', severity: 'urgent',
    title: 'IDS firmware alarm', tags: 'rotating_light,warning'
  },
  firmware_alarm_recovered: {
    alertKey: 'firmware_alarm', phase: 'recovered', severity: 'info',
    title: 'IDS firmware alarm cleared', tags: 'white_check_mark,wrench'
  },
  controller_disconnected: {
    alertKey: 'controller_connection', phase: 'active', severity: 'warning',
    title: 'IDS controller disconnected', tags: 'warning,electric_plug'
  },
  controller_reconnected: {
    alertKey: 'controller_connection', phase: 'recovered', severity: 'info',
    title: 'IDS controller reconnected', tags: 'white_check_mark,electric_plug'
  },
  data_stale: {
    alertKey: 'data_stale', phase: 'active', severity: 'warning',
    title: 'IDS data stream is stale', tags: 'warning,hourglass'
  },
  data_recovered: {
    alertKey: 'data_stale', phase: 'recovered', severity: 'info',
    title: 'IDS data stream recovered', tags: 'white_check_mark,chart_with_upwards_trend'
  },
  test: {
    alertKey: 'test', phase: 'test', severity: 'info',
    title: 'IDS test notification', tags: 'test_tube,white_check_mark'
  }
};

const TELEMETRY_KEYS = new Set([
  'SystemID', 'SoftwareRev', 'AlarmStatus', 'ErrorCode_STATE',
  'Run_MODE', 'Purge_MODE', 'Flush_MODE', 'Drain_MODE', 'Bypass_MODE',
  'Vacuum_STATE', 'Pressure_STATE', 'FluidTemperature_STATE',
  'MainHeaterTemperature_STATE', 'AUXHeaterTemperature_STATE',
  'SupplyFloat_STATE', 'WeirFloat_STATE', 'WasteFloat_STATE',
  'SupplyOverflowFloat_STATE', 'WeirOverflowFloat_STATE',
  'FlushFloat_STATE', 'ServiceFloat_STATE'
]);

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error('Unhandled Worker error', error);
      return json({ error: 'Internal server error' }, 500, request, env);
    }
  }
};

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return corsPreflight(request, env);
  if (!originAllowed(request, env)) return json({ error: 'Origin not allowed' }, 403, request, env);

  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true, service: 'ids-alert-relay', time: new Date().toISOString() }, 200, request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/events') {
    if (!(await authorized(request, env.DEVICE_TOKEN))) return unauthorized(request, env);
    return createEvent(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/telemetry') {
    if (!(await authorized(request, env.DEVICE_TOKEN))) return unauthorized(request, env);
    return updateTelemetry(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/events') {
    if (!(await authorized(request, env.VIEWER_TOKEN))) return unauthorized(request, env);
    return listEvents(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/status') {
    if (!(await authorized(request, env.VIEWER_TOKEN))) return unauthorized(request, env);
    return getStatus(request, env);
  }
  const ackMatch = url.pathname.match(/^\/api\/v1\/events\/([A-Za-z0-9-]+)\/ack$/);
  if (request.method === 'POST' && ackMatch) {
    if (!(await authorized(request, env.VIEWER_TOKEN))) return unauthorized(request, env);
    return acknowledgeEvent(request, env, ackMatch[1]);
  }
  const deliveryMatch = url.pathname.match(/^\/api\/v1\/events\/([A-Za-z0-9-]+)\/delivery$/);
  if (request.method === 'POST' && deliveryMatch) {
    if (!(await authorized(request, env.DEVICE_TOKEN))) return unauthorized(request, env);
    return recordDirectDelivery(request, env, deliveryMatch[1]);
  }
  return json({ error: 'Not found' }, 404, request, env);
}

async function createEvent(request, env) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Expected JSON body' }, 400, request, env); }

  const definition = EVENT_DEFINITIONS[body.type];
  if (!definition) return json({ error: 'Unsupported event type' }, 400, request, env);

  const deviceId = clean(body.deviceId, 80);
  const systemId = clean(body.systemId, 80, true);
  const suppliedMessage = clean(body.message, 500, true);
  const idempotencyKey = clean(request.headers.get('Idempotency-Key') || body.idempotencyKey, 120);
  if (!deviceId || !idempotencyKey) {
    return json({ error: 'deviceId and Idempotency-Key are required' }, 400, request, env);
  }

  const duplicate = await env.DB.prepare('SELECT * FROM events WHERE idempotency_key = ?')
    .bind(idempotencyKey).first();
  if (duplicate) return json({ event: duplicate, duplicate: true }, 200, request, env);

  const priorState = definition.phase === 'test' ? null : await env.DB.prepare(
    'SELECT active FROM alert_states WHERE device_id = ? AND alert_key = ?'
  ).bind(deviceId, definition.alertKey).first();
  const nextActive = definition.phase === 'active' ? 1 : 0;
  const stateDuplicate = definition.phase !== 'test' && priorState && Number(priorState.active) === nextActive;

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const location = systemId || deviceId;
  const message = suppliedMessage || defaultMessage(body.type, location);
  const notificationStatus = stateDuplicate ? 'suppressed' : 'pending';

  await env.DB.prepare(`INSERT INTO events
    (id, idempotency_key, device_id, system_id, event_type, alert_key, phase, severity,
     title, message, source_time, created_at, notification_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, idempotencyKey, deviceId, systemId, body.type, definition.alertKey,
      definition.phase, definition.severity, definition.title, message,
      clean(body.sourceTime, 40, true), now, notificationStatus).run();

  if (definition.phase !== 'test') {
    await env.DB.prepare(`INSERT INTO alert_states
      (device_id, alert_key, active, latest_event_id, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id, alert_key) DO UPDATE SET
        active = excluded.active, latest_event_id = excluded.latest_event_id, updated_at = excluded.updated_at`)
      .bind(deviceId, definition.alertKey, nextActive, id, now).run();
  }

  if (!stateDuplicate) {
    try {
      const [ntfyResult, slackResult] = await Promise.allSettled([
        publishNtfy(env, definition, message),
        publishSlack(env, definition, message, location)
      ]);
      if (slackResult.status === 'rejected') console.error('Slack delivery failed', slackResult.reason);
      if (ntfyResult.status === 'rejected') throw ntfyResult.reason;
      await env.DB.prepare("UPDATE events SET notification_status = 'sent' WHERE id = ?").bind(id).run();
    } catch (error) {
      console.error('ntfy delivery failed', error);
      await env.DB.prepare("UPDATE events SET notification_status = 'failed', notification_error = ? WHERE id = ?")
        .bind(String(error.message || error).slice(0, 500), id).run();
    }
  }

  const event = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  return json({ event, duplicate: stateDuplicate }, 201, request, env);
}

async function updateTelemetry(request, env) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Expected JSON body' }, 400, request, env); }
  const deviceId = clean(body.deviceId, 80);
  if (!deviceId) return json({ error: 'deviceId is required' }, 400, request, env);
  const connection = ['CONNECTED', 'DISCONNECTED', 'CONNECTING', 'ERROR'].includes(body.connection)
    ? body.connection : 'DISCONNECTED';
  const telemetry = {};
  if (body.telemetry && typeof body.telemetry === 'object' && !Array.isArray(body.telemetry)) {
    for (const [key, value] of Object.entries(body.telemetry)) {
      if (!TELEMETRY_KEYS.has(key)) continue;
      if (value === null || typeof value === 'number' || typeof value === 'boolean') telemetry[key] = value;
      else if (typeof value === 'string') telemetry[key] = value.slice(0, 120);
    }
  }
  const now = new Date().toISOString();
  const systemId = clean(body.systemId || telemetry.SystemID, 80, true);
  const sourceTime = clean(body.sourceTime, 40, true);
  await env.DB.prepare(`INSERT INTO device_status
    (device_id, system_id, connection, telemetry_json, source_time, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      system_id = excluded.system_id,
      connection = excluded.connection,
      telemetry_json = excluded.telemetry_json,
      source_time = excluded.source_time,
      updated_at = excluded.updated_at`)
    .bind(deviceId, systemId, connection, JSON.stringify(telemetry), sourceTime, now).run();
  return json({ ok: true, deviceId, updatedAt: now }, 200, request, env);
}

async function publishSlack(env, definition, message, location) {
  if (!env.SLACK_WEBHOOK_URL) return;
  const color = definition.severity === 'urgent' ? '#dc3545' : definition.severity === 'warning' ? '#ffc107' : '#198754';
  const fields = [
    { type: 'mrkdwn', text: `*System*\n${escapeSlack(location)}` },
    { type: 'mrkdwn', text: `*Status*\n${escapeSlack(definition.phase)}` }
  ];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: definition.title.slice(0, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: escapeSlack(message) }, fields }
  ];
  if (env.DASHBOARD_URL) {
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open IDS dashboard' }, url: env.DASHBOARD_URL }] });
  }
  const response = await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `${definition.title}: ${message}`,
      attachments: [{ color, blocks }]
    })
  });
  if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}`);
}

function escapeSlack(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function publishNtfy(env, definition, message) {
  if (!env.NTFY_TOPIC) throw new Error('NTFY_TOPIC secret is not configured');
  const base = (env.NTFY_BASE_URL || 'https://ntfy.sh').replace(/\/$/, '');
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Title': definition.title,
    'Priority': definition.severity === 'urgent' ? '5' : definition.severity === 'warning' ? '4' : '3',
    'Tags': definition.tags
  };
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  if (env.DASHBOARD_URL) headers.Click = env.DASHBOARD_URL;
  const response = await fetch(`${base}/${encodeURIComponent(env.NTFY_TOPIC)}`, {
    method: 'POST', headers, body: message
  });
  if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status}`);
}

async function listEvents(request, env, url) {
  const requested = Number.parseInt(url.searchParams.get('limit') || '50', 10);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 50, 1), 200);
  const result = await env.DB.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return json({ events: result.results || [] }, 200, request, env);
}

async function getStatus(request, env) {
  const [states, latest, deviceRows] = await Promise.all([
    env.DB.prepare(`SELECT s.device_id, s.alert_key, s.active, s.updated_at, s.latest_event_id,
      e.system_id, e.event_type, e.title, e.message, e.severity, e.acknowledged_at, e.acknowledged_by
      FROM alert_states s JOIN events e ON e.id = s.latest_event_id
      ORDER BY s.device_id, s.alert_key`).all(),
    env.DB.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 20').all(),
    env.DB.prepare('SELECT * FROM device_status ORDER BY updated_at DESC').all()
  ]);
  const devices = (deviceRows.results || []).map(row => {
    let telemetry = {};
    try { telemetry = JSON.parse(row.telemetry_json || '{}'); } catch (_) { /* retain empty telemetry */ }
    return { ...row, telemetry, telemetry_json: undefined };
  });
  return json({ states: states.results || [], events: latest.results || [], devices, generatedAt: new Date().toISOString() }, 200, request, env);
}

async function acknowledgeEvent(request, env, id) {
  let body = {};
  try { body = await request.json(); } catch (_) { /* acknowledgement body is optional */ }
  const actor = clean(body.by, 80, true) || 'remote viewer';
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE events SET
    acknowledged_at = COALESCE(acknowledged_at, ?),
    acknowledged_by = COALESCE(acknowledged_by, ?)
    WHERE id = ?`).bind(now, actor, id).run();
  if (!result.meta?.changes) return json({ error: 'Event not found' }, 404, request, env);
  const event = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  return json({ event }, 200, request, env);
}

async function recordDirectDelivery(request, env, id) {
  const result = await env.DB.prepare(`UPDATE events SET
    notification_status = 'sent-direct', notification_error = NULL
    WHERE id = ? AND notification_status = 'failed'`).bind(id).run();
  if (!result.meta?.changes) return json({ error: 'Failed event not found' }, 404, request, env);
  const event = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  return json({ event }, 200, request, env);
}

function defaultMessage(type, location) {
  const messages = {
    weir_ovf_active: `Weir overflow float activated on ${location}. Check the ink delivery system.`,
    weir_ovf_recovered: `Weir overflow float returned to normal on ${location}.`,
    supply_ovf_active: `Supply overflow float activated on ${location}. Check the ink supply immediately.`,
    supply_ovf_recovered: `Supply overflow float returned to normal on ${location}.`,
    firmware_alarm_active: `The IDS firmware reported an active alarm on ${location}. Check the controller.`,
    firmware_alarm_recovered: `The IDS firmware alarm cleared on ${location}.`,
    controller_disconnected: `The IDS controller disconnected from ${location}.`,
    controller_reconnected: `The IDS controller reconnected to ${location}.`,
    data_stale: `No fresh IDS telemetry has been received from ${location}.`,
    data_recovered: `IDS telemetry resumed from ${location}.`,
    test: `Test alert received from ${location}. Cloudflare Worker and ntfy delivery are working.`
  };
  return messages[type];
}

function clean(value, max, nullable = false) {
  if (value === undefined || value === null || value === '') return nullable ? null : '';
  return String(value).trim().slice(0, max);
}

async function authorized(request, expected) {
  if (!expected) return false;
  const header = request.headers.get('Authorization') || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!supplied) return false;
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  return constantTimeEqual(a, b);
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  return allowedOrigins(env).includes(origin);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
  if (origin && allowedOrigins(env).includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function corsPreflight(request, env) {
  if (!originAllowed(request, env)) return json({ error: 'Origin not allowed' }, 403, request, env);
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function unauthorized(request, env) {
  return json({ error: 'Unauthorized' }, 401, request, env);
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request, env) }
  });
}

export { EVENT_DEFINITIONS, route };
