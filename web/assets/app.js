const latestUrl = "data/latest.json";
const historyUrl = "data/history.json";
const ABS_OFFER_TYPES = new Set(["absoffer", "swabsoffer", "sw0absoffer"]);
const REL_OFFER_TYPES = new Set(["reloffer", "swreloffer", "sw0reloffer"]);
const ALL_NODES_VALUE = "__all__";
const WINDOW_DURATION_MS = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const state = {
  latest: null,
  history: [],
  chartScaleFactor: 1,
};

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toLocaleString("en-US");
}

function formatLatency(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return `${formatNumber(value)} ms`;
}

function formatDate(value) {
  if (!value) {
    return "No checks yet";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No checks yet";
  }
  return date.toLocaleString();
}

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPercent(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toFixed(digits);
}

function formatFraction(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function formatMetricValue(metric, value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  if (metric === "latency_ms") {
    return `${formatNumber(Math.round(value))} ms`;
  }
  if (metric === "online") {
    return formatNumber(Math.round(value));
  }
  return formatNumber(Math.round(value));
}

function parseBtcToSats(input) {
  if (input === null || input === undefined) {
    return null;
  }
  const normalized = String(input).trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }
  const [whole, fraction = ""] = normalized.split(".");
  const sats =
    Number(whole) * 100000000 + Number((fraction + "00000000").slice(0, 8));
  if (!Number.isFinite(sats) || sats <= 0 || !Number.isSafeInteger(sats)) {
    return null;
  }
  return sats;
}

