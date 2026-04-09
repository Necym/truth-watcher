import express from "express";
import http from "http";
import { Server } from "socket.io";
import { chromium } from "playwright";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const PROFILE_URL = process.env.PROFILE_URL || "https://truthsocial.com/@realDonaldTrump";
const POLL_MS = Number(process.env.POLL_MS || 10000);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

let browser;
let page;
let timer = null;

const status = {
  running: false,
  startedAt: null,
  lastCheckAt: null,
  lastPostUrl: null,
  lastPostId: null,
  detections: [],
  errors: [],
};

function escapeHtml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pushLimited(arr, item, limit) {
  arr.unshift(item);
  if (arr.length > limit) arr.length = limit;
}

function extractPostLinks(hrefs) {
  const set = new Set();
  for (let href of hrefs) {
    if (!href) continue;
    if (href.startsWith("/")) href = `https://truthsocial.com${href}`;
    if (/^https:\/\/truthsocial\.com\/@realDonaldTrump\/posts\/\d+$/.test(href)) {
      set.add(href);
    }
  }

  return [...set].sort((a, b) => {
    const aId = Number(a.split("/").pop());
    const bId = Number(b.split("/").pop());
    return bId - aId;
  });
}

async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook failed with status ${res.status}`);
  }
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Telegram send failed with status ${res.status}`);
  }
}

async function notifyNewPost(url) {
  const message = `New Trump Truth Social post detected\n${url}`;
  const results = await Promise.allSettled([
    sendDiscord(message),
    sendTelegram(message),
  ]);

  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || String(result.reason));

  if (failures.length) {
    pushLimited(status.errors, {
      at: new Date().toISOString(),
      error: failures.join(" | "),
    }, 20);
  }
}

async function ensureBrowser() {
  if (browser && page) return;

  browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 2000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  });

  page = await context.newPage();
}

async function fetchLatestPost() {
  await ensureBrowser();
  await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);

  const hrefs = await page.$$eval("a", (els) =>
    els.map((a) => a.href || a.getAttribute("href") || "").filter(Boolean)
  );

  const postLinks = extractPostLinks(hrefs);
  if (!postLinks.length) return null;

  const latestUrl = postLinks[0];
  const latestId = latestUrl.split("/").pop();
  return { latestUrl, latestId };
}

async function pollOnce() {
  status.lastCheckAt = new Date().toISOString();

  try {
    const latest = await fetchLatestPost();
    if (!latest) throw new Error("No matching post links found on profile page");

    if (!status.lastPostId) {
      status.lastPostId = latest.latestId;
      status.lastPostUrl = latest.latestUrl;
    } else if (latest.latestId !== status.lastPostId) {
      status.lastPostId = latest.latestId;
      status.lastPostUrl = latest.latestUrl;

      const event = { at: new Date().toISOString(), url: latest.latestUrl };
      pushLimited(status.detections, event, 50);
      io.emit("new_post", event);
      await notifyNewPost(latest.latestUrl);
    }
  } catch (error) {
    pushLimited(status.errors, {
      at: new Date().toISOString(),
      error: error?.message || String(error),
    }, 20);
  }

  io.emit("status", status);
}

async function startWatcher() {
  if (timer) return;
  status.running = true;
  status.startedAt = status.startedAt || new Date().toISOString();
  await pollOnce();
  timer = setInterval(() => {
    pollOnce().catch(() => {});
  }, POLL_MS);
}

async function stopWatcher() {
  status.running = false;
  if (timer) clearInterval(timer);
  timer = null;
}

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, status });
});

app.post("/start", async (_req, res) => {
  await startWatcher();
  res.json({ ok: true, status });
});

app.post("/stop", async (_req, res) => {
  await stopWatcher();
  res.json({ ok: true, status });
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Truth Social Watcher</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; background: #0b1020; color: #e9eefb; }
      .wrap { max-width: 960px; margin: 0 auto; padding: 24px; }
      .card { background: #121933; border: 1px solid #243056; border-radius: 16px; padding: 16px; margin-bottom: 16px; }
      button { border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer; margin-right: 8px; }
      .start { background: #56d364; color: #08110a; }
      .stop { background: #ff7b72; color: #190706; }
      code, a { color: #8ab4ff; }
      ul { padding-left: 20px; }
      .muted { color: #a9b5d1; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; }
      .pill { background: #1c264b; border: 1px solid #2b3865; border-radius: 999px; padding: 6px 10px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Truth Social Watcher</h1>
      <p class="muted">Web dashboard plus optional Discord and Telegram notifications for <code>${escapeHtml(PROFILE_URL)}</code>.</p>

      <div class="card">
        <div style="margin-bottom:12px;">
          <button class="start" onclick="startWatcher()">Start</button>
          <button class="stop" onclick="stopWatcher()">Stop</button>
        </div>
        <div class="row">
          <div class="pill">Running: <span id="running">false</span></div>
          <div class="pill">Poll interval: ${POLL_MS} ms</div>
          <div class="pill">Last check: <span id="lastCheck">never</span></div>
        </div>
      </div>

      <div class="card">
        <h3>Latest detected post</h3>
        <p id="latestUrl" class="muted">None yet</p>
      </div>

      <div class="card">
        <h3>Detections</h3>
        <ul id="detections"></ul>
      </div>

      <div class="card">
        <h3>Errors</h3>
        <ul id="errors"></ul>
      </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      const socket = io();

      function setText(id, value) {
        document.getElementById(id).textContent = value;
      }

      function renderList(id, items, mapper) {
        const el = document.getElementById(id);
        el.innerHTML = items.length ? items.map(mapper).join("") : '<li class="muted">None</li>';
      }

      function renderStatus(status) {
        setText('running', String(status.running));
        setText('lastCheck', status.lastCheckAt || 'never');

        const latest = document.getElementById('latestUrl');
        if (status.lastPostUrl) {
          latest.innerHTML = '<a href="' + status.lastPostUrl + '" target="_blank" rel="noopener noreferrer">' + status.lastPostUrl + '</a>';
        } else {
          latest.textContent = 'None yet';
        }

        renderList('detections', status.detections || [], (item) =>
          '<li><a href="' + item.url + '" target="_blank" rel="noopener noreferrer">' + item.url + '</a> <span class="muted">(' + item.at + ')</span></li>'
        );

        renderList('errors', status.errors || [], (item) =>
          '<li>' + item.error + ' <span class="muted">(' + item.at + ')</span></li>'
        );
      }

      socket.on('status', renderStatus);
      socket.on('new_post', (data) => {
        alert('New post detected:\n' + data.url);
      });

      async function startWatcher() {
        const response = await fetch('/start', { method: 'POST' });
        const data = await response.json();
        renderStatus(data.status);
      }

      async function stopWatcher() {
        const response = await fetch('/stop', { method: 'POST' });
        const data = await response.json();
        renderStatus(data.status);
      }

      fetch('/health').then((r) => r.json()).then((data) => renderStatus(data.status));
    </script>
  </body>
</html>`);
});

io.on("connection", (socket) => {
  socket.emit("status", status);
});

server.listen(PORT, async () => {
  console.log(`Watcher running on port ${PORT}`);
  await startWatcher();
});

process.on("SIGINT", async () => {
  await stopWatcher();
  if (browser) await browser.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await stopWatcher();
  if (browser) await browser.close();
  process.exit(0);
});
