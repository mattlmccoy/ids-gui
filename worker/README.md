# IDS alert relay

This Cloudflare Worker accepts authenticated state transitions from the IDS UI,
stores them in D1, and sends mobile push notifications through ntfy. The public
GitHub Pages app never receives the ntfy topic or ntfy access token.

Supported operational alerts are Weir overflow, Supply overflow, firmware alarm,
unexpected controller disconnect, and stale telemetry. Each condition is stored as
an active/recovered state, so repeated device frames do not generate repeated push
notifications.

When remote alerts are enabled, the lab page also publishes an allowlisted,
read-only telemetry snapshot every two seconds. The mobile dashboard receives
system state, modes, primary sensors, floats, alarm status, and freshness through
the viewer-authenticated status endpoint. Arbitrary controller fields are not accepted.

## Guarded remote control

The mobile page may queue only `run`, `stop`, `set_vacuum`, `set_flow`, and
`set_temperature`. Commands require `OPERATOR_TOKEN`, expire after 15 seconds,
and are atomically claimed before execution. The USB desktop ignores the queue
unless a local operator enables a 30-minute control window while connected. The
desktop validates ranges, writes one allowlisted firmware payload, records whether
the expected serial readback appeared, and acknowledges the result. Cloud Stop is
not a safety-rated emergency stop.

Production relay: `https://ids-alert-relay.mattlmccoy.workers.dev`

## Required Worker secrets

- `DEVICE_TOKEN`: write-only credential copied into each lab computer's IDS settings.
- `VIEWER_TOKEN`: read/acknowledge credential copied into trusted remote dashboards.
- `OPERATOR_TOKEN`: separate mobile-control credential. Never reuse `VIEWER_TOKEN`
  or `DEVICE_TOKEN`; only trusted operators should receive it.
- `NTFY_TOPIC`: long, randomly generated ntfy topic name.
- `NTFY_TOKEN`: optional ntfy access token. Anonymous ntfy.sh requests from
  Cloudflare's shared egress can be rate-limited, so the UI also supports a
  direct free fallback with the topic stored only in the lab browser.
- `SLACK_WEBHOOK_URL`: optional Slack Incoming Webhook URL. Keep it only as a
  Worker secret; it is never returned to either browser UI.

Generate each credential independently with a password manager or
`openssl rand -hex 32`. Never commit these values.

## Deploy

```sh
wrangler login
wrangler d1 create ids-alerts --config worker/wrangler.jsonc
wrangler d1 migrations apply ids-alerts --remote --config worker/wrangler.jsonc
wrangler secret put DEVICE_TOKEN --config worker/wrangler.jsonc
wrangler secret put VIEWER_TOKEN --config worker/wrangler.jsonc
wrangler secret put OPERATOR_TOKEN --config worker/wrangler.jsonc
wrangler secret put NTFY_TOPIC --config worker/wrangler.jsonc
wrangler secret put NTFY_TOKEN --config worker/wrangler.jsonc
wrangler secret put SLACK_WEBHOOK_URL --config worker/wrangler.jsonc
wrangler deploy --config worker/wrangler.jsonc
```

The D1 create command adds the generated `database_id` to the Wrangler config.
Omit `NTFY_TOKEN` only when using an unprotected, hard-to-guess ntfy.sh topic.
Cloudflare egress addresses are shared and anonymous publishing can receive HTTP
429 rate limits. For unattended lab alerts, an authenticated ntfy account/token
is strongly recommended. The browser's private-topic fallback is best-effort and
requires the IDS page to remain open.
Omit `SLACK_WEBHOOK_URL` when Slack delivery is not desired. Slack failures do
not prevent ntfy delivery, and duplicate state transitions are suppressed before
either channel is called.

For local development, add the same names to `worker/.dev.vars` (gitignored),
apply the migration with `--local`, then run `wrangler dev --config worker/wrangler.jsonc`.