function parsePositiveInteger(input) {
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

function parseOfferNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseChartOffset(input) {
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function calculateOfferFeeSats(offer, amountSats) {
  const ordertype = String(offer?.ordertype || "");
  const txfee = parseOfferNumber(offer?.txfee);
  if (txfee === null) {
    return null;
  }
  if (ABS_OFFER_TYPES.has(ordertype)) {
    const cjfeeAbs = parseOfferNumber(offer?.cjfee);
    if (cjfeeAbs === null) {
      return null;
    }
    return Math.round(cjfeeAbs) - Math.round(txfee);
  }
  if (REL_OFFER_TYPES.has(ordertype)) {
    const cjfeeRel = parseOfferNumber(offer?.cjfee);
    if (cjfeeRel === null) {
      return null;
    }
    return Math.round(cjfeeRel * amountSats) - Math.round(txfee);
  }
  return null;
}

function buildBestOffersByMaker(offers, amountSats) {
  const bestByMaker = new Map();
  for (const offer of offers) {
    const minsize = parseOfferNumber(offer?.minsize);
    const maxsize = parseOfferNumber(offer?.maxsize);
    if (minsize === null || maxsize === null) {
      continue;
    }
    if (!(minsize < amountSats && maxsize > amountSats)) {
      continue;
    }
    const counterparty = String(offer?.counterparty || "").trim();
    if (!counterparty) {
      continue;
    }
    const fee = calculateOfferFeeSats(offer, amountSats);
    if (fee === null) {
      continue;
    }
    const current = bestByMaker.get(counterparty);
    if (!current || fee < current.fee) {
      bestByMaker.set(counterparty, {
        counterparty,
        fee,
        ordertype: String(offer?.ordertype || ""),
      });
    }
  }
  return Array.from(bestByMaker.values()).sort((left, right) => {
    if (left.fee !== right.fee) {
      return left.fee - right.fee;
    }
    return left.counterparty.localeCompare(right.counterparty);
  });
}

function getFeeQuantile(bestOffers, quantile) {
  if (bestOffers.length === 0) {
    return null;
  }
  const index = Math.floor((bestOffers.length - 1) * quantile);
  return bestOffers[index].fee;
}

function getThresholdFee(bestOffers, targetPool) {
  if (bestOffers.length === 0) {
    return null;
  }
  const index = Math.min(bestOffers.length - 1, Math.max(0, targetPool - 1));
  return bestOffers[index].fee;
}

function calculateFeeProfiles(bestOffers, amountSats, counterparties) {
  const profiles = [
    {
      key: "economy",
      label: "Economy",
      targetPool: Math.max(counterparties * 6, 24),
    },
    {
      key: "balanced",
      label: "Balanced",
      targetPool: Math.max(counterparties * 20, 80),
    },
    {
      key: "fast",
      label: "Fast",
      targetPool: Math.max(counterparties * 40, 200),
    },
  ];
  return profiles.map((profile) => {
    const maxAbsSat = getThresholdFee(bestOffers, profile.targetPool);
    const maxRelFraction = maxAbsSat === null ? null : maxAbsSat / amountSats;
    const maxRelPercent = maxRelFraction === null ? null : maxRelFraction * 100;
    const eligibleMakers =
      maxAbsSat === null
        ? 0
        : bestOffers.filter((offer) => offer.fee <= maxAbsSat).length;
    return {
      ...profile,
      maxAbsSat,
      maxRelFraction,
      maxRelPercent,
      eligibleMakers,
    };
  });
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function sumFinite(values) {
  let total = 0;
  for (const value of values) {
    const parsed = toFiniteNumber(value);
    if (parsed !== null) {
      total += parsed;
    }
  }
  return total;
}

function firstFinite(values) {
  for (const value of values) {
    const parsed = toFiniteNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function metricFromAllNodes(rows, metric) {
  if (metric === "offers") {
    const unique = firstFinite(rows.map((row) => row.offers_unique_total));
    return unique !== null ? unique : sumFinite(rows.map((row) => row.offers));
  }
  if (metric === "makers") {
    const unique = firstFinite(rows.map((row) => row.makers_unique_total));
    return unique !== null ? unique : sumFinite(rows.map((row) => row.makers));
  }
  if (metric === "fidelity_bonds") {
    return sumFinite(rows.map((row) => row.fidelity_bonds));
  }
  if (metric === "online") {
    return rows.filter((row) => row.ok).length;
  }
  if (metric === "latency_ms") {
    const samples = rows
      .filter((row) => row.ok)
      .map((row) => toFiniteNumber(row.latency_ms))
      .filter((value) => value !== null);
    if (samples.length === 0) {
      return null;
    }
    return samples.reduce((acc, value) => acc + value, 0) / samples.length;
  }
  return null;
}

function metricFromNode(rows, metric, node) {
  const row = rows.find((item) => item.node === node);
  if (!row) {
    return null;
  }
  if (metric === "offers") {
    return toFiniteNumber(row.offers) ?? 0;
  }
  if (metric === "makers") {
    return toFiniteNumber(row.makers) ?? 0;
  }
  if (metric === "fidelity_bonds") {
    return toFiniteNumber(row.fidelity_bonds) ?? 0;
  }
  if (metric === "online") {
    return row.ok ? 1 : 0;
  }
  if (metric === "latency_ms") {
    if (!row.ok) {
      return null;
    }
    return toFiniteNumber(row.latency_ms);
  }
  return null;
}

function buildHistorySeries(rows, metric, selectedNode) {
  const grouped = new Map();
  for (const row of rows) {
    const checkedAt = String(row?.checked_at || "").trim();
    if (!checkedAt) {
      continue;
    }
    if (!grouped.has(checkedAt)) {
      grouped.set(checkedAt, []);
    }
    grouped.get(checkedAt).push(row);
  }

  const series = [];
  for (const [checkedAt, items] of grouped.entries()) {
    const timestamp = Date.parse(checkedAt);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    const value =
      selectedNode === ALL_NODES_VALUE
        ? metricFromAllNodes(items, metric)
        : metricFromNode(items, metric, selectedNode);
    if (value === null) {
      continue;
    }
    series.push({
      checked_at: checkedAt,
      timestamp,
      value,
    });
  }
  return series.sort((left, right) => left.timestamp - right.timestamp);
}

function sliceSeriesWindow(series, windowMs, offset) {
  if (series.length === 0) {
    return [];
  }
  const safeOffset = clamp(offset, 0, Math.max(0, series.length - 1));
  const endIndex = series.length - 1 - safeOffset;
  if (endIndex < 0) {
    return [];
  }
  const endTimestamp = series[endIndex].timestamp;
  const startTimestamp = endTimestamp - windowMs;
  return series.filter(
    (item, index) => index <= endIndex && item.timestamp >= startTimestamp,
  );
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(220, Math.floor(rect.height));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function drawChart(rows, metric) {
  const canvas = document.getElementById("history-chart");
  const { ctx, width, height } = setupCanvas(canvas);
  const padding = { top: 24, right: 20, bottom: 38, left: 74 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);

  if (rows.length === 0) {
    ctx.fillStyle = "#63707c";
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText("No history in selected window", padding.left, padding.top + 42);
    return;
  }

  const values = rows.map((item) => item.value);
  const maxValue = Math.max(1, ...values);
  const scaledMax = Math.max(1, maxValue * state.chartScaleFactor);
  const yTicks = 5;

  ctx.strokeStyle = "#d8dee4";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#63707c";
  ctx.font = "12px system-ui, sans-serif";
  for (let i = 0; i <= yTicks; i += 1) {
    const ratio = i / yTicks;
    const y = padding.top + chartHeight * ratio;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    const value = Math.round((1 - ratio) * scaledMax);
    const label = metric === "latency_ms" ? `${formatNumber(value)} ms` : formatNumber(value);
    const labelWidth = ctx.measureText(label).width;
    ctx.fillText(label, padding.left - labelWidth - 8, y + 4);
  }

  const stepX = rows.length > 1 ? chartWidth / (rows.length - 1) : chartWidth;
  const points = rows.map((item, index) => ({
    x: padding.left + stepX * index,
    y: padding.top + chartHeight - (item.value / scaledMax) * chartHeight,
  }));

  ctx.strokeStyle = "#1d6f8f";
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.stroke();

  ctx.fillStyle = "#1d6f8f";
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const tickCount = Math.min(6, rows.length);
  ctx.fillStyle = "#63707c";
  ctx.font = "12px system-ui, sans-serif";
  for (let i = 0; i < tickCount; i += 1) {
    const index =
      tickCount === 1 ? 0 : Math.round(((rows.length - 1) * i) / (tickCount - 1));
    const row = rows[index];
    const x = padding.left + stepX * index;
    const text = formatShortDate(row.checked_at);
    const textWidth = ctx.measureText(text).width;
    const centeredX = clamp(
      x - textWidth / 2,
      padding.left,
      width - padding.right - textWidth,
    );
    ctx.fillText(text, centeredX, height - 12);
  }
}

function renderLatest(latest) {
  const summary = latest?.summary || {};
  document.getElementById("subtitle").textContent = latest?.network
    ? `${latest.network}, via ${latest.tor_socks}`
    : "Waiting for monitor data";
  document.getElementById("nodes-ok").textContent =
    summary.nodes_total !== undefined
      ? `${formatNumber(summary.nodes_ok)}/${formatNumber(summary.nodes_total)}`
      : "-";
  document.getElementById("offers-total").textContent = formatNumber(
    summary.offers_unique_total ?? summary.offers_total,
  );
  document.getElementById("max-node-offers").textContent = formatNumber(
    summary.max_node_offers,
  );
  document.getElementById("makers-total").textContent = formatNumber(
    summary.makers_unique_total ?? summary.makers_total,
  );
  document.getElementById("bonds-total").textContent = formatNumber(
    summary.fidelity_bonds_total,
  );
  document.getElementById("last-check").textContent = formatDate(latest?.checked_at);

  const tbody = document.getElementById("nodes-table");
  const nodes = latest?.nodes || [];
  if (nodes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7">No data published yet.</td></tr>';
    return;
  }
  tbody.replaceChildren(
    ...nodes.map((node) => {
      const row = document.createElement("tr");
      const status = node.ok
        ? '<span class="status ok">OK</span>'
        : '<span class="status fail">Fail</span>';
      row.innerHTML = `
        <td class="node"></td>
        <td>${status}</td>
        <td>${formatNumber(node.offers)}</td>
        <td>${formatNumber(node.makers)}</td>
        <td>${formatNumber(node.fidelity_bonds)}</td>
        <td>${formatLatency(node.latency_ms)}</td>
        <td class="error"></td>
      `;
      row.querySelector(".node").textContent = node.node;
      row.querySelector(".error").textContent = node.error || "";
      return row;
    }),
  );
}

function renderFeeCalculator() {
  const orderbook = state.latest?.orderbook;
  const source = document.getElementById("fee-source");
  const status = document.getElementById("fee-status");
  const tbody = document.getElementById("fee-table");

  if (!orderbook || !Array.isArray(orderbook.offers)) {
    source.textContent = "No orderbook data in latest snapshot";
    status.textContent = "Calculator requires orderbook offers in latest.json.";
    tbody.innerHTML = '<tr><td colspan="6">No orderbook offers available.</td></tr>';
    return;
  }

  source.textContent = `${formatNumber(orderbook.offers_total)} offers from ${formatNumber(orderbook.makers_total)} makers`;

  const amountSats = parseBtcToSats(document.getElementById("fee-amount").value);
  const counterparties = parsePositiveInteger(
    document.getElementById("fee-counterparties").value,
  );
  if (amountSats === null) {
    status.textContent = "Enter a positive BTC amount, for example 0.00060150.";
    tbody.innerHTML = '<tr><td colspan="6">Invalid amount format.</td></tr>';
    return;
  }
  if (counterparties === null) {
    status.textContent = "Counterparties must be an integer greater than zero.";
    tbody.innerHTML = '<tr><td colspan="6">Invalid counterparties value.</td></tr>';
    return;
  }

  const bestOffers = buildBestOffersByMaker(orderbook.offers, amountSats);
  if (bestOffers.length === 0) {
    status.textContent =
      "No eligible offers for this amount in the latest orderbook snapshot.";
    tbody.innerHTML = '<tr><td colspan="6">No eligible makers for this amount.</td></tr>';
    return;
  }
  if (bestOffers.length < counterparties) {
    status.textContent = `Only ${formatNumber(bestOffers.length)} eligible makers for this amount, below requested ${formatNumber(counterparties)}.`;
  } else {
    status.textContent =
      `Eligible makers: ${formatNumber(bestOffers.length)}. ` +
      `P50=${formatNumber(getFeeQuantile(bestOffers, 0.5))} sat, ` +
      `P75=${formatNumber(getFeeQuantile(bestOffers, 0.75))} sat, ` +
      `P90=${formatNumber(getFeeQuantile(bestOffers, 0.9))} sat per maker.`;
  }

  const profiles = calculateFeeProfiles(bestOffers, amountSats, counterparties);
  tbody.replaceChildren(
    ...profiles.map((profile) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td></td>
        <td>${formatNumber(profile.maxAbsSat)}</td>
        <td>${formatPercent(profile.maxRelPercent, 4)}</td>
        <td>${formatFraction(profile.maxRelFraction)}</td>
        <td>${formatNumber(profile.eligibleMakers)}</td>
        <td>${formatNumber(profile.targetPool)}</td>
      `;
      const label = row.querySelector("td");
      label.textContent = profile.label;
      if (profile.key === "fast") {
        label.classList.add("fee-fast");
      }
      return row;
    }),
  );
}

function collectKnownNodes() {
  const nodes = new Set();
  for (const node of state.latest?.nodes || []) {
    if (node?.node) {
      nodes.add(node.node);
    }
  }
  for (const row of state.history) {
    if (row?.node) {
      nodes.add(row.node);
    }
  }
  return Array.from(nodes).sort((left, right) => left.localeCompare(right));
}

function syncChartNodeOptions() {
  const select = document.getElementById("chart-node");
  const previousValue = select.value || ALL_NODES_VALUE;
  const nodes = collectKnownNodes();
  const options = [
    { value: ALL_NODES_VALUE, label: "All DN" },
    ...nodes.map((node) => ({ value: node, label: node })),
  ];
  select.replaceChildren(
    ...options.map((option) => {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      return element;
    }),
  );
  const nextValue = options.some((option) => option.value === previousValue)
    ? previousValue
    : ALL_NODES_VALUE;
  select.value = nextValue;
}

function getSelectedWindowMs() {
  const selected = document.getElementById("chart-window").value;
  return WINDOW_DURATION_MS[selected] || WINDOW_DURATION_MS["24h"];
}

function updateOffsetControl(totalPoints) {
  const control = document.getElementById("chart-offset");
  const maxOffset = Math.max(0, totalPoints - 1);
  control.max = String(maxOffset);
  const current = clamp(parseChartOffset(control.value), 0, maxOffset);
  control.value = String(current);
  const caption = document.getElementById("chart-offset-caption");
  caption.textContent =
    current === 0
      ? "Newest window"
      : `Window shifted by ${formatNumber(current)} samples`;
  return current;
}

function renderChartSummary(rows, metric, selectedNode, offset, totalPoints) {
  const summary = document.getElementById("chart-summary");
  if (rows.length === 0) {
    summary.textContent = "No history in selected scope and window.";
    return;
  }
  const values = rows.map((item) => item.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((acc, value) => acc + value, 0) / values.length;
  const last = values[values.length - 1];
  const firstTime = formatDate(rows[0].checked_at);
  const lastTime = formatDate(rows[rows.length - 1].checked_at);
  const scopeLabel = selectedNode === ALL_NODES_VALUE ? "All DN" : selectedNode;
  const scaleLabel =
    state.chartScaleFactor === 1
      ? "auto"
      : `${Math.round(state.chartScaleFactor * 100)}%`;
  summary.textContent =
    `${scopeLabel}. ` +
    `Points: ${formatNumber(rows.length)} of ${formatNumber(totalPoints)}. ` +
    `Range: ${firstTime} -> ${lastTime}. ` +
    `Last ${formatMetricValue(metric, last)}, ` +
    `Avg ${formatMetricValue(metric, avg)}, ` +
    `Min ${formatMetricValue(metric, min)}, ` +
    `Max ${formatMetricValue(metric, max)}. ` +
    `Scale: ${scaleLabel}. ` +
    `Offset: ${formatNumber(offset)}.`;
}

function renderChart() {
  syncChartNodeOptions();
  const metric = document.getElementById("chart-mode").value;
  const selectedNode = document.getElementById("chart-node").value || ALL_NODES_VALUE;
  const windowMs = getSelectedWindowMs();
  const series = buildHistorySeries(state.history, metric, selectedNode);
  const offset = updateOffsetControl(series.length);
  const rows = sliceSeriesWindow(series, windowMs, offset);
  drawChart(rows, metric);
  renderChartSummary(rows, metric, selectedNode, offset, series.length);
}

function render() {
  renderLatest(state.latest);
  renderFeeCalculator();
  renderChart();
}

async function fetchJson(url, fallback) {
  const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    return fallback;
  }
  return response.json();
}

async function loadData() {
  const [latest, history] = await Promise.all([
    fetchJson(latestUrl, null),
    fetchJson(historyUrl, []),
  ]);
  state.latest = latest;
  state.history = Array.isArray(history) ? history : [];
  render();
}

function resetOffsetAndRender() {
  document.getElementById("chart-offset").value = "0";
  renderChart();
}

document.getElementById("refresh-button").addEventListener("click", loadData);
document.getElementById("chart-mode").addEventListener("change", resetOffsetAndRender);
document.getElementById("chart-node").addEventListener("change", resetOffsetAndRender);
document.getElementById("chart-window").addEventListener("change", resetOffsetAndRender);
document.getElementById("chart-offset").addEventListener("input", renderChart);
document.getElementById("chart-zoom-in").addEventListener("click", () => {
  state.chartScaleFactor = clamp(state.chartScaleFactor / 1.4, 0.25, 8);
  renderChart();
});
document.getElementById("chart-zoom-out").addEventListener("click", () => {
  state.chartScaleFactor = clamp(state.chartScaleFactor * 1.4, 0.25, 8);
  renderChart();
});
document.getElementById("chart-zoom-reset").addEventListener("click", () => {
  state.chartScaleFactor = 1;
  renderChart();
});
document.getElementById("fee-calc").addEventListener("click", renderFeeCalculator);
document.getElementById("fee-amount").addEventListener("change", renderFeeCalculator);
document
  .getElementById("fee-counterparties")
  .addEventListener("change", renderFeeCalculator);
window.addEventListener("resize", renderChart);
loadData().catch((error) => {
  document.getElementById("subtitle").textContent = `Load failed: ${error.message}`;
});
