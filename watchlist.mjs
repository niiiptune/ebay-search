import fs from "node:fs";
import http from "node:http";

const ROOT = "/Users/hni/Developer/ebay-search";
const ENV_PATH = `${ROOT}/.env`;
const TOKEN_PATH = `${ROOT}/.ebay-user-token.json`;
const REPORT_PATH = `${ROOT}/watchlist.html`;
const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const AUTH_URL = "https://auth.ebay.com/oauth2/authorize";
const TRADING_URL = "https://api.ebay.com/ws/api.dll";
const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/buy.order.readonly",
];
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 8787;
const CALLBACK_PATH = "/ebay-callback";
const DECLINED_PATH = "/ebay-declined";
const ACCEPTED_URL = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const DECLINED_URL = `http://localhost:${CALLBACK_PORT}${DECLINED_PATH}`;
const TORONTO = "America/Toronto";
const LOGIN_WAIT_MS = 10 * 60 * 1000;

class ApiFailure extends Error {
  constructor(status, errorIds, oauthError = "") {
    super("api failure");
    this.httpStatus = status;
    this.errorIds = errorIds;
    this.oauthError = oauthError;
  }
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

function oauthErrorCode(json) {
  return json && typeof json.error === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(json.error)
    ? json.error
    : "";
}

async function readTokenError(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return "";
  }
  try {
    return oauthErrorCode(JSON.parse(text));
  } catch {
    return "";
  }
}

function saveToken(token) {
  const body = JSON.stringify(
    {
      access_token: token.access_token,
      refresh_token: token.refresh_token || "",
      access_expires_at: token.access_expires_at,
      refresh_expires_at: token.refresh_expires_at || 0,
      scope: SCOPES.join(" "),
    },
    null,
    2,
  );
  const temporary = `${TOKEN_PATH}.tmp`;
  fs.writeFileSync(temporary, body, { mode: 0o600 });
  fs.renameSync(temporary, TOKEN_PATH);
  fs.chmodSync(TOKEN_PATH, 0o600);
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    if (!parsed || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function tokenFromResponse(json, previous) {
  const accessExpiresIn = Number(json.expires_in);
  const refreshExpiresIn = Number(json.refresh_token_expires_in);
  const now = Date.now();
  return {
    access_token: json.access_token,
    refresh_token:
      typeof json.refresh_token === "string" && json.refresh_token.length > 0
        ? json.refresh_token
        : previous?.refresh_token || "",
    access_expires_at: now + (Number.isFinite(accessExpiresIn) ? accessExpiresIn : 0) * 1000,
    refresh_expires_at:
      Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
        ? now + refreshExpiresIn * 1000
        : previous?.refresh_expires_at || 0,
  };
}

async function postToken(clientId, clientSecret, params) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  if (!response.ok) {
    throw new ApiFailure(response.status, [], await readTokenError(response));
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw new ApiFailure(response.status, []);
  }
  if (!json || typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new ApiFailure(response.status, [], oauthErrorCode(json));
  }
  return json;
}

async function refreshToken(clientId, clientSecret, current) {
  const json = await postToken(clientId, clientSecret, {
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
    scope: SCOPES.join(" "),
  });
  const next = tokenFromResponse(json, current);
  saveToken(next);
  return next;
}

function accessIsUsable(token) {
  return Boolean(token?.access_token) && Number(token.access_expires_at) - 60_000 > Date.now();
}

function refreshIsUsable(token) {
  if (!token?.refresh_token) return false;
  const expiry = Number(token.refresh_expires_at);
  return !Number.isFinite(expiry) || expiry === 0 || expiry - 60_000 > Date.now();
}

function approvalUrl(clientId, ruName) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", ruName);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  return url.toString();
}

function missingRuNameInstructions() {
  return [
    "EBAY_RUNAME is missing. eBay's authorization-code sign-in requires a Production RuName, and this script will not start the browser login without one.",
    "Create it on the Production keyset that matches the client id already in .env:",
    "1. Open https://developer.ebay.com/my/keys and select that Production keyset.",
    "2. Open User Tokens.",
    "3. Add an eBay Redirect URL. The form requires a privacy policy URL you control, plus these two addresses:",
    `   Auth accepted URL: ${ACCEPTED_URL}`,
    `   Auth declined URL: ${DECLINED_URL}`,
    "4. Save. Copy the RuName eBay assigns. It is the name eBay shows for that redirect, not the URL itself.",
    "5. Add EBAY_RUNAME=<that RuName> to /Users/hni/Developer/ebay-search/.env only. Do not put it in config.json.",
    "6. Run: node /Users/hni/Developer/ebay-search/watchlist.mjs",
  ].join("\n");
}

