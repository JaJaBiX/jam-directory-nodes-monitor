const latestUrl = "data/latest.json";
const historyUrl = "data/history.json";
const ABS_OFFER_TYPES = new Set(["absoffer", "swabsoffer", "sw0absoffer"]);
const REL_OFFER_TYPES = new Set(["reloffer", "swreloffer", "sw0reloffer"]);

const state = {
  latest: null,
  history: [],
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
  return new Date(value).toLocaleString();
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

function groupHistory(rows, metric) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.checked_at;
    if (!grouped.has(key)) {
      grouped.set(key, {
        checked_at: key,
        value: 0,
        count: 0,
      });
    }
    const item = grouped.get(key);
    if (metric === "latency_ms") {
      if (row.ok && row.latency_ms !== null && row.latency_ms !== undefined) {
        item.value += Number(row.latency_ms);
        item.count += 1;
      }
    } else if (row.ok) {
      item.value += Number(row[metric] || 0);
      item.count += 1;
    }
  }
  return Array.from(grouped.values())
    .map((item) => ({
      checked_at: item.checked_at,
      value:
        metric === "latency_ms" && item.count > 0
          ? Math.round(item.value / item.count)
          : item.value,
    }))
    .sort((a, b) => new Date(a.checked_at) - new Date(b.checked_at));
}

function drawChart(rows, metric) {
  const canvas = document.getElementById("history-chart");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 24, right: 22, bottom: 34, left: 54 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d8dee4";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (chartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  if (rows.length === 0) {
    ctx.fillStyle = "#63707c";
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText("No history yet", padding.left, padding.top + 42);
    return;
  }

  const maxValue = Math.max(1, ...rows.map((item) => item.value));
  const stepX = rows.length > 1 ? chartWidth / (rows.length - 1) : chartWidth;

  ctx.strokeStyle = "#1d6f8f";
  ctx.lineWidth = 3;
  ctx.beginPath();
  rows.forEach((item, index) => {
    const x = padding.left + stepX * index;
    const y = padding.top + chartHeight - (item.value / maxValue) * chartHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  ctx.fillStyle = "#17212b";
  ctx.font = "15px system-ui, sans-serif";
  ctx.fillText(formatNumber(maxValue), 12, padding.top + 5);
  ctx.fillText("0", 32, height - padding.bottom + 5);

  const first = rows[0]?.checked_at;
  const last = rows[rows.length - 1]?.checked_at;
  ctx.fillStyle = "#63707c";
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText(formatDate(first), padding.left, height - 10);
  const lastText = formatDate(last);
  const lastWidth = ctx.measureText(lastText).width;
  ctx.fillText(lastText, width - padding.right - lastWidth, height - 10);
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
    summary.offers_total,
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

function render() {
  renderLatest(state.latest);
  renderFeeCalculator();
  const metric = document.getElementById("chart-mode").value;
  drawChart(groupHistory(state.history, metric), metric);
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

document.getElementById("refresh-button").addEventListener("click", loadData);
document.getElementById("chart-mode").addEventListener("change", render);
document.getElementById("fee-calc").addEventListener("click", renderFeeCalculator);
document.getElementById("fee-amount").addEventListener("change", renderFeeCalculator);
document
  .getElementById("fee-counterparties")
  .addEventListener("change", renderFeeCalculator);
window.addEventListener("resize", render);
loadData().catch((error) => {
  document.getElementById("subtitle").textContent = `Load failed: ${error.message}`;
});
