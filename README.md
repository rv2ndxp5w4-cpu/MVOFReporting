# MVOF Reporting Engine

Private portfolio reporting dashboard for MVOF, focused on traction tracking across quarter / half-year / full-year reporting, with timeline history and instrument-level investment breakdowns.

## Data Sources
- `/Users/danielgusev/Library/CloudStorage/Dropbox/MVOF Fund audit/MVOF Master with Dec2025 valuations.xlsx`
- `/Users/danielgusev/Library/CloudStorage/Dropbox/MVOF Fund audit/MVOF 2026 Update.pptx`
- `/Users/danielgusev/Library/CloudStorage/Dropbox/MVOF Fund audit` (historical ingest folder)

## Run
```bash
cd '/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting'
python3 scripts/build_dataset.py
python3 scripts/ingest_history.py
python3 server.py
```

Open: `http://127.0.0.1:8787`

## Features
- Portfolio list with filters by section, trend, and reporting style.
- Right-panel company/fund detail with reverse-chronological timeline.
- Instrument/tranche-level breakdown sourced from Portfolio Report.
- Canonical/alias/underlying-asset mapping support.
- Clarification workflow for unchanged assets.
- Manual event and metadata updates.

## Key Files
- `/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting/server.py`
- `/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting/scripts/build_dataset.py`
- `/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting/scripts/ingest_history.py`
- `/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting/data/base_assets.json`
- `/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting/data/manual_updates.json`
- `/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting/data/canonical_overrides.json`
- `/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting/web/index.html`
- `/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting/web/app.js`
- `/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting/web/styles.css`
- `/Users/danielgusev/Library/Mobile Documents/com~apple~CloudDocs/MVOF Reporting/web/login.html`

## Notes
- Historical ingest links local files to tracked assets by alias/name matching.
- For `.pptx`/`.pdf`/binary documents, ingest stores source and summary metadata.
