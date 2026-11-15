import fs from "node:fs";

const ROOT = "/Users/hni/Developer/ebay-search";
const ENV_PATH = `${ROOT}/.env`;
const CONFIG_PATH = `${ROOT}/config.json`;
const REPORT_PATH = `${ROOT}/report.html`;
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SCOPE = "https://api.ebay.com/oauth/api_scope";
const LIMIT = 200;
const OFFSET_CAP = 10000;
const TORONTO = "America/Toronto";

class ApiFailure extends Error {
  constructor(status, errorIds, oauthError = "") {
    super("api failure");
    this.httpStatus = status;
    this.errorIds = errorIds;
    this.oauthError = oauthError;
  }
}

class ConfigFailure extends Error {
  constructor() {
    super("config invalid");
  }
}

function loadConfig(path) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    throw new ConfigFailure();
  }
  const keyword = String(config.keyword ?? "").trim();
  const categoryId = String(config.categoryId ?? "").trim();
  const aspectName = String(config.aspect?.name ?? "").trim();
  const aspectValue = String(config.aspect?.value ?? "").trim();
  const currency = String(config.currency ?? "").trim();
  const minimumPrice = Number(config.minimumPrice);
  const windowHours = Number(config.windowHours);
  if (
    !keyword ||
    !categoryId ||
    !aspectName ||
    !aspectValue ||
    !currency ||
    !Number.isFinite(minimumPrice) ||
    minimumPrice < 0 ||
    !Number.isFinite(windowHours) ||
    windowHours <= 0
  ) {
    throw new ConfigFailure();
  }
  return { keyword, categoryId, aspectName, aspectValue, currency, minimumPrice, windowHours };
}

function loadEnv(path) {
  const env = {};
  const text = fs.readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    let body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function errorDetailsFrom(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { ids: [], oauthError: "" };
  }
  try {
    const json = JSON.parse(text);
    const ids = [];
    if (Array.isArray(json.errors)) {
      for (const entry of json.errors) {
        if (entry && entry.errorId != null) ids.push(entry.errorId);
      }
    }
    if (json.errorId != null) ids.push(json.errorId);
    const oauthError =
      typeof json.error === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(json.error)
        ? json.error
        : "";
    return { ids, oauthError };
  } catch {
    return { ids: [], oauthError: "" };
  }
}

async function mintToken(clientId, clientSecret) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: SCOPE,
    }),
  });
  if (!response.ok) {
    const details = await errorDetailsFrom(response);
    throw new ApiFailure(response.status, details.ids, details.oauthError);
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw new ApiFailure(response.status, []);
  }
  if (!json || typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new ApiFailure(response.status, []);
  }
  return json.access_token;
}

function windowFilter(config, start) {
  const end = new Date(start.getTime() + config.windowHours * 60 * 60 * 1000);
  return [
    `price:[${config.minimumPrice}]`,
    `priceCurrency:${config.currency}`,
    "buyingOptions:{AUCTION}",
    "bidCount:[1]",
    `itemEndDate:[${start.toISOString()}..${end.toISOString()}]`,
  ].join(",");
}

function firstPageUrl(config, start, useSort) {
  const params = new URLSearchParams({
    q: config.keyword,
    category_ids: config.categoryId,
    aspect_filter: `categoryId:${config.categoryId},${config.aspectName}:{${config.aspectValue}}`,
    filter: windowFilter(config, start),
    limit: String(LIMIT),
    offset: "0",
  });
  if (useSort) params.set("sort", "endingSoonest");
  return `${SEARCH_URL}?${params.toString()}`;
}

function offsetOf(url) {
  const value = Number(new URL(url).searchParams.get("offset") || "0");
  return Number.isFinite(value) ? value : 0;
}

async function fetchPage(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });
  if (!response.ok) {
    const details = await errorDetailsFrom(response);
    throw new ApiFailure(response.status, details.ids, details.oauthError);
  }
  try {
    return await response.json();
  } catch {
    throw new ApiFailure(response.status, []);
  }
}

async function collect(token, useSort, config, start) {
  let url = firstPageUrl(config, start, useSort);
  const items = [];
  let capped = false;
  const seen = new Set();

  while (url) {
    const offset = offsetOf(url);
    if (offset >= OFFSET_CAP || seen.has(offset)) {
      capped = offset >= OFFSET_CAP;
      break;
    }
    seen.add(offset);

    let page;
    try {
      page = await fetchPage(url, token);
    } catch (error) {
      if (
        useSort &&
        error instanceof ApiFailure &&
        error.errorIds.some((id) => Number(id) === 12034)
      ) {
        return { retryWithoutSort: true };
      }
      if (error instanceof ApiFailure && error.errorIds.some((id) => Number(id) === 12029)) {
        capped = true;
        break;
      }
      throw error;
    }

    if (Array.isArray(page.itemSummaries)) items.push(...page.itemSummaries);
    if (!page.next) break;
    const nextOffset = offsetOf(page.next);
    if (nextOffset >= OFFSET_CAP) {
      capped = true;
      break;
    }
    url = page.next;
  }

  return { items, capped, sortedLocally: !useSort };
}

