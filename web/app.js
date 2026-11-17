let state = {
  assets: [],
  filtered: [],
  selectedId: null,
  timelineExpanded: {},
  timelinePage: {},
  importPreview: null,
  requestId: 0,
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
  attention: document.getElementById("attentionFilter"),
  queue: document.getElementById("queueMode"),
  reviewState: document.getElementById("reviewState"),
};

const isLocalRuntime = ["127.0.0.1", "localhost"].includes(window.location.hostname);

function usd(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "n/a";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(v));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function displayDate(value) {
  if (!value) return "Date not supplied";
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {day:"numeric",month:"short",year:"numeric",timeZone:"UTC"});
}

function latestTimelineEvent(asset) {
  const timeline = [...(asset.timeline || [])].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return timeline.find((ev) => ev.summary || ev.label) || timeline[0] || null;
}

function buildSummaryText(asset) {
  if (asset.valuation_as_of) {
    return `${asset.canonical_name || asset.name}: reported value ${usd(asset.market_value_usd)} as of ${displayDate(asset.valuation_as_of)}. Change from ${displayDate(asset.previous_valuation_date)}: ${usd(asset.change_since_previous_usd)}. This is value movement, not a cash-flow-adjusted return. Research reviewed ${displayDate(asset.nav_review?.reviewed_at)}.`;
  }
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
  if (Object.hasOwn(asset, "company_snapshot_sheet2")) return "";
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
  const requestId = ++state.requestId;
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
  if (requestId !== state.requestId) return;
  state.importPreview = payload.import_preview;
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

function attentionLevel(asset) {
  if (asset.nav_risk?.level) return asset.nav_risk.level;
  if (asset.section === "writeoffs" || asset.market_value_usd === 0) return "written-off";
  if (asset.nav_review?.status === "Urgent impairment review") return "urgent";
  if (/review required|reconciliation required/i.test(asset.nav_review?.status || "")) return "review";
  return "evidence";
}

function attentionAssets() {
  const value = els.attention.value;
  return state.assets.filter(a => !value || (value === "attention" ? attentionLevel(a) !== "written-off" : attentionLevel(a) === value));
}

function applyTrendFilter() {
  const trend = els.trend.value;
  state.filtered = attentionAssets().filter(a => (!trend || (Number(a.market_value_usd) > 0 && a.trend === trend))
    && (!els.reviewState.value || (a.review_workflow?.state || "open") === els.reviewState.value)
    && (!els.queue.checked || attentionLevel(a) !== "written-off"));
  const rank = {urgent:0, review:1, evidence:2, "written-off":3};
  state.filtered.sort((a,b) => rank[attentionLevel(a)]-rank[attentionLevel(b)] || (a.review_workflow?.due_date || "9999").localeCompare(b.review_workflow?.due_date || "9999") || a.name.localeCompare(b.name));
  if (!state.filtered.some(a => a.id === state.selectedId)) state.selectedId = state.filtered[0]?.id || null;
}

function updateTrendFilterLabels() {
  const assets = attentionAssets().filter(a => (!els.reviewState.value || (a.review_workflow?.state || "open") === els.reviewState.value) && (!els.queue.checked || attentionLevel(a) !== "written-off"));
  for (const [value, label] of [["", "All valuation movements"], ["growth", "Value increased"], ["decline", "Value decreased"], ["stable", "Value unchanged"]]) {
    const count = assets.filter(a => !value || (Number(a.market_value_usd) > 0 && a.trend === value)).length;
    const option = els.trend.querySelector(`option[value="${value}"]`);
    if (option) option.textContent = `${label} (${count})`;
  }
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
  const previousTotal = state.filtered.reduce((sum, a) => sum + (Number(a.previous_market_value_usd) || 0), 0);
  const currentDates = [...new Set(state.filtered.map(a => a.valuation_as_of).filter(Boolean))];
  const previousDates = [...new Set(state.filtered.map(a => a.previous_valuation_date).filter(Boolean))];

  const companiesCurrent = sectionCurrentValue("companies");
  const fundsCurrent = sectionCurrentValue("funds");
  const loansCurrent = sectionCurrentValue("loans");
  const totalCurrent = companiesCurrent + fundsCurrent + loansCurrent;

  els.summary.innerHTML = `
    <strong>${total}</strong> assets in view
    <div class="summary-value">${usd(totalCurrent)}</div>
    <div class="sub">Assigned NAV as of ${currentDates.length === 1 ? displayDate(currentDates[0]) : "mixed dates"}</div>
    <p>Previous: <strong>${usd(previousTotal)}</strong><br />Change: <strong>${usd(totalCurrent - previousTotal)}</strong></p>
    <details><summary>Investment totals and breakdown</summary>
      <p>Original investment: <strong>${usd(totalOriginalInvestment)}</strong><br />
      1Q 2023: <strong>${usd(total2023)}</strong><br />
      Companies: <strong>${usd(companiesCurrent)}</strong><br />
      Funds: <strong>${usd(fundsCurrent)}</strong><br />
      Loans: <strong>${usd(loansCurrent)}</strong></p>
    </details>
    ${renderImportPreview()}`;
}

function itemTags(asset) {
  if (attentionLevel(asset) === "written-off") return '<span class="tag decline">write-off</span>';
  if (attentionLevel(asset) === "urgent") return '<span class="tag urgent">In administration - impairment review</span>';
  const movement = {growth:"Reported value increased",decline:"Reported value decreased",stable:"Reported value unchanged"}[asset.trend] || "Value movement unavailable";
  return `<span class="tag">${movement}</span><span class="tag clarify">${escapeHtml(asset.nav_review?.status || "Evidence needed")}</span>`;
}

function renderList() {
  const picker = document.getElementById("assetPicker");
  picker.innerHTML = state.filtered.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.canonical_name || a.name)}</option>`).join("");
  picker.value = state.selectedId || "";
  picker.onchange = () => { state.selectedId = picker.value; renderList(); renderDetail(); };
  els.list.innerHTML = state.filtered
    .map(
      (asset) => `
      <article role="button" tabindex="0" aria-pressed="${asset.id === state.selectedId}" class="asset-item ${asset.id === state.selectedId ? "active" : ""}" data-id="${asset.id}">
        <div class="asset-name">${asset.canonical_name || asset.name}</div>
        <div class="asset-meta">${asset.section} | underlying: ${asset.underlying_asset || "n/a"}</div>
        <div class="asset-meta">${asset.valuation_as_of ? `Change vs ${displayDate(asset.previous_valuation_date)}: ${usd(asset.change_since_previous_usd)}` : `Diff (2025 vs 2023): ${usd(asset.diff_2025_vs_2023_usd)}`}</div>
        <div class="tag-row">${itemTags(asset)}</div>
        ${els.queue.checked ? `<div class="asset-meta">Owner: ${escapeHtml(asset.review_workflow?.owner || "Unassigned")} | ${escapeHtml(asset.review_workflow?.state || "open")}<br />Due: ${escapeHtml(asset.review_workflow?.due_date || "Not set")}</div>` : ""}
      </article>
    `
    )
    .join("") || "<p class=empty-state>No investments match these filters.</p>";

  els.list.querySelectorAll(".asset-item").forEach((node) => {
    node.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); node.click(); } });
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
  if (!expanded) return "";
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

function renderValuationHistory(asset) {
  if (!asset.valuation_history?.length) return "";
  return `<div class="section-title">Valuation History</div>
    <p class="sub">Reported holding values. Changes include any capital activity, FX and revaluations; they are not investment returns.</p>
    <div class="investments-wrap"><table class="investments-table"><thead><tr><th>As of</th><th>Holding value</th><th>Reported book cost</th><th>Source</th></tr></thead><tbody>
    ${[...asset.valuation_history].reverse().map(h => `<tr><td>${displayDate(h.date)}</td><td>${usd(h.value_usd)}</td><td>${usd(h.book_cost_usd)}</td><td>${escapeHtml(h.source)}</td></tr>`).join("")}
    </tbody></table></div>`;
}

function renderNavReview(asset) {
  const review = asset.nav_review;
  if (!review) return "";
  const links = (review.sources || []).filter(s => /^https:\/\//.test(s.url)).map(s =>
    `<li><strong>${escapeHtml(s.source_type || "Source type not classified")}</strong><br /><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a> <span class="sub">${escapeHtml(s.timing)}; accessed ${displayDate(s.accessed_at)}<br />${escapeHtml(s.freshness || "Freshness unknown")}</span></li>`).join("");
  return `<details class="nav-review"><summary>Evidence and sources</summary>
    <p class="sub">${escapeHtml(asset.evidence_health?.label || "Evidence freshness unknown")}. Source age is measured from its event date, not the date it was accessed. Older than 180 days is flagged; review refresh is due after 90 days.</p>
    <p><strong>Evidence needed:</strong> ${escapeHtml(review.required_evidence)}</p>
    <p class="sub">Analytical assessment as of ${displayDate(review.reviewed_at)}. Subsequent news does not overwrite the reported June valuation.</p>
    ${links ? `<ul class="research-sources">${links}</ul>` : "<p class='sub'>No independently verified current source for this holding in this review.</p>"}
    </details>`;
}

function renderReviewWorkflow(asset) {
  const w = asset.review_workflow || {};
  const summary = `<p class="review-status">Owner: <strong>${escapeHtml(w.owner || "Unassigned")}</strong> | Status: ${escapeHtml(w.state || "open")} | Due: ${escapeHtml(w.due_date || "Not set")}<br />Last workflow review: ${w.last_reviewed_at ? displayDate(w.last_reviewed_at) : "Not recorded"}</p>`;
  const resolution = w.resolution ? `<p><strong>Resolution note:</strong> ${escapeHtml(w.resolution)}</p>` : "";
  if (!isLocalRuntime) return summary + resolution;
  return `${summary}${resolution}<details class="workflow-editor"><summary>Update review tracking (local)</summary>
    <p>Only review ownership and follow-up are editable. Assigned NAV and source evidence are read-only. Saved tracking is published with the next deployment.</p>
    <form id="reviewForm">
      <label>Owner<input name="owner" value="${escapeHtml(w.owner || "")}" maxlength="200" /></label>
      <label>Status<select name="state">${["open", "evidence-requested", "in-review", "resolved"].map(s=>`<option value="${s}" ${s === (w.state || "open") ? "selected" : ""}>${s.replaceAll("-", " ")}</option>`).join("")}</select></label>
      <label>Due date<input type="date" name="due_date" value="${escapeHtml(w.due_date || "")}" /></label>
      <label>Evidence requested<textarea name="evidence_requested" maxlength="5000">${escapeHtml(w.evidence_requested || asset.nav_review?.required_evidence || "")}</textarea></label>
      <label>Resolution rationale<textarea name="resolution" maxlength="5000">${escapeHtml(w.resolution || "")}</textarea></label>
      <p>Resolving a task does not remove an evidence risk flag or validate NAV. Update the underlying evidence when the risk changes.</p>
      <button type="submit">Save review tracking</button><p id="reviewFeedback" role="status" aria-live="polite"></p>
    </form></details>`;
}

function bindReviewForm(asset) {
  const form = document.getElementById("reviewForm");
  if (!isLocalRuntime || !form) return;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const feedback = document.getElementById("reviewFeedback");
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/review`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(Object.fromEntries(new FormData(form)))});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Save failed");
      await loadAssets();
      const confirmation = document.getElementById("reviewFeedback");
      if (confirmation) { confirmation.closest("details").open = true; confirmation.textContent = "Saved locally. Assigned NAV unchanged."; }
    } catch (error) { feedback.textContent = error.message; button.disabled = false; }
  });
}

