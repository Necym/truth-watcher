import express from "express";
import { chromium } from "playwright";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const PROFILE_URL = process.env.PROFILE_URL || "https://truthsocial.com/@realDonaldTrump";
const POLL_MS = Number(process.env.POLL_MS || 10000);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

let browser = null;
let page = null;
let timer = null;

const status = {
  running: false,
  lastCheckAt: null,
  lastPostUrl: null,
  lastPostId: null,
  detections: [],
  errors: [],
  debug: {
    currentPageUrl: null,
    postCount: 0,
    samplePosts: [],
    lastSuccessfulFetchAt: null,
  },
};

function escapeHtml(input = "") {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function addError(err) {
  const message = err && err.message ? err.message : String(err);
  status.errors.unshift({
    at: new Date().toISOString(),
    error: message,
  });
  status.errors = status.errors.slice(0, 20);
  console.error(message);
}

function normalizeTruthUrl(href) {
  if (!href) return null;
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("/")) return "https://truthsocial.com" + href;
  return "https://truthsocial.com/" + href;
}

function sortPostsDescending(posts) {
  return [...posts].sort((a, b) => {
    const aId = Number(a.postId || 0);
    const bId = Number(b.postId || 0);
    return bId - aId;
  });
}

async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) return;

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });

  if (!response.ok) {
    throw new Error("Discord webhook failed: " + response.status);
  }
}

async function notifyNewPost(url) {
  if (!DISCORD_WEBHOOK_URL) return;
  await sendDiscord("New Trump Truth Social post detected\n" + url);
}

async function ensureBrowser() {
  if (browser && page) return;

  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 2200 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  });

  page = await context.newPage();
}

async function fetchLatestPost() {
  await ensureBrowser();

  await page.goto(PROFILE_URL, {
    waitUntil: "networkidle",
    timeout: 60000,
  });

  await page.waitForTimeout(10000);

  await page.waitForSelector('div[data-id]', { timeout: 15000 });

  const posts = await page.$$eval('div[data-id]', (elements) => {
    function normalizeHref(href) {
      if (!href) return null;
      if (href.startsWith("http://") || href.startsWith("https://")) return href;
      if (href.startsWith("/")) return "https://truthsocial.com" + href;
      return "https://truthsocial.com/" + href;
    }

    const out = [];

    for (const el of elements) {
      const postId = el.getAttribute("data-id");
      if (!postId) continue;

      const postLinkEl =
        el.querySelector('a[href*="/posts/"]') ||
        el.querySelector('a.hover\\:underline[href]');

      const href = postLinkEl ? postLinkEl.getAttribute("href") : null;
      const postUrl = normalizeHref(href);

      const textNode = el.querySelector('[data-testid="markup"]');
      const text = textNode ? (textNode.textContent || "").trim() : "";

      out.push({
        postId,
        postUrl,
        textPreview: text.slice(0, 180),
      });
    }

    return out;
  });

  status.debug.currentPageUrl = page.url();
  status.debug.postCount = posts.length;
  status.debug.samplePosts = posts.slice(0, 5);

  console.log("Page URL:", status.debug.currentPageUrl);
  console.log("Post count:", status.debug.postCount);
  console.log("Sample posts:", JSON.stringify(status.debug.samplePosts, null, 2));

  const validPosts = posts.filter((p) => p.postId && p.postUrl);
  if (!validPosts.length) {
    return null;
  }

  const sorted = sortPostsDescending(validPosts);
  const latest = sorted[0];

  status.debug.lastSuccessfulFetchAt = new Date().toISOString();

  return {
    latestId: latest.postId,
    latestUrl: latest.postUrl,
    latestTextPreview: latest.textPreview || "",
  };
}

async function pollOnce() {
  status.lastCheckAt = new Date().toISOString();

  try {
    const previousPostId = status.lastPostId;
    const latest = await fetchLatestPost();

    if (!latest || !latest.latestId || !latest.latestUrl) {
      throw new Error(
        "No valid posts found on page. Post containers were missing a usable data-id or /posts/ link."
      );
    }

    status.lastPostId = latest.latestId;
    status.lastPostUrl = latest.latestUrl;

    if (!previousPostId) {
      status.detections.unshift({
        at: new Date().toISOString(),
        url: latest.latestUrl,
        type: "baseline",
      });
      status.detections = status.detections.slice(0, 50);
      return;
    }

    if (latest.latestId !== previousPostId) {
      status.detections.unshift({
        at: new Date().toISOString(),
        url: latest.latestUrl,
        type: "new",
      });
      status.detections = status.detections.slice(0, 50);

      try {
        await notifyNewPost(latest.latestUrl);
      } catch (err) {
        addError(err);
      }
    }
  } catch (err) {
    addError(err);
  }
}

async function startWatcher() {
  if (timer) {
    status.running = true;
    return;
  }

  status.running = true;
  await pollOnce();

  timer = setInterval(() => {
    pollOnce().catch(addError);
  }, POLL_MS);
}

