# nk-cli

A professional Node.js + **Puppeteer** scraper that targets the
`/hentai` category of `https://nekopoi.care/`. The site sits behind a
WAF, so plain HTTP requests cannot return the real DOM — this CLI drives
a real Chromium instance with stealth hardening to render pages exactly
as a normal browser would.

## Highlights

- **Puppeteer + stealth** browser context (graceful fallback to vanilla
  `puppeteer` if `puppeteer-extra` is unavailable).
- ES Module project (`"type": "module"`), 2-space indentation, JSDoc on
  every exported function.
- Resume-friendly: every page checkpoint is written atomically; SIGINT,
  SIGTERM, uncaught exceptions and unhandled rejections all flush
  in-flight progress before exit.
- Deduplicated listing collection (by `slug`).
- Retry/backoff around every navigation and DOM extraction.
- Pretty-formatted JSON output.

## Project Layout

```
.
├─ main.js
├─ package.json
├─ src/
│  ├─ browser/
│  │  └─ launcher.js          # Puppeteer launch + stealth + page setup
│  ├─ config/
│  │  └─ index.js             # Env-driven configuration
│  ├─ parsers/
│  │  ├─ pageItems.js         # /category/hentai listing parser
│  │  ├─ contentBody.js       # .konten metadata parser
│  │  ├─ nkPlayer.js          # #nk-player streaming parser
│  │  └─ downloadSection.js   # .nk-download-section parser
│  ├─ services/
│  │  ├─ listingScraper.js    # End-to-end listing pipeline
│  │  └─ detailScraper.js     # End-to-end detail pipeline
│  └─ utils/
│     ├─ logger.js            # Stdout + daily file logger
│     ├─ storage.js           # Atomic JSON read/write
│     ├─ retry.js             # Exponential backoff helper
│     └─ shutdown.js          # Graceful shutdown registry
├─ output/                    # JSON outputs are written here
└─ logs/                      # Daily log files are written here
```

## Install

```bash
npm install
```

This downloads a matching Chromium build (Puppeteer's default
behaviour). If you are on a corporate network or air-gapped host you may
need to set `PUPPETEER_DOWNLOAD_BASE_URL` or pre-stage the Chromium
binary.

## Run

Full pipeline (listing + details):

```bash
npm run scrape
# or
node main.js
```

Phase-only runs:

```bash
node main.js --only=list      # only the /category/hentai pagination
node main.js --only=detail    # only the per-slug detail extraction
```

## Configuration

Every value can be overridden via environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NK_BASE_URL` | `https://nekopoi.care` | Site root used to build detail URLs. |
| `NK_HOME_URL` | `https://nekopoi.care/` | Homepage used to find the Hentai menu. |
| `NK_USER_AGENT` | Realistic Chrome UA | Override the user-agent string. |
| `NK_HEADLESS` | `true` | Set `false` to watch the browser. |
| `NK_VIEWPORT_WIDTH` | `1366` | Default viewport width. |
| `NK_VIEWPORT_HEIGHT` | `768` | Default viewport height. |
| `NK_NAV_TIMEOUT_MS` | `60000` | Navigation/selector timeout. |
| `NK_MAX_LIST_PAGES` | `9999` | Hard cap on listing pages. |
| `NK_MAX_DETAIL_ITEMS` | `0` (no cap) | Hard cap on detail pages per run. |
| `NK_RETRY_ATTEMPTS` | `3` | Retries per page before skipping. |
| `NK_RETRY_BASE_DELAY_MS` | `2500` | Base backoff delay (doubled each retry). |
| `NK_POLITE_DELAY_MS` | `800` | Pause between successful requests. |
| `NK_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |

## Outputs

- `output/hanimeLists.json` — full listing (deduped by `slug`).
- `output/hanimeDetails.json` — final merged detail records.
- `output/hanimeDetails.progress.json` — per-slug checkpoint file used
  to resume an interrupted detail run.

## Reliability Notes

- The listing scraper saves after **every** page so a crash or `Ctrl+C`
  loses at most the page currently in flight.
- The detail scraper checkpoints after **every** slug.
- A SIGINT/SIGTERM (or uncaught exception) flushes the in-memory state
  to disk synchronously before the process exits.
- Every navigation is wrapped in `withRetry(...)` with exponential
  backoff so transient WAF challenges don't abort the run.
