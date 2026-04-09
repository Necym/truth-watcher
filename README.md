# Render Truth Watcher

A Render-ready Node app that checks Donald Trump's public Truth Social profile for a new post and shows the current status in a small web dashboard. It can also send notifications to Discord and Telegram.

## Important note

Truth Social's Terms of Service say you may not access the service through automated or non-human means such as bots or scripts. Use this at your own risk and review the platform rules before deploying. Render's Blueprint file must be named `render.yaml` and live at the repo root. Render web services use build and start commands such as `npm install` and `npm start`, and environment variables are configured in the dashboard or Blueprint. citeturn133186search0turn133186search1turn133186search3

## Files

- `app.js` - Express server, Socket.IO dashboard, and Playwright polling loop
- `package.json` - Node dependencies and start script
- `render.yaml` - Render Blueprint for a single Node web service
- `.env.example` - local environment variable template

## Local run

```bash
npm install
npx playwright install chromium
npm start
```

Open `http://localhost:3000`.

## Deploy on Render

1. Push this folder to a GitHub repo.
2. In Render, create a new Blueprint or Web Service from that repo.
3. Confirm the service uses:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/health`
4. Add any secrets you want:
   - `DISCORD_WEBHOOK_URL`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. Deploy.

Render supports Node web services with `npm install` build commands and `npm start` or `node index.js` start commands. Blueprint configuration is done in a root `render.yaml` file. citeturn133186search0turn133186search2turn133186search4

## Environment variables

- `PROFILE_URL` - profile to monitor
- `POLL_MS` - polling interval in milliseconds
- `DISCORD_WEBHOOK_URL` - optional Discord webhook
- `TELEGRAM_BOT_TOKEN` - optional Telegram bot token
- `TELEGRAM_CHAT_ID` - optional Telegram chat id

## Caveats

- The first run only seeds the latest post. Alerts start on the next detected change.
- Very aggressive polling can increase load and may trigger blocking.
- This project intentionally does not include stealth, proxy rotation, auth bypassing, or CAPTCHA bypassing.
