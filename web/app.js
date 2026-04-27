let state = {
  assets: [],
  filtered: [],
  selectedId: null,
};

const els = {
  list: document.getElementById("assetList"),
  detail: document.getElementById("detail"),
  summary: document.getElementById("summary"),
  search: document.getElementById("search"),
  section: document.getElementById("sectionFilter"),
  trend: document.getElementById("trendFilter"),
  reporting: document.getElementById("reportingFilter"),
};

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

  const clarification = asset.clarification_status === "Clarification needed" && !asset.resolved
    ? "Status is Clarification needed until new data or explanation is resolved."
    : "Current clarification status is resolved or not required.";

  let sourceLine = "No recent imported narrative is available yet.";
  if (latest) {
    const sourceName = latest.source ? ` Source: ${latest.source}.` : "";
    const narrative = latest.summary || latest.label || "Latest timeline event recorded.";
    sourceLine = `Latest context (${latest.date || "n/a"}): ${narrative}.${sourceName}`;
  }

  return [identity, traction, clarification, sourceLine].join(" ");
}

async function loadAssets() {
  const params = new URLSearchParams();
  if (els.search.value.trim()) params.set("search", els.search.value.trim());
  if (els.section.value) params.set("section", els.section.value);
  if (els.trend.value) params.set("trend", els.trend.value);
  if (els.reporting.value) params.set("reporting", els.reporting.value);

  const res = await fetch(`/api/assets?${params.toString()}`);
  if (!res.ok) {
    els.list.innerHTML = "<div class='asset-item'>Failed to load assets.</div>";
    return;
  }
  const payload = await res.json();
  state.assets = payload.assets || [];
  state.filtered = state.assets;
  if (!state.selectedId && state.assets.length) state.selectedId = state.assets[0].id;
  if (state.selectedId && !state.assets.find((a) => a.id === state.selectedId)) state.selectedId = state.assets[0]?.id || null;
  renderSummary();
  renderList();
  renderDetail();
}

