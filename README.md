# Radio Frequency AM Ink Delivery System

Desktop UI for the Radio Frequency AM Ink Delivery System (derived from APS Engineering NANO_SINGLE_GUI_R17_RELEASE).

## Quick Start (Electron App)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the app:
   ```bash
npm run start
```

## Quick Start (Local Server + Chrome)

1. Start a local server:
   ```bash
   python3 -m http.server 8080
   ```
2. Open Chrome/Edge:
   ```
   http://localhost:8080
   ```

Notes:
- Web Serial requires Chrome or Edge.
- If you skip the local server and open `index.html` directly, modules may not load.

## Build Installers (macOS / Windows / Linux)

```bash
npm run dist
```

Artifacts are produced in `dist/`:
- macOS: `.dmg` / `.zip`
- Windows: `.exe` (NSIS) / `.zip`
- Linux: `.AppImage` / `.deb`

## Notes

- Web Serial support is required. The Electron build enables the Serial feature flag.
- Vendor assets (Bootstrap, Chart.js, etc.) are copied locally via `npm run copy-vendor`.

## Screenshots

![Operation (Dark)](screenshots/operation-dark.png)
![Monitor](screenshots/monitor.png)
![Settings](screenshots/settings.png)
![Trending](screenshots/trending.png)
![Event Log](screenshots/event-log.png)
![Operation (Light)](screenshots/operation-light.png)
