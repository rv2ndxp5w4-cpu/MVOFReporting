let state = {
  assets: [],
  filtered: [],
  selectedId: null,
  editMode: false,
  timelineExpanded: {},
  timelinePage: {},
};

const els = {
  list: document.getElementById("assetList"),
  detail: document.getElementById("detail"),
  summary: document.getElementById("summary"),
  manualPanel: document.getElementById("manualPanel"),
  search: document.getElementById("search"),
  section: document.getElementById("sectionFilter"),
  trend: document.getElementById("trendFilter"),
  reporting: document.getElementById("reportingFilter"),
};

const isLocalRuntime = ["127.0.0.1", "localhost"].includes(window.location.hostname);

function usd(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "n/a";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(v));
}

function latestTimelineEvent(asset) {
  const timeline = [...(asset.timeline || [])].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return timeline.find((ev) => ev.summary || ev.label) || timeline[0] || null;
}

function buildSummaryText(asset) {
  const latest = latestTimelineEvent(asset);
  const identity = `${asset.canonical_name || asset.name} is tracked as a ${asset.section || "portfolio"} exposure` +
    (asset.underlying_asset ? ` with underlying asset ${asset.underlying_asset}` : "") +
    (asset.geography ? ` in ${asset.geography}` : "") + ".";

  let traction = "Traction is currently stable versus the 2023 baseline.";
  const diff = Number(asset.diff_2025_vs_2023_usd);
  if (!Number.isNaN(diff)) {
    if (diff > 0) traction = `Latest measured traction is positive at ${usd(diff)} vs 1Q 2023.`;
    if (diff < 0) traction = `Latest measured traction is down by ${usd(diff)} vs 1Q 2023.`;
  }

  let sourceLine = "No recent imported narrative is available yet.";
  if (latest) {
    const sourceName = latest.source ? ` Source: ${latest.source}.` : "";
    const narrative = latest.summary || latest.label || "Latest timeline event recorded.";
    sourceLine = `Latest context (${latest.date || "n/a"}): ${narrative}.${sourceName}`;
  }

  return [identity, traction, sourceLine].join(" ");
}