async function stopWatcher() {
  status.running = false;

  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function renderPage() {
  const safeProfileUrl = escapeHtml(PROFILE_URL);

  return [
    "<!doctype html>",
    "<html>",
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "    <title>Truth Social Watcher</title>",
    "    <style>",
    "      body { font-family: Arial, sans-serif; margin: 0; background: #0b1020; color: #e9eefb; }",
    "      .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }",
    "      .card { background: #121933; border: 1px solid #243056; border-radius: 16px; padding: 16px; margin-bottom: 16px; }",
    "      button { border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer; margin-right: 8px; }",
    "      .start { background: #56d364; color: #08110a; }",
    "      .stop { background: #ff7b72; color: #190706; }",
    "      code, a { color: #8ab4ff; word-break: break-all; }",
    "      ul { padding-left: 20px; }",
    "      .muted { color: #a9b5d1; }",
    "      .row { display: flex; gap: 12px; flex-wrap: wrap; }",
    "      .pill { background: #1c264b; border: 1px solid #2b3865; border-radius: 999px; padding: 6px 10px; }",
    "      pre { white-space: pre-wrap; word-break: break-word; background: #0d1430; padding: 12px; border-radius: 12px; border: 1px solid #243056; }",
    "    </style>",
    "  </head>",
    "  <body>",
    '    <div class="wrap">',
    "      <h1>Truth Social Watcher</h1>",
    '      <p class="muted">Current latest post + Discord alerts for <code>' + safeProfileUrl + "</code>.</p>",
    '      <div class="card">',
    '        <div style="margin-bottom:12px;">',
    '          <button id="startBtn" class="start">Start</button>',
    '          <button id="stopBtn" class="stop">Stop</button>',
    "        </div>",
    '        <div class="row">',
    '          <div class="pill">Running: <span id="running">false</span></div>',
    '          <div class="pill">Poll interval: ' + String(POLL_MS) + " ms</div>",
    '          <div class="pill">Last check: <span id="lastCheck">never</span></div>',
    "        </div>",
    "      </div>",
    '      <div class="card">',
    "        <h3>Current latest post</h3>",
    '        <p id="latestUrl" class="muted">None yet</p>',
    "      </div>",
    '      <div class="card">',
    "        <h3>Detections</h3>",
    '        <ul id="detections"></ul>',
    "      </div>",
    '      <div class="card">',
    "        <h3>Errors</h3>",
    '        <ul id="errors"></ul>',
    "      </div>",
    '      <div class="card">',
    "        <h3>Debug</h3>",
    '        <div class="muted">Page URL</div>',
    '        <pre id="debugPageUrl">None</pre>',
    '        <div class="muted">Post count</div>',
    '        <pre id="debugPostCount">0</pre>',
    '        <div class="muted">Sample posts</div>',
    '        <pre id="debugSamplePosts">[]</pre>',
    "      </div>",
    "    </div>",
    "    <script>",
    "      function setText(id, value) {",
    "        document.getElementById(id).textContent = value;",
    "      }",
    "      function renderList(id, items, mapper) {",
    "        var el = document.getElementById(id);",
    "        el.innerHTML = items.length ? items.map(mapper).join('') : '<li class=\"muted\">None</li>';",
    "      }",
    "      function renderStatus(status) {",
    "        setText('running', String(status.running));",
    "        setText('lastCheck', status.lastCheckAt || 'never');",
    "        var latest = document.getElementById('latestUrl');",
    "        if (status.lastPostUrl) {",
    "          latest.innerHTML = '<a href=\"' + status.lastPostUrl + '\" target=\"_blank\" rel=\"noopener noreferrer\">' + status.lastPostUrl + '</a>';",
    "        } else {",
    "          latest.textContent = 'None yet';",
    "        }",
    "        renderList('detections', status.detections || [], function (item) {",
    "          var label = item.type === 'baseline' ? 'baseline' : 'new';",
    "          return '<li><strong>' + label + '</strong>: <a href=\"' + item.url + '\" target=\"_blank\" rel=\"noopener noreferrer\">' + item.url + '</a> <span class=\"muted\">(' + item.at + ')</span></li>';",
    "        });",
    "        renderList('errors', status.errors || [], function (item) {",
    "          return '<li>' + item.error + ' <span class=\"muted\">(' + item.at + ')</span></li>';",
    "        });",
    "        setText('debugPageUrl', (status.debug && status.debug.currentPageUrl) || 'None');",
    "        setText('debugPostCount', String((status.debug && status.debug.postCount) || 0));",
    "        setText('debugSamplePosts', JSON.stringify((status.debug && status.debug.samplePosts) || [], null, 2));",
    "      }",
    "      async function refreshStatus() {",
    "        var res = await fetch('/health');",
    "        var data = await res.json();",
    "        renderStatus(data.status);",
    "      }",
    "      async function startWatcherClient() {",
    "        var res = await fetch('/start', { method: 'POST' });",
    "        var data = await res.json();",
    "        renderStatus(data.status);",
    "      }",
    "      async function stopWatcherClient() {",
    "        var res = await fetch('/stop', { method: 'POST' });",
    "        var data = await res.json();",
    "        renderStatus(data.status);",
    "      }",
    "      document.getElementById('startBtn').addEventListener('click', startWatcherClient);",
    "      document.getElementById('stopBtn').addEventListener('click', stopWatcherClient);",
    "      refreshStatus();",
    "      setInterval(refreshStatus, 3000);",
    "    </script>",
    "  </body>",
    "</html>",
  ].join("\n");
}

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, status });
});

app.post("/start", async (_req, res) => {
  try {
    await startWatcher();
    res.json({ ok: true, status });
  } catch (err) {
    addError(err);
    res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err),
      status,
    });
  }
});

app.post("/stop", async (_req, res) => {
  try {
    await stopWatcher();
    res.json({ ok: true, status });
  } catch (err) {
    addError(err);
    res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err),
      status,
    });
  }
});

app.get("/", (_req, res) => {
  res.type("html").send(renderPage());
});

app.listen(PORT, async () => {
  console.log("Watcher UI running on http://localhost:" + PORT);
  try {
    await startWatcher();
  } catch (err) {
    addError(err);
  }
});

process.on("SIGINT", async () => {
  await stopWatcher();
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});
