ProPresenter Sync — Working Notes
=================================

Config & IDs
------------
- ProPresenter host/port: stored in localStorage via Connections page.
- Playlist (Sunday Service) UUID: B2826453-1806-4A3B-8A0D-BA4B71995E2D
- Library UUID: 1A69F024-6ABC-467B-A698-FAF558AB6627
- PCO env: PCO_APP_ID, PCO_SECRET, PCO_SERVICE_TYPE_ID (loader checks .env, src/.env, src/lib/.env)

What’s working
--------------
- Matching plan items to ProPresenter library:
  - Uses /v1/libraries (UUID) and /v1/library/{uuid} (items with uuid + name)
  - Case-insensitive title match; strips (...) and [...]
  - Alias: “closing worship (song)” → “closing worship”
- Plan Preview:
  - Shows Matched / Not found per item; displays item length mm:ss; headers styled
- Playlist Sync:
  - Finds or creates “Sunday Service” by normalized name
  - Compares current vs desired sequence (presentations as p:<uuid>, headers as h:<normalized name>)
  - If different, replaces via PUT /v1/playlist/{playlist_uuid} with top-level JSON array
  - Item shapes sent:
    - Presentation: { id: { uuid: PRESENTATION_UUID }, type: "presentation" }
    - Header: { id: { uuid: null, name: NAME, index: ORDER }, type: "header", header_color: { red:0, green:0.54, blue:0.87, alpha:1 } }
  - Dashboard has Sync + Re-sync buttons; status pill: Up to date / Synced / Failed (status) / No items to sync
- PCO integration:
  - Test Connection via Services v2 Basic auth (env)
  - Run Sunday Prep fetches next plan and streams logs

Handy checks
------------
- GET playlist: http://localhost:1025/v1/playlist/B2826453-1806-4A3B-8A0D-BA4B71995E2D
- Replace with one item (example): PUT body is a JSON array like
  [ { id: { uuid: "7D06813F-B573-4A01-B2C4-8DD686DD7A1C" }, type: "presentation" } ]

Next steps / TODO
-----------------
- Sync robustness: optional fallback (PUT [] then POST append per item) if PUT fails
- Tooltips for Not found explaining normalized title
- Persist simple settings (e.g., default playlist name) to userData

Notes
-----
- ProPresenter expects a top-level JSON array for playlist replace; not { items: [...] }
- Presentations must reference uuid at id.uuid; headers use id.name and index with uuid: null