function renderPerformanceBridge(asset) {
  const b = asset.performance_bridge || {};
  const rows = [["Opening assigned NAV",asset.previous_market_value_usd],["Contributions (+)",b.contributions_usd],["Distributions (-)",b.distributions_usd],["FX impact (+/-)",b.fx_usd],["Fees (-)",b.fees_usd],["Residual valuation / other movement",b.unexplained_change_usd],["Closing assigned NAV",asset.market_value_usd]];
  return `<details class="detail-disclosure"><summary>Value movement bridge</summary>
    <p>${escapeHtml(b.complete ? "Cash flows attributed for this valuation interval. The residual includes revaluation and any other unclassified movement; it is not a return percentage." : b.warning || "Cash-flow inputs have not been provided. Performance cannot be isolated.")}</p>
    <dl class="bridge">${rows.map(([label,value])=>`<dt>${label}</dt><dd>${value == null ? "Not supplied" : usd(value)}</dd>`).join("")}</dl>
    ${b.source ? `<p>Source: ${escapeHtml(b.source)}</p>` : ""}</details>`;
}

function renderImportPreview() {
  const p = state.importPreview;
  if (!p) return "<p class='sub'>Import preview not available.</p>";
  return `<details class="import-preview"><summary>Import reconciliation: ${p.errors?.length ? "blocked" : `${p.matched_count} matched`}</summary>
    <p>${escapeHtml(p.source)}<br />Valuation date: ${displayDate(p.valuation_as_of)}<br />${p.applied ? "Reconciled import applied" : "Preview only; not applied"}</p>
    ${(p.errors || []).map(e=>`<p class="urgent-banner">${escapeHtml(e)}</p>`).join("")}
    ${(p.unmatched_names || []).map(n=>`<p>Unmatched: ${escapeHtml(n)}</p>`).join("")}
    ${(p.warnings || []).map(w=>`<p>${escapeHtml(w)}</p>`).join("")}
    <div class="investments-wrap"><table class="investments-table"><thead><tr><th>Holding / rows</th><th>Previous</th><th>Imported</th><th>Change</th></tr></thead><tbody>
    ${(p.rows || []).map(r=>`<tr><td>${escapeHtml(r.name)}<br />Rows ${escapeHtml(r.source_rows.join(", "))}</td><td>${usd(r.old_value_usd)}</td><td>${usd(r.new_value_usd)}</td><td>${usd(r.change_usd)}</td></tr>`).join("")}
    </tbody></table></div><p>Publication is blocked if the dataset, workbook checksum or control totals no longer match.</p></details>`;
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
    <div class="assessment-banner ${attentionLevel(asset) === "urgent" ? "urgent-banner" : ""}">
      <strong>${escapeHtml(asset.nav_risk?.label || "Assigned NAV requires evidence review")}</strong>
      <p>${attentionLevel(asset) === "urgent" ? "In administration - urgent impairment review" : escapeHtml(asset.nav_review?.status || "Evidence needed")}</p>
      <p>${escapeHtml(asset.nav_review?.assessment || "Current NAV evidence has not been assessed.")}</p>
    </div>
    <p class="sub">Assigned NAV is retained from the workbook. Risk flags do not change it. Research reviewed ${displayDate(asset.nav_review?.reviewed_at)}${asset.evidence_health?.review_stale ? " - review refresh due" : ""}.</p>
    ${renderReviewWorkflow(asset)}

    <div class="kpi-grid">


      <div class="kpi"><div class="label">Previous value (${displayDate(asset.previous_valuation_date)})</div><div class="value">${usd(asset.previous_market_value_usd)}</div></div>
      <div class="kpi"><div class="label">Assigned NAV (${displayDate(asset.valuation_as_of)})</div><div class="value">${usd(asset.market_value_usd)}</div></div>

      <div class="kpi"><div class="label">Change vs previous</div><div class="value">${usd(asset.change_since_previous_usd)}</div></div>

    </div>

    <div class="next-action"><strong>Evidence requested</strong><p>${escapeHtml(asset.review_workflow?.evidence_requested || asset.nav_review?.required_evidence || "Not specified")}</p></div>
    <div class="section-title">Company Snapshot</div>
    <p>${buildCompanySnapshot(asset)}</p>

    <div class="section-title">Latest Market Info: Externally Sourced Information</div>
    <p>${escapeHtml(asset.latest_market_info_external || "No external market note currently captured for this asset.")}</p>
    ${renderNavReview(asset)}
    ${renderPerformanceBridge(asset)}
    <details class="detail-disclosure"><summary>Valuation history</summary><p>Original investment: ${usd(asset.original_investment_usd)} | Historical P&amp;L vs book: ${usd(asset.pnl_usd)} | Change vs 1Q 2023: ${usd(asset.diff_current_vs_2023_usd)}</p>${renderValuationHistory(asset)}</details>

    <details class="detail-disclosure"><summary>Investment terms / tranches</summary>
    ${asset.latest_reconciliation ? `<p class="sub">${escapeHtml(asset.latest_reconciliation.note)} ${Math.abs(asset.latest_reconciliation.tranche_book_gap_usd) > .01 ? `Book-cost gap: ${usd(asset.latest_reconciliation.tranche_book_gap_usd)}.` : ""}</p>` : ""}
    ${renderInvestments(asset)}
    </details>

    ${asset.nav_review ? "" : `<div class="section-title">Decline Rationale</div><p>${asset.decline_reason || "n/a"}</p>`}

    <div class="section-title section-inline">Data Available <button type="button" class="timeline-toggle" data-timeline-toggle="${asset.id}">${state.timelineExpanded[asset.id] ? "Collapse" : "Expand"}</button></div>
    ${renderTimeline(asset)}
  `;

  bindDetailInteractions();
  bindReviewForm(asset);
}

function renderManualPanel() {
  if (!els.manualPanel) return;
  els.manualPanel.innerHTML = isLocalRuntime ? `
    <details class="update-help"><summary>How to update this report</summary>
      <p>Update the Excel workbook, then run the reconciled import locally. Company snapshots and investment dates remain preserved unless explicitly updated.</p>
      <p>Review the totals and source-linked assessments before publishing to GitHub/Vercel. Editing Excel alone does not update the live website.</p>
      <p>Existing manual notes are retained. This view is read-only to avoid competing versions of the same information.</p>
    </details>` : "";
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

function bindFilterEvents() {
  for (const node of [els.section, els.reporting]) node.addEventListener("change", loadAssets);
  let searchTimer;
  els.search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadAssets, 200); });
  for (const node of [els.trend, els.attention, els.queue, els.reviewState]) node.addEventListener("change", () => {
    applyTrendFilter(); updateTrendFilterLabels(); renderSummary(); renderList(); renderDetail(); renderManualPanel();
  });
}

if (!isLocalRuntime && els.manualPanel) els.manualPanel.style.display = "none";

bindFilterEvents();
loadAssets();
