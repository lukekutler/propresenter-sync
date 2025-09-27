
# ProPresenter Sync — Starter

## Quick Start
```bash
# If you use Volta (recommended)
volta install node@22
volta install pnpm

# Or with corepack
# corepack enable
# corepack prepare pnpm@latest --activate

pnpm install
pnpm dev
```

- Electron + React + Vite + Tailwind scaffold
- IPC bridge exposing `runSundayPrep` and `testProPresenter`
- Drizzle + better-sqlite3 wiring (schema ready)

## Next
- Implement ProPresenter TCP API (port 1025) and playlist build.
- Persist logs to SQLite and surface in Logs tab.
- Add Planning Center auth + plan ingest UI.