function renderSummary() {
  const total = state.filtered.length;
  const growers = state.filtered.filter((a) => a.value_grower).length;
  const sliders = state.filtered.filter((a) => a.major_slider).length;
  const clarifications = state.filtered.filter((a) => a.clarification_status === "Clarification needed" && !a.resolved).length;

  const sectionCurrentValue = (section) => state.filtered
    .filter((a) => a.section === section)
    .reduce((sum, a) => sum + (Number(a.market_value_usd) || 0), 0);

  const totalOriginalInvestment = state.filtered
    .reduce((sum, a) => sum + (Number(a.original_investment_usd) || 0), 0);

  const total2023 = state.filtered
    .reduce((sum, a) => sum + (Number(a.value_2023_usd) || 0), 0);

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
    <br />Value growers: <strong>${growers}</strong>
    <br />Major sliders: <strong>${sliders}</strong>
    <br />Clarification needed: <strong>${clarifications}</strong>
  `;
}

function itemTags(asset) {
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
    });
  });
}

function renderTimeline(asset) {
  const timeline = (asset.timeline || [])
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
  return `<ul class="timeline">${timeline || "<li>No timeline events yet.</li>"}</ul>`;
}

function renderInvestments(asset) {
  const rows = (asset.investments || [])
    .map((inv) => `
      <tr>
        <td>${inv.security_name || "n/a"}</td>
        <td>${inv.instrument_type || "n/a"}</td>
        <td>${inv.series || "-"}</td>
        <td>${inv.share_class || "-"}</td>
        <td>${usd(inv.book_cost_usd)}</td>
        <td>${usd(inv.market_value_usd)}</td>
        <td>${usd(inv.pnl_usd)}</td>
      </tr>
    `)
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
  const asset = state.filtered.find((a) => a.id === state.selectedId);
  if (!asset) {
    els.detail.className = "detail empty";
    els.detail.innerHTML = "<p>No asset selected.</p>";
    return;
  }
  els.detail.className = "detail";
  const buildSummary = buildSummaryText(asset);
  els.detail.innerHTML = `
    <h2>${asset.canonical_name || asset.name}</h2>
    <div class="build-summary"><p>${buildSummary}</p></div>
    <div class="sub">Original line item: ${asset.name} | underlying tracked: ${asset.underlying_asset || "n/a"}</div>
    <div class="sub">Aliases: ${(asset.aliases || []).join(", ") || "n/a"}</div>

    <div class="kpi-grid">
      <div class="kpi"><div class="label">Original investment</div><div class="value">${usd(asset.original_investment_usd)}</div></div>
      <div class="kpi"><div class="label">Value 1Q 2023</div><div class="value">${usd(asset.value_2023_usd)}</div></div>
      <div class="kpi"><div class="label">Market value</div><div class="value">${usd(asset.market_value_usd)}</div></div>
      <div class="kpi"><div class="label">P&L</div><div class="value">${usd(asset.pnl_usd)}</div></div>
      <div class="kpi"><div class="label">Diff 2025 vs 2023</div><div class="value">${usd(asset.diff_2025_vs_2023_usd)}</div></div>
    </div>

    <div class="section-title">Investment Terms / Tranches</div>
    ${renderInvestments(asset)}

    <div class="section-title">Decline Rationale</div>
    <p>${asset.decline_reason || "n/a"}</p>

    <div class="section-title">Timeline (most recent to oldest)</div>
    ${renderTimeline(asset)}

    <div class="section-title">Manual Actions</div>
    <div class="forms">
      <form id="renameForm" class="panel">
        <h4>Rename / Underlying map</h4>
        <input name="canonical_name" placeholder="Canonical research name" value="${asset.canonical_name || ""}" />
        <input name="underlying_asset" placeholder="Underlying asset" value="${asset.underlying_asset || ""}" />
        <input name="alias" placeholder="Add alias (optional)" />
        <label><input type="checkbox" name="resolved" ${asset.resolved ? "checked" : ""}/> Mark clarification resolved</label>
        <button type="submit">Save mapping</button>
      </form>

      <form id="eventForm" class="panel">
        <h4>Add timeline event</h4>
        <input name="date" type="date" />
        <input name="label" placeholder="Event label" required />
        <select name="event_type">
          <option value="note">Note</option>
          <option value="rename">Rename</option>
          <option value="acquisition">Acquisition</option>
          <option value="valuation">Valuation</option>
          <option value="analysis">Analysis</option>
        </select>
        <select name="reporting_style">
          <option value="quarter">Quarter</option>
          <option value="half-year">Half-year</option>
          <option value="full-year" selected>Full-year</option>
        </select>
        <input name="source" placeholder="Source" value="Manual input" />
        <input name="value_usd" type="number" step="0.01" placeholder="Value USD (optional)" />
        <button type="submit">Add event</button>
      </form>

      <form id="importForm" class="panel">
        <h4>Import external source by path</h4>
        <input name="source_path" placeholder="/absolute/path/to/file.txt" required />
        <input name="date" type="date" />
        <input name="label" placeholder="Label (optional)" />
        <select name="event_type">
          <option value="import">Import</option>
          <option value="analysis">Analysis</option>
          <option value="note">Note</option>
        </select>
        <select name="reporting_style">
          <option value="quarter">Quarter</option>
          <option value="half-year">Half-year</option>
          <option value="full-year" selected>Full-year</option>
        </select>
        <button type="submit">Import source</button>
      </form>
    </div>
  `;

  bindDetailForms(asset.id);
}

function formJson(form) {
  const fd = new FormData(form);
  const out = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v === "string") out[k] = v.trim();
  }
  out.resolved = form.querySelector("input[name='resolved']")?.checked || false;
  return out;
}

function bindDetailForms(assetId) {
  const renameForm = document.getElementById("renameForm");
  const eventForm = document.getElementById("eventForm");
  const importForm = document.getElementById("importForm");

  renameForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
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
    node.addEventListener("input", () => loadAssets());
    node.addEventListener("change", () => loadAssets());
  });
}

bindFilterEvents();
loadAssets();