function buildCompanySnapshot(asset) {
  if (asset.company_snapshot_override && asset.company_snapshot_override.trim()) return asset.company_snapshot_override.trim();
  if (asset.company_snapshot_sheet2 && asset.company_snapshot_sheet2.trim()) return asset.company_snapshot_sheet2.trim();
  if (asset.section !== "companies") return "No snapshot available for this asset type.";

  const desc = (asset.description || "").trim();
  const diff = Number(asset.diff_2025_vs_2023_usd);
  let trendLine = "Valuation trend is stable versus 1Q 2023.";
  if (!Number.isNaN(diff)) {
    if (diff > 0) trendLine = `Valuation trend is positive versus 1Q 2023 (${usd(diff)}).`;
    if (diff < 0) trendLine = `Valuation trend is negative versus 1Q 2023 (${usd(diff)}).`;
  }

  const timeline = [...(asset.timeline || [])].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const collected = [];
  const seen = new Set();
  for (const ev of timeline) {
    const text = (ev.summary || ev.label || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    collected.push(text);
    if (collected.length >= 3) break;
  }

  const market = (asset.latest_market_info_external || "").trim();
  const parts = [
    `${asset.canonical_name || asset.name}${asset.geography ? ` (${asset.geography})` : ""}.`,
    desc ? `${desc}.` : "",
    trendLine,
    collected.length ? `Latest documented signals: ${collected.join(" ")}` : "",
    market ? `External market info: ${market}` : "",
  ].filter(Boolean);

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

async function loadAssets() {
  const params = new URLSearchParams();
  if (els.search.value.trim()) params.set("search", els.search.value.trim());
  if (els.section.value) params.set("section", els.section.value);
  if (els.reporting.value) params.set("reporting", els.reporting.value);

  const res = await fetch(`/api/assets?${params.toString()}`);
  if (!res.ok) {
    els.list.innerHTML = "<div class='asset-item'>Failed to load assets.</div>";
    return;
  }
  const payload = await res.json();
  state.assets = payload.assets || [];
  applyTrendFilter();
  if (!state.selectedId && state.assets.length) state.selectedId = state.assets[0].id;
  if (state.selectedId && !state.filtered.find((a) => a.id === state.selectedId)) state.selectedId = state.filtered[0]?.id || null;
  updateTrendFilterLabels();
  renderSummary();
  renderList();
  renderDetail();
  renderManualPanel();
}

function applyTrendFilter() {
  const trend = (els.trend.value || "").trim();
  const inTrendUniverse = (a) => Number(a.market_value_usd || 0) > 0;
  if (!trend) {
    state.filtered = [...state.assets];
    return;
  }
  if (trend === "decline") {
    state.filtered = state.assets.filter((a) => inTrendUniverse(a) && (a.trend || "stable") === "decline");
    return;
  }
  state.filtered = state.assets.filter((a) => inTrendUniverse(a) && (a.trend || "stable") === trend);
}

function updateTrendFilterLabels() {
  const inTrendUniverse = (a) => Number(a.market_value_usd || 0) > 0;
  const growers = state.assets.filter((a) => inTrendUniverse(a) && a.value_grower).length;
  const sliders = state.assets.filter((a) => inTrendUniverse(a) && a.major_slider).length;
  const clarifications = state.assets.filter((a) => inTrendUniverse(a) && a.clarification_status === "Clarification needed" && !a.resolved).length;
  const total = state.assets.length;

  const allOpt = els.trend.querySelector('option[value=""]');
  const growthOpt = els.trend.querySelector('option[value="growth"]');
  const declineOpt = els.trend.querySelector('option[value="decline"]');
  const stableOpt = els.trend.querySelector('option[value="stable"]');
  if (allOpt) allOpt.textContent = `All trends (${total})`;
  if (growthOpt) growthOpt.textContent = `Growth (${growers})`;
  if (declineOpt) declineOpt.textContent = `Decline (${sliders})`;
  if (stableOpt) stableOpt.textContent = `Stable (${clarifications})`;
}

function selectedAsset() {
  return state.filtered.find((a) => a.id === state.selectedId) || null;
}

function renderSummary() {
  const total = state.filtered.length;
  const sectionCurrentValue = (section) => state.filtered
    .filter((a) => a.section === section)
    .reduce((sum, a) => sum + (Number(a.market_value_usd) || 0), 0);

  const totalOriginalInvestment = state.filtered.reduce((sum, a) => sum + (Number(a.original_investment_usd) || 0), 0);
  const total2023 = state.filtered.reduce((sum, a) => sum + (Number(a.value_2023_usd) || 0), 0);

  const companiesCurrent = sectionCurrentValue("companies");
  const fundsCurrent = sectionCurrentValue("funds");
  const loansCurrent = sectionCurrentValue("loans");
  const totalCurrent = companiesCurrent + fundsCurrent + loansCurrent;

  els.summary.innerHTML = `
    <strong>${total}</strong> assets in view
    <br />Original investment: <strong>${usd(totalOriginalInvestment)}</strong>
    <br />1Q 2023 value - Total: <strong>${usd(total2023)}</strong>
    <br />Current value - Total (All): <strong>${usd(totalCurrent)}</strong>
    <br />Of them
    <br />Current value - Companies: <strong>${usd(companiesCurrent)}</strong>
    <br />Current value - Funds: <strong>${usd(fundsCurrent)}</strong>
    <br />Current value - Loans: <strong>${usd(loansCurrent)}</strong>
  `;
}

function itemTags(asset) {
  if (asset.section === "writeoffs") {
    return '<span class="tag decline">write-off</span>';
  }
  const tags = [];
  tags.push(`<span class="tag ${asset.trend || ""}">${asset.trend || "stable"}</span>`);
  if (asset.major_slider) tags.push('<span class="tag decline">major slider</span>');
  if (asset.clarification_status === "Clarification needed" && !asset.resolved) tags.push('<span class="tag clarify">Clarification needed</span>');
  if (asset.resolved) tags.push('<span class="tag growth">resolved</span>');
  return tags.join("");
}

function renderList() {
  els.list.innerHTML = state.filtered
    .map(
      (asset) => `
      <article class="asset-item ${asset.id === state.selectedId ? "active" : ""}" data-id="${asset.id}">
        <div class="asset-name">${asset.canonical_name || asset.name}</div>
        <div class="asset-meta">${asset.section} | underlying: ${asset.underlying_asset || "n/a"}</div>
        <div class="asset-meta">Diff (2025 vs 2023): ${usd(asset.diff_2025_vs_2023_usd)}</div>
        <div class="tag-row">${itemTags(asset)}</div>
      </article>
    `
    )
    .join("");

  els.list.querySelectorAll(".asset-item").forEach((node) => {
    node.addEventListener("click", () => {
      state.selectedId = node.getAttribute("data-id");
      renderList();
      renderDetail();
      renderManualPanel();
    });
  });
}

function renderTimeline(asset) {
  const all = [...(asset.timeline || [])];
  const expanded = !!state.timelineExpanded[asset.id];
  const pageSize = 6;
  const currentPage = state.timelinePage[asset.id] || 1;

  let shown = all.slice(0, 4);
  let pagination = "";

  if (expanded) {
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const page = Math.min(currentPage, totalPages);
    state.timelinePage[asset.id] = page;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    shown = all.slice(start, end);

    if (totalPages > 1) {
      pagination = `
        <div class="timeline-pagination">
          <button type="button" class="timeline-page-btn" data-timeline-page="prev" data-asset-id="${asset.id}" ${page <= 1 ? "disabled" : ""}>Prev</button>
          <span>Page ${page} / ${totalPages}</span>
          <button type="button" class="timeline-page-btn" data-timeline-page="next" data-asset-id="${asset.id}" ${page >= totalPages ? "disabled" : ""}>Next</button>
        </div>
      `;
    }
  }

  const rows = shown
    .map(
      (ev) => `
      <li>
        <div class="tdate">${ev.date || "n/a"} | ${ev.reporting_style || "n/a"} | ${ev.event_type || "event"}</div>
        <div class="tlabel">${ev.label || ""}${ev.value_usd !== undefined ? ` (${usd(ev.value_usd)})` : ""}</div>
        <div class="tsource">${ev.source || ""}${ev.summary ? ` | ${ev.summary}` : ""}</div>
      </li>
    `
    )
    .join("");

  return `<ul class="timeline">${rows || "<li>No timeline events yet.</li>"}</ul>${pagination}`;
}

function renderInvestments(asset) {
  const rows = (asset.investments || [])
    .map(
      (inv) => `
      <tr>
        <td>${inv.security_name || "n/a"}</td>
        <td>${inv.instrument_type || "n/a"}</td>
        <td>${inv.series || "-"}</td>
        <td>${inv.share_class || "-"}</td>
        <td>${usd(inv.book_cost_usd)}</td>
        <td>${usd(inv.market_value_usd)}</td>
        <td>${usd(inv.pnl_usd)}</td>
      </tr>
    `
    )
    .join("");

  if (!rows) return "<p>No tranche-level instrument details found in Portfolio Report.</p>";

  return `
    <div class="investments-wrap">
      <table class="investments-table">
        <thead>
          <tr>
            <th>Security / Instrument</th>
            <th>Type</th>
            <th>Series</th>
            <th>Class</th>
            <th>Book</th>
            <th>Value</th>
            <th>P&L</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderDetail() {
  const asset = selectedAsset();
  if (!asset) {
    els.detail.className = "detail empty";
    els.detail.innerHTML = "<p>No asset selected.</p>";
    return;
  }

  els.detail.className = "detail";
  const buildSummary = buildSummaryText(asset);

  els.detail.innerHTML = `
    <div class="detail-head">
      <h2>${asset.canonical_name || asset.name}</h2>
      <div class="detail-date">Investment date: ${asset.investment_date || "n/a"}</div>
    </div>
    <div class="build-summary"><p>${buildSummary}</p></div>
    <div class="sub">Original line item: ${asset.name} | underlying tracked: ${asset.underlying_asset || "n/a"}</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Original investment</div><div class="value">${usd(asset.original_investment_usd)}</div></div>
      <div class="kpi"><div class="label">Value 1Q 2023</div><div class="value">${usd(asset.value_2023_usd)}</div></div>
      <div class="kpi"><div class="label">Market value</div><div class="value">${usd(asset.market_value_usd)}</div></div>
      <div class="kpi"><div class="label">P&L</div><div class="value">${usd(asset.pnl_usd)}</div></div>
      <div class="kpi"><div class="label">Diff 2025 vs 2023</div><div class="value">${usd(asset.diff_2025_vs_2023_usd)}</div></div>
    </div>

    <div class="section-title">Company Snapshot</div>
    <p>${buildCompanySnapshot(asset)}</p>

    <div class="section-title">Latest Market Info: Externally Sourced Information</div>
    <p>${asset.latest_market_info_external || "No external market note currently captured for this asset."}</p>

    <div class="section-title">Investment Terms / Tranches</div>
    ${renderInvestments(asset)}

    <div class="section-title">Decline Rationale</div>
    <p>${asset.decline_reason || "n/a"}</p>

    <div class="section-title section-inline">Data Available <button type="button" class="timeline-toggle" data-timeline-toggle="${asset.id}">${state.timelineExpanded[asset.id] ? "Collapse" : "Expand"}</button></div>
    ${renderTimeline(asset)}
  `;

  bindDetailInteractions();
}

function renderManualPanel() {
  if (!isLocalRuntime) {
    if (els.manualPanel) els.manualPanel.innerHTML = "";
    return;
  }

  const asset = selectedAsset();
  if (!asset) {
    els.manualPanel.innerHTML = "";
    return;
  }

  const snapshotValue = asset.company_snapshot_override || "";
  const readOnly = state.editMode ? "" : "disabled";

  els.manualPanel.innerHTML = `
    <div class="panel manual-master">
      <h4>Manual Actions</h4>
      <button type="button" id="toggleEditBtn">${state.editMode ? "Stop Editing" : "Edit"}</button>
      <p class="manual-note">Selected: ${asset.canonical_name || asset.name}</p>
    </div>

    <form id="snapshotForm" class="panel">
      <h4>Company Snapshot Override</h4>
      <textarea name="company_snapshot_override" rows="5" placeholder="Enter manual company snapshot text" ${readOnly}>${snapshotValue}</textarea>
      <button type="submit" ${readOnly}>Save Snapshot</button>
    </form>

    <form id="renameForm" class="panel">
      <h4>Rename / Underlying</h4>
      <input name="canonical_name" placeholder="Canonical research name" value="${asset.canonical_name || ""}" ${readOnly} />
      <input name="underlying_asset" placeholder="Underlying asset" value="${asset.underlying_asset || ""}" ${readOnly} />
      <input name="alias" placeholder="Add alias (optional)" ${readOnly} />
      <label><input type="checkbox" name="resolved" ${asset.resolved ? "checked" : ""} ${readOnly}/> Mark clarification resolved</label>
      <button type="submit" ${readOnly}>Save mapping</button>
    </form>

    <form id="eventForm" class="panel">
      <h4>Add Timeline Event</h4>
      <input name="date" type="date" ${readOnly} />
      <input name="label" placeholder="Event label" required ${readOnly} />
      <select name="event_type" ${readOnly}>
        <option value="note">Note</option>
        <option value="rename">Rename</option>
        <option value="acquisition">Acquisition</option>
        <option value="valuation">Valuation</option>
        <option value="analysis">Analysis</option>
      </select>
      <select name="reporting_style" ${readOnly}>
        <option value="quarter">Quarter</option>
        <option value="half-year">Half-year</option>
        <option value="full-year" selected>Full-year</option>
      </select>
      <input name="source" placeholder="Source" value="Manual input" ${readOnly} />
      <input name="value_usd" type="number" step="0.01" placeholder="Value USD (optional)" ${readOnly} />
      <button type="submit" ${readOnly}>Add event</button>
    </form>

    <form id="importForm" class="panel">
      <h4>Import Source by Path</h4>
      <input name="source_path" placeholder="/absolute/path/to/file.txt" required ${readOnly} />
      <input name="date" type="date" ${readOnly} />
      <input name="label" placeholder="Label (optional)" ${readOnly} />
      <select name="event_type" ${readOnly}>
        <option value="import">Import</option>
        <option value="analysis">Analysis</option>
        <option value="note">Note</option>
      </select>
      <select name="reporting_style" ${readOnly}>
        <option value="quarter">Quarter</option>
        <option value="half-year">Half-year</option>
        <option value="full-year" selected>Full-year</option>
      </select>
      <button type="submit" ${readOnly}>Import source</button>
    </form>
  `;

  bindManualForms(asset.id);
}

function formJson(form) {
  const fd = new FormData(form);
  const out = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v === "string") out[k] = v.trim();
  }
  const resolved = form.querySelector("input[name='resolved']");
  if (resolved) out.resolved = resolved.checked;
  return out;
}

function bindDetailInteractions() {
  const toggle = els.detail.querySelector("[data-timeline-toggle]");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const id = toggle.getAttribute("data-timeline-toggle");
      const next = !state.timelineExpanded[id];
      state.timelineExpanded[id] = next;
      state.timelinePage[id] = 1;
      renderDetail();
    });
  }

  els.detail.querySelectorAll("[data-timeline-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const assetId = btn.getAttribute("data-asset-id");
      const dir = btn.getAttribute("data-timeline-page");
      const current = state.timelinePage[assetId] || 1;
      state.timelinePage[assetId] = dir === "next" ? current + 1 : Math.max(1, current - 1);
      renderDetail();
    });
  });
}

function bindManualForms(assetId) {
  const toggleEditBtn = document.getElementById("toggleEditBtn");
  const snapshotForm = document.getElementById("snapshotForm");
  const renameForm = document.getElementById("renameForm");
  const eventForm = document.getElementById("eventForm");
  const importForm = document.getElementById("importForm");

  toggleEditBtn?.addEventListener("click", () => {
    state.editMode = !state.editMode;
    renderManualPanel();
  });

  snapshotForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.editMode) return;
    const payload = formJson(snapshotForm);
    await fetch(`/api/assets/${assetId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadAssets();
  });

  renameForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.editMode) return;
    const payload = formJson(renameForm);
    await fetch(`/api/assets/${assetId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadAssets();
  });

  eventForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.editMode) return;
    const payload = formJson(eventForm);
    await fetch(`/api/assets/${assetId}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadAssets();
  });

  importForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.editMode) return;
    const payload = formJson(importForm);
    payload.asset_id = assetId;
    const res = await fetch(`/api/import-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Import failed");
      return;
    }
    await loadAssets();
  });
}

function bindFilterEvents() {
  [els.search, els.section, els.trend, els.reporting].forEach((node) => {
    node.addEventListener("input", () => {
      if (node === els.trend) {
        applyTrendFilter();
        renderSummary();
        renderList();
        renderDetail();
        renderManualPanel();
      } else {
        loadAssets();
      }
    });
    node.addEventListener("change", () => {
      if (node === els.trend) {
        applyTrendFilter();
        renderSummary();
        renderList();
        renderDetail();
        renderManualPanel();
      } else {
        loadAssets();
      }
    });
  });
}

if (!isLocalRuntime && els.manualPanel) els.manualPanel.style.display = "none";

bindFilterEvents();
loadAssets();
