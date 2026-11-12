# Sauna Control

A web app you can install to your Home Screen, for running the backyard sauna (Harvia Fenix FX45 + IKI Pillar 9 kW) through Harvia's cloud API. It runs as a Cloudflare Worker with a Durable Object and D1. Built from *Sauna Control Web App — Brief* (Nov 7, 2026).

## Run locally (simulated controller)

```bash
npm install
npm run vapid          # paste both lines into .dev.vars
npm run dev            # http://localhost:8787
```

`.dev.vars` needs `OWNER_PASSPHRASE`, `SESSION_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`. With `HARVIA_MOCK=1`, the room heats about 20× faster than real life (`MOCK_SPEED`), and Control shows simulator buttons (drop offline, poll now).

```bash
npm test               # preheat model + push encryption (checked against the reference http_ece decryptor)
npm run typecheck
```

## Deploy

1. `npx wrangler d1 create sauna` → paste the `database_id` into `wrangler.jsonc`. Tables are created automatically on the first request.
2. In `wrangler.jsonc`, set `HARVIA_MOCK` to `"0"`.
3. Secrets: `npx wrangler secret put` for each of `OWNER_PASSPHRASE`, `SESSION_SECRET`, `HARVIA_USERNAME`, `HARVIA_PASSWORD`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
4. `npm run deploy`.
5. On the iPhone, open the site, sign in, use Share → Add to Home Screen, then go to Settings → *Get owner alerts on this phone*.
6. Send friends `https://<your-worker>/status`.

## Map the controller fields (first real run)

Harvia's public docs don't name the Fenix shadow fields for "heater on" and "target". After deploying, open `/api/debug/harvia` while signed in. If the heater state or target shows up under a key not listed in `HEATER_KEYS` / `TARGET_KEYS` in `src/harvia.ts`, add it there. Until the heater state is recognised, the "controller ended the session" detection stays off, but nothing else breaks.

## What the Harvia docs (harvia.io/api, v0.5.0) settled

- Login: `POST {generics}/auth/token` returns Cognito tokens valid for 1 hour, and `/auth/refresh` renews them. Base URLs come from `GET https://api.harvia.io/endpoints`.
- Start/stop: `POST {device}/devices/command` with `{ command: { type: "SAUNA", state: "on" | "off" } }`. It waits for the device to acknowledge and returns **504 "Device unavailable"** if the controller is offline.
- Target: `PATCH {device}/devices/target` with `temperature` (and optionally humidity).
- Readings: `GET {data}/data/latest-data` returns `temperature` **and `humidity`**. The examples look like **°C**, so the app converts (`HARVIA_UNITS`).
- Session length: there are `ADJUST_DURATION` / `REMAINING_TIME` commands. The FX45 gives at most 60 min per command, so the app sends `ADJUST_DURATION` 60 at start (with the controller's max on-time set to 3 h in the Harvia app) and ends the session itself after an hour at temperature.
- There's no documented "ready at" / smart-timer endpoint.

## Still open from the brief's "To verify"

- FX45 maximum on-time in North American configuration, and whether preheat counts against it.
- How often readings update. The app polls every 30 s during a session.
- Whether humidity is a real sensor on the FX45. It's shown during bake-out, but bake-out is still time-based.
- Harvia API terms for personal self-hosted use.
- Whether the sauna Wi-Fi holds through a full session.

## Differences from the brief

- **Live data uses 30 s polling from a Durable Object alarm, not the AppSync WebSocket feed.** Polling meets the "ETA updated at least once a minute" target and is simpler to keep alive. The WebSocket feed can be added later.
- **Bake-out set while scheduling starts automatically** when the session hits its time limit. You confirm the vent instruction when you schedule it, because nobody is there to tap a prompt.
- Added a safety cap: if the room never reaches temperature, the heater stops after 2.5 h of preheat and you get an alert.
