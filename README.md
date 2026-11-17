# MVOF Reporting Engine

Private portfolio reporting dashboard for MVOF, focused on traction tracking across quarter / half-year / full-year reporting, with timeline history and instrument-level investment breakdowns.

## Data Sources
- `/Users/danielgusev/Library/CloudStorage/Dropbox/MVOF Fund audit/MVOF Master with Dec2025 valuations.xlsx`
- `/Users/danielgusev/Library/CloudStorage/Dropbox/MVOF Fund audit/MVOF 2026 Update.pptx`
- `/Users/danielgusev/Library/CloudStorage/Dropbox/MVOF Fund audit` (historical ingest folder)

## Run
```bash
cd '/Users/danielgusev/Documents/MVOF reporting'
python3 server.py
```

## November 2026 Import

The November workbook reports valuations as of **30 June 2026**. Research is reviewed separately as of **17 November 2026**. Do not use the filename as the valuation date.

The original December dataset is preserved at `data/valuation_snapshots/2025-12-31.json`. Each asset now holds dated `valuation_history`, including historical tranche records. `original_investment_usd` and the 2023 baseline remain unchanged; current `book_cost_usd` comes from the new report. Book-cost changes are not assumed to be cash contributions or investment returns.

To reproduce this update:

```bash
python3 scripts/import_portfolio_update.py \
  --workbook 'MVOF Master with update Nov26.xlsx' \
  --base data/valuation_snapshots/2025-12-31.json \
  --research data/market_research_2026-11-17.json \
  --output data/base_assets.json \
  --preview-report data/import_preview.json
python3 scripts/test_portfolio_update.py
```

This writes a preview only. Review `data/import_preview.json`, then repeat the import with `--apply` to update the report. An import with unmatched holdings, inconsistent dates or failed market-value controls is rejected. Book-cost exceptions are retained as explicit warnings. After applying, run `python3 scripts/validate_publication.py`; Vercel runs the same validation before deployment. A preview-only or failed import blocks deployment until a successful apply.

## Review Workflow

Assigned NAV always comes from the reconciled workbook. Research, workflow status and cash-flow attribution never replace it. Review resolution does not clear an adverse evidence flag; the research assessment must be revised with new evidence.

The review queue sorts urgent NAV risks first and shows owner, due date and task state. Use the single **Update review tracking (local)** disclosure in the company panel to save ownership, evidence requests and resolution notes. Changes and their history are stored in `data/review_workflow.json`. Production displays this file read-only after publication. Do not enter secrets or unnecessary personal information in review notes.

Sources are classified as official filings, company disclosures, company announcements, independent reporting or secondary directories. Publication/event dates drive source age; access dates do not imply new evidence. Undated evidence stays explicitly unknown. Sources older than 180 days and reviews older than 90 days are flagged for follow-up, not treated as proof of deterioration.

## Performance Attribution

`data/performance_inputs.json` contains one optional record per asset, bound to the previous and current valuation dates. Populate all four USD amounts plus a source: `contributions_usd`, `distributions_usd`, `fx_usd`, `fees_usd`. Contributions, distributions and fees are nonnegative magnitudes; FX may be signed. Only provide zero when confirmed. Unprovided inputs remain `null` and the bridge stays incomplete.

The bridge is: closing NAV = opening NAV + contributions - distributions + FX - fees + residual valuation/other movement. The residual is not an IRR or cash-flow-adjusted return. Original subscribed cost and current book cost are separate measures and must not be used as cash-flow substitutes.

Run `python3 scripts/test_review_workflow.py` for workflow isolation, persistence, source freshness, bridge attribution, preview-only behavior and publication-gate checks.

The importer requires all 28 identities and reconciles both book cost and market value to workbook controls before writing. Summary rows are used once; detail rows remain visible as tranches. Birdly's summary/detail book-cost gap is retained and flagged rather than silently altered. For another workbook layout or new holdings, review the identity mappings and control cells first.

News and NAV assessments are stored separately from reported valuations. Undated sources carry an observation date, not an invented event date. Missing current evidence is explicitly identified. No news-derived revaluation is applied automatically.

The old `build_dataset.py` recreates the initial Sheet2 dataset and must not be used to refresh the June report. The frontend uses `change_since_previous_usd` for trends and `diff_current_vs_2023_usd` for the long-term comparison; the legacy 2025 differential is preserved as history.

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


## Vercel Deploy
- Set environment variable `MVOF_DASHBOARD_PASSWORD` in Vercel Project Settings.
- Optional: set `MVOF_COOKIE_SECRET` for stronger session signing.
- Deploy from GitHub and use the production URL (project kept private by Vercel access settings).