function waitForCode(expectedPath) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url || "/", `http://${CALLBACK_HOST}`);
      if (url.pathname === DECLINED_PATH) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<p>eBay sign-in was declined. You can close this window.</p>");
        server.close();
        reject(new ApiFailure(0, [], "access_denied"));
        return;
      }
      if (url.pathname !== expectedPath) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const code = url.searchParams.get("code") || "";
      const oauthError = url.searchParams.get("error") || "";
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<p>eBay sign-in finished. You can close this window.</p>");
      server.close();
      if (!code) {
        const safe = /^[A-Za-z0-9_.-]{1,40}$/.test(oauthError) ? oauthError : "access_denied";
        reject(new ApiFailure(0, [], safe));
        return;
      }
      resolve(code);
    });
    server.listen(CALLBACK_PORT, CALLBACK_HOST);
    const timer = setTimeout(() => {
      server.close();
      reject(new ApiFailure(0, [], "login_timeout"));
    }, LOGIN_WAIT_MS);
    server.on("close", () => clearTimeout(timer));
    server.on("error", () => {
      clearTimeout(timer);
      reject(new ApiFailure(0, [], "login_listener_failed"));
    });
  });
}

async function signIn(clientId, clientSecret, ruName) {
  const url = approvalUrl(clientId, ruName);
  console.log(`approval_url=${url}`);
  const code = await waitForCode(CALLBACK_PATH);
  const json = await postToken(clientId, clientSecret, {
    grant_type: "authorization_code",
    code,
    redirect_uri: ruName,
  });
  const token = tokenFromResponse(json, null);
  saveToken(token);
  return token;
}

function decodeXml(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function inner(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1] : "";
}

function text(block, tag) {
  const value = inner(block, tag);
  return value ? decodeXml(value.trim()) : "";
}

function attr(block, tag, name) {
  const match = block.match(new RegExp(`<${tag}\\b([^>]*)>`, "i"));
  if (!match) return "";
  const found = match[1].match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return found ? decodeXml(found[1]) : "";
}

function errorCodes(xml) {
  return [...xml.matchAll(/<ErrorCode>(\d+)<\/ErrorCode>/g)].map((match) => match[1]);
}

function parseItems(xml) {
  const watchList = inner(xml, "WatchList");
  if (!watchList) return { items: [], pages: 1 };
  const pages = Number(text(watchList, "TotalNumberOfPages")) || 1;
  const items = [];
  for (const match of watchList.matchAll(/<Item\b[^>]*>([\s\S]*?)<\/Item>/g)) {
    const item = match[1];
    const selling = inner(item, "SellingStatus");
    const listing = inner(item, "ListingDetails");
    const priceBlock = selling || item;
    const amount = text(priceBlock, "CurrentPrice") || text(item, "StartPrice");
    const currency =
      attr(priceBlock, "CurrentPrice", "currencyID") || attr(item, "StartPrice", "currencyID");
    const bidText = text(selling, "BidCount") || text(item, "BidCount");
    items.push({
      title: text(item, "Title") || "Untitled listing",
      price: amount,
      currency,
      bidCount: bidText === "" ? null : Number(bidText),
      endTime: text(listing, "EndTime") || text(item, "EndTime"),
      url: text(listing, "ViewItemURL") || text(item, "ViewItemURL"),
      itemId: text(item, "ItemID"),
    });
  }
  return { items, pages };
}

async function fetchWatchPage(token, pageNumber) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <DetailLevel>ReturnAll</DetailLevel>
  <WatchList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </WatchList>
