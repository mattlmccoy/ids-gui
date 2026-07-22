# GitHub Pages Deployment

The hosted browser application will be available at:

<https://mattlmccoy.github.io/ids-gui/>

## What users need locally

Nothing needs to be installed for normal operation.

1. Use current desktop Google Chrome or Microsoft Edge.
2. Open the Pages URL over HTTPS.
3. Connect the IDS controller by USB.
4. Click **Connect** and approve the serial-device prompt.

The hosted page communicates directly with the controller through Web Serial. Safari and Firefox do not currently provide the required Web Serial API. The page must remain open for trending and notifications.

Ink Check data in the hosted version is stored in that browser profile. Export JSON before clearing browser data or moving to another computer. Electron remains an optional fallback for its automatic desktop data file and native file dialogs.

## One-time repository setting

After the deployment workflow is on `main`:

1. Open the repository's **Settings → Pages** page.
2. Under **Build and deployment**, select **GitHub Actions** as the source.
3. Open **Actions → Deploy GitHub Pages** and run it if the push did not trigger it automatically.

The repository must allow GitHub Actions. The workflow already requests only the permissions required to read the code and deploy Pages.

## Updating the application

Every push to `main` runs the software audit, creates a clean static artifact, and deploys it. Users only need to refresh the Pages URL. The navigation bar shows `WEB` plus the first seven characters of the deployed commit so the running version can be confirmed.

The Pages artifact deliberately contains only:

- `index.html`
- `nominal-config.json`
- the sample Ink Check JSON
- `css/`, `js/`, and `vendor/`
- generated deployment metadata

Electron, Node dependencies, source documentation, Git history, and build outputs are not published.

## Local preview of the exact hosted files

```bash
npm ci
npm test
npm run build:pages
python3 -m http.server 8080 --directory _site
```

Then open <http://localhost:8080/> in Chrome or Edge.

## Optional desktop-style installation

Chrome and Edge can create a site shortcut from their menu. A true installable/offline PWA can be added later, but it is not required for controller access and adds cache/update behavior that should be validated on the hardware first.
