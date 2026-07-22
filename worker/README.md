# IDS alert relay

This Cloudflare Worker accepts authenticated state transitions from the IDS UI,
stores them in D1, and sends mobile push notifications through ntfy. The public
GitHub Pages app never receives the ntfy topic or ntfy access token.

Supported operational alerts are Weir overflow, Supply overflow, firmware alarm,
unexpected controller disconnect, and stale telemetry. Each condition is stored as
an active/recovered state, so repeated device frames do not generate repeated push
notifications.

Production relay: `https://ids-alert-relay.mattlmccoy.workers.dev`

## Required Worker secrets

- `DEVICE_TOKEN`: write-only credential copied into each lab computer's IDS settings.
- `VIEWER_TOKEN`: read/acknowledge credential copied into trusted remote dashboards.
- `NTFY_TOPIC`: long, randomly generated ntfy topic name.
- `NTFY_TOKEN`: optional ntfy access token. Anonymous ntfy.sh requests from
  Cloudflare's shared egress can be rate-limited, so the UI also supports a
  direct free fallback with the topic stored only in the lab browser.

Generate each credential independently with a password manager or
`openssl rand -hex 32`. Never commit these values.

## Deploy

```sh
wrangler login
wrangler d1 create ids-alerts --config worker/wrangler.jsonc
wrangler d1 migrations apply ids-alerts --remote --config worker/wrangler.jsonc
wrangler secret put DEVICE_TOKEN --config worker/wrangler.jsonc
wrangler secret put VIEWER_TOKEN --config worker/wrangler.jsonc
wrangler secret put NTFY_TOPIC --config worker/wrangler.jsonc
wrangler secret put NTFY_TOKEN --config worker/wrangler.jsonc
wrangler deploy --config worker/wrangler.jsonc
```

The D1 create command adds the generated `database_id` to the Wrangler config.
Omit `NTFY_TOKEN` only when using an unprotected, hard-to-guess ntfy.sh topic.

For local development, add the same names to `worker/.dev.vars` (gitignored),
apply the migration with `--local`, then run `wrangler dev --config worker/wrangler.jsonc`.