</GetMyeBayBuyingRequest>`;
  const response = await fetch(TRADING_URL, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "GetMyeBayBuying",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1489",
      "X-EBAY-API-IAF-TOKEN": token,
      "Content-Type": "text/xml",
    },
    body,
  });
  const xml = await response.text();
  if (!response.ok) {
    throw new ApiFailure(response.status, errorCodes(xml));
  }
  if (/<Ack>Failure<\/Ack>/.test(xml)) {
    throw new ApiFailure(response.status, errorCodes(xml));
  }
  return parseItems(xml);
}

async function fetchWatchlist(accessToken) {
  const items = [];
  let page = 1;
  let pages = 1;
  while (page <= pages && page <= 20) {
    const result = await fetchWatchPage(accessToken, page);
    items.push(...result.items);
    pages = result.pages;
    page += 1;
  }
  return items;
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

function formatMoney(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "Price unavailable";
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
    } catch {
      return `${currency} ${amount}`;
    }
  }
  return String(amount);
}

function render(items, generatedAt) {
  const cards = items
    .map((item) => {
      const href = safeHttps(item.url) || (item.itemId ? `https://www.ebay.com/itm/${encodeURIComponent(item.itemId)}` : "");
      const title = item.title || "Untitled listing";
      const titleHtml = href
        ? `<a href="${escapeHtml(href)}">${escapeHtml(title)}</a>`
        : escapeHtml(title);
      const bidHtml =
        item.bidCount == null || !Number.isFinite(item.bidCount)
          ? ""
          : `<p class="meta">${escapeHtml(`${item.bidCount} bid${item.bidCount === 1 ? "" : "s"}`)}</p>`;
      const endIso = item.endTime || "";
      return `<article class="card"><div class="body"><h2>${titleHtml}</h2><p class="meta">${escapeHtml(formatMoney(item.price, item.currency))}</p>${bidHtml}<time datetime="${escapeHtml(endIso)}">${escapeHtml(endIso ? formatToronto(endIso) : "No end time")}</time></div></article>`;
    })
    .join("");
  const generatedLabel = formatToronto(generatedAt);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>eBay watchlist</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f4f4f5; color: #18181b; }
    header, main { padding: 16px; }
    header, .grid { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 1.4rem; margin: 0 0 8px; }
    header p, time { margin: 0; color: #3f3f46; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    .card { background: #fff; border-radius: 12px; }
    .body { padding: 12px 14px 16px; }
    h2 { font-size: 1rem; line-height: 1.35; margin: 0 0 8px; font-weight: 600; }
    .meta { margin: 0 0 4px; }
    time { display: block; font-size: 0.92rem; }
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
    <h1>eBay watchlist</h1>
    <p>${items.length} listing${items.length === 1 ? "" : "s"}. Generated ${escapeHtml(generatedLabel)} (America/Toronto).</p>
  </header>
  <main>
    <div class="grid">
      ${cards || "<p>No watched listings.</p>"}
    </div>
  </main>
</body>
</html>
`;
}

async function ensureToken(clientId, clientSecret, ruName) {
  let token = loadToken();
  if (accessIsUsable(token)) return token;
  if (refreshIsUsable(token)) {
    try {
      return await refreshToken(clientId, clientSecret, token);
    } catch (error) {
      if (!(error instanceof ApiFailure)) throw error;
    }
  }
  if (!ruName) {
    console.log(missingRuNameInstructions());
    process.exit(2);
  }
  return signIn(clientId, clientSecret, ruName);
}

async function main() {
  const env = loadEnv(ENV_PATH);
  const clientId = env.EBAY_CLIENT_ID || "";
  const clientSecret = env.EBAY_CLIENT_SECRET || "";
  const ruName = env.EBAY_RUNAME || "";
  if (!clientId || !clientSecret) {
    throw new ApiFailure(0, []);
  }
  const token = await ensureToken(clientId, clientSecret, ruName);
  const items = await fetchWatchlist(token.access_token);
  const generatedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_PATH, render(items, generatedAt));
  console.log(`count=${items.length}`);
  console.log(`html=${REPORT_PATH}`);
}

main().catch((error) => {
  const status = error instanceof ApiFailure ? error.httpStatus : "none";
  const ids =
    error instanceof ApiFailure && error.errorIds.length ? error.errorIds.join(",") : "none";
  const oauth = error instanceof ApiFailure && error.oauthError ? error.oauthError : "none";
  console.error(`HTTP ${status} errorId ${ids} oauth ${oauth}`);
  process.exit(1);
});