function sortByEnd(items) {
  return items.slice().sort((a, b) => {
    const left = a.itemEndDate || "";
    const right = b.itemEndDate || "";
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function dropEndsAfter(items, now, windowHours) {
  const limit = now.getTime() + windowHours * 60 * 60 * 1000;
  return items.filter((item) => {
    const end = Date.parse(item.itemEndDate || "");
    return Number.isFinite(end) && end <= limit;
  });
}

function dropUnderOneBid(items) {
  return items.filter((item) => Number(item.bidCount) >= 1);
}

function formatBidCount(bidCount) {
  const bids = Number(bidCount);
  if (!Number.isFinite(bids)) return "Bids unavailable";
  return `${bids} bid${bids === 1 ? "" : "s"}`;
}

function formatPrice(price) {
  if (!price || price.value == null || price.value === "") return "Price unavailable";
  const currency = typeof price.currency === "string" ? price.currency : "";
  const amount = Number(price.value);
  if (currency && Number.isFinite(amount)) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
    } catch {
      return `${currency} ${price.value}`;
    }
  }
  return currency ? `${currency} ${price.value}` : String(price.value);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function safeHttps(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function formatToronto(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TORONTO,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function render(items, generatedAt, capped, config) {
  const cards = items
    .map((item) => {
      const title = item.title || "Untitled listing";
      const href = safeHttps(item.itemWebUrl);
      const image = safeHttps(item.image && item.image.imageUrl);
      const endIso = item.itemEndDate || "";
      const endLabel = endIso ? formatToronto(endIso) : "No end time";
      const bidLabel = formatBidCount(item.bidCount);
      const priceLabel = formatPrice(item.currentBidPrice);
      const imageHtml = image
        ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(title)}">`
        : `<div class="placeholder">No image</div>`;
      const titleHtml = href
        ? `<a href="${escapeHtml(href)}">${escapeHtml(title)}</a>`
        : escapeHtml(title);
      return `<article class="card">${imageHtml}<div class="body"><h2>${titleHtml}</h2><p class="meta">${escapeHtml(bidLabel)}</p><p class="meta">${escapeHtml(priceLabel)}</p><time datetime="${escapeHtml(endIso)}">${escapeHtml(endLabel)}</time></div></article>`;
    })
    .join("");

  const capNote = capped ? " Result set stopped at the 10,000-item offset cap." : "";
  const generatedLabel = formatToronto(generatedAt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(config.keyword)} auctions ending within ${escapeHtml(config.windowHours)} hours</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #f4f4f5; color: #18181b; }
    header, main { padding: 16px; }
    header { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 1.4rem; margin: 0 0 8px; }
    p { margin: 0; color: #3f3f46; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; max-width: 1100px; margin: 0 auto; }
    .card { background: #fff; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
    .card img, .placeholder { width: 100%; aspect-ratio: 1; object-fit: contain; background: #fff; }
    .placeholder { display: grid; place-items: center; color: #71717a; }
    .body { padding: 12px 14px 16px; }
    h2 { font-size: 1rem; line-height: 1.35; margin: 0 0 8px; font-weight: 600; }
    time, .meta { display: block; color: #3f3f46; font-size: 0.92rem; }
    .meta { margin: 0 0 4px; color: #18181b; }
    a { color: #1d4ed8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (min-width: 800px) {
      header, main { padding: 24px; }
      .grid { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(config.keyword)} auctions</h1>
    <p>${items.length} listing${items.length === 1 ? "" : "s"}. Generated ${escapeHtml(generatedLabel)} (America/Toronto).${escapeHtml(capNote)}</p>
  </header>
  <main>
    <div class="grid">
      ${cards || "<p>No listings matched.</p>"}
    </div>
  </main>
</body>
</html>
`;
}

async function main() {
  const config = loadConfig(CONFIG_PATH);
  const started = new Date();
  const env = loadEnv(ENV_PATH);
  const clientId = env.EBAY_CLIENT_ID || "";
  const clientSecret = env.EBAY_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    throw new ApiFailure(0, []);
  }

  const token = await mintToken(clientId, clientSecret);
  let result = await collect(token, true, config, started);
  if (result.retryWithoutSort) {
    result = await collect(token, false, config, started);
    if (result.retryWithoutSort) throw new ApiFailure(400, [12034]);
    result.items = sortByEnd(result.items);
    result.sortedLocally = true;
  }

  result.items = dropUnderOneBid(dropEndsAfter(result.items, started, config.windowHours));
  const generatedAt = started.toISOString();
  fs.writeFileSync(REPORT_PATH, render(result.items, generatedAt, result.capped, config));

  const withBid = result.items.filter((item) => Number(item.bidCount) >= 1).length;
  const keywordPattern = new RegExp(config.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const titleHasSoccer = result.items.filter((item) => keywordPattern.test(item.title || "")).length;
  console.log(`count=${result.items.length}`);
  console.log(`html=${REPORT_PATH}`);
  console.log(`sorted=${result.sortedLocally ? "local-itemEndDate" : "endingSoonest"}`);
  console.log(`capped=${result.capped ? "yes" : "no"}`);
  console.log(`with_bid=${withBid}`);
  console.log(`title_has_keyword=${titleHasSoccer}`);
  result.items.slice(0, 5).forEach((item, index) => {
    const bids = Number.isFinite(Number(item.bidCount)) ? Number(item.bidCount) : "unknown";
    console.log(`${index + 1}\tbids=${bids}\t${item.title || ""}`);
  });
}

main().catch((error) => {
  if (error instanceof ConfigFailure) {
    console.error("config invalid");
    process.exit(1);
  }
  const status = error instanceof ApiFailure ? error.httpStatus : "none";
  const ids =
    error instanceof ApiFailure && error.errorIds.length
      ? error.errorIds.join(",")
      : "none";
  const oauth =
    error instanceof ApiFailure && error.oauthError ? error.oauthError : "none";
  console.error(`HTTP ${status} errorId ${ids} oauth ${oauth}`);
  process.exit(1);
});
