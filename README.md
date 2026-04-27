# nk-cli

A professional Node.js + **Puppeteer** scraper that targets multiple
categories of `https://nekopoi.care/` (`/hentai`, `/2d-animation`,
`/3d-hentai`, `/jav-cosplay`, `/jav`, and the `/hentai-list` A–Z index).
The site sits behind a WAF, so plain HTTP requests cannot return the
real DOM — this CLI drives a real Chromium instance with stealth
hardening to render pages exactly as a normal browser would.

## Highlights

- **`rebrowser-puppeteer` + stealth** browser context. The `puppeteer`
  dependency is aliased to
  [`rebrowser-puppeteer`](https://www.npmjs.com/package/rebrowser-puppeteer)
  in `package.json`, which patches the
  [`Runtime.Enable` CDP leak](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries)
  exploited by SafeLine WAF, Cloudflare, DataDome and similar
  anti-bot stacks. `puppeteer-extra-plugin-stealth` is layered on top
  for the standard `webdriver`/`navigator` fingerprint scrubs, with a
  graceful fallback to bare `puppeteer` if the plugin is unavailable.
- ES Module project (`"type": "module"`), 2-space indentation, JSDoc on
  every exported function.
- **Bandwidth-efficient navigation**: Puppeteer request interception
  aborts `image | media | font` requests by default
  (`NK_BLOCK_RESOURCES`), so each page loads only the HTML/CSS/JS the
  parsers actually need.
- **WAF-aware waits**: the homepage `goto` uses `networkidle2` and a
  separate `NK_WAF_TIMEOUT_MS` (default 120s) gates the
  `Hentai`-link / listing / detail DOM checks. The wait resolves the
  moment the challenge clears, so steady-state navigation is unaffected.
- **Coloured local-time logs** via [`chalk`](https://www.npmjs.com/package/chalk).
  Terminal output uses local-clock timestamps
  (`YYYY-MM-DD HH:mm:ss.SSS`) and per-level colours; file logs stay
  plain text. The logger explicitly forces a chalk colour level on
  Windows TTYs so PowerShell / Windows Terminal pick up the ANSI codes
  reliably (see `NK_LOG_COLOR` below).
- **Sub-command CLI** via [`commander`](https://www.npmjs.com/package/commander)
  with one command per scraping target (`scrape:hanime`,
  `scrape:2d-animation`, `scrape:3d-hentai`, `scrape:jav-cosplay`,
  `scrape:jav`, `scrape:hanimeindex`, `scrape:info`).
- **Interactive prompt** between the listing and detail phases via
  [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts):
  the user is asked whether to continue. Set `NK_AUTO_DETAIL=yes|no`
  for non-interactive runs.
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
│  ├─ cli/
│  │  ├─ parser.js            # Commander-based sub-command dispatcher
│  │  └─ prompt.js            # Inquirer wrapper (with non-TTY fallback)
│  ├─ config/
│  │  ├─ index.js             # Env-driven configuration (browser, paths, …)
│  │  └─ categories.js        # Registry of every scraping target
│  ├─ parsers/
│  │  ├─ pageItems.js         # /category/<slug> listing parser
│  │  ├─ contentBody.js       # .konten metadata parser
│  │  ├─ nkPlayer.js          # #nk-player streaming parser
│  │  ├─ downloadSection.js   # .nk-download-section parser
│  │  └─ azList.js            # /category/hentai-list A–Z index parser
│  ├─ services/
│  │  ├─ listingScraper.js    # Generic listing pipeline (any category)
│  │  ├─ detailScraper.js     # Generic detail-page pipeline
│  │  └─ azScraper.js         # A–Z index page pipeline
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

The CLI exposes one sub-command per scraping target. After the listing
phase finishes the program asks whether to continue to the detail-page
phase ("Yes / No"). Pick the relevant target:

```bash
# Category listing scrapers (followed by an interactive Y/N prompt)
node main.js scrape:hanime          # /category/hentai
node main.js scrape:2d-animation    # /category/2d-animation
node main.js scrape:3d-hentai       # /category/3d-hentai
node main.js scrape:jav-cosplay     # /category/jav-cosplay
node main.js scrape:jav             # /category/jav

# A–Z index (no detail phase — the tooltip card already carries metadata)
node main.js scrape:hanimeindex     # /category/hentai-list

# Detail-only runs (skip the listing phase)
node main.js scrape:info --slug some-anime-slug
node main.js scrape:info --slug some-anime-slug --category 2d-animation
node main.js scrape:info --page 2d-animation     # uses 2dAnimationLists.json
```

Set `NK_AUTO_DETAIL=yes` to bypass the interactive prompt and chain the
detail phase automatically (handy for cron / CI). `NK_AUTO_DETAIL=no`
stops after the listing without asking. Run `node main.js --help` to
list every command and its options.

## Configuration

Every value can be overridden via environment variables. The CLI loads a
project-local `.env` file automatically at startup (powered by
[`dotenv`](https://www.npmjs.com/package/dotenv)). To customise a run,
copy the example file and edit it:

```bash
cp .env.example .env
```

Available variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NK_BASE_URL` | `https://nekopoi.care` | Site root used to build detail URLs. |
| `NK_HOME_URL` | `https://nekopoi.care/` | Homepage used to find the Hentai menu. |
| `NK_USER_AGENT` | Realistic Chrome UA | Override the user-agent string. |
| `NK_HEADLESS` | `true` | Set `false` to watch the browser. |
| `NK_VIEWPORT_WIDTH` | `1366` | Default viewport width. |
| `NK_VIEWPORT_HEIGHT` | `768` | Default viewport height. |
| `NK_NAV_TIMEOUT_MS` | `60000` | Navigation/selector timeout. |
| `NK_WAF_TIMEOUT_MS` | `120000` | Generous wait for the SafeLine WAF challenge gate (homepage entry, Hentai-link wait, listing/detail DOM). Resolves immediately once the gate clears. |
| `NK_BLOCK_RESOURCES` | `image,media,font` | Comma-separated resource types aborted at the request layer (allowed: `document`, `stylesheet`, `image`, `media`, `font`, `script`, `texttrack`, `xhr`, `fetch`, `eventsource`, `websocket`, `manifest`, `other`). Set to `none` to disable. |
| `NK_MAX_LIST_PAGES` | `9999` | Hard cap on listing pages. |
| `NK_MAX_DETAIL_ITEMS` | `0` (no cap) | Hard cap on detail pages per run. |
| `NK_RETRY_ATTEMPTS` | `3` | Retries per page before skipping. |
| `NK_RETRY_BASE_DELAY_MS` | `2500` | Base backoff delay (doubled each retry). |
| `NK_POLITE_DELAY_MS` | `800` | Pause between successful requests. |
| `NK_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `NK_LOG_COLOR` | _(auto)_ | `auto` (default), `0`/`false` to disable, `1`/`true` for 16-colour ANSI, `2` for 256-colour, `3` for truecolor. The logger forces level `1` on Windows TTYs because chalk's auto-detection misfires inside PowerShell. `FORCE_COLOR=1` works as a fallback. File logs are always plain text. |
| `NK_AUTO_DETAIL` | _(unset)_ | `yes` / `no` to skip the interactive Y/N prompt between phases. Unset → interactive prompt (or auto-`no` when stdin is not a TTY). |
| `NK_RESUME` | _(unset)_ | Pre-answer the resume prompt: `yes` / `no` / `cancel`. Unset → interactive prompt (or `cancel` when stdin is not a TTY). |
| `NK_RESUME_OVERWRITE` | _(unset)_ | Pre-answer the destructive overwrite prompt: `yes` / `no` / `cancel`. Unset → interactive prompt (or `cancel` when stdin is not a TTY). |
| `NK_OUTPUT_DIR` | `output` | Where `hanimeLists.json` / `hanimeDetails.json` are written. |
| `NK_LOGS_DIR` | `logs` | Where the daily logger writes log files. |
| `NK_USER_DATA_DIR` | `.browser_data` | Persistent Puppeteer profile directory. |
| `NK_CHROME_EXECUTABLE_PATH` | _(unset)_ | Path to a real Chrome/Chromium binary. Bundled Chromium has fingerprint quirks; a real Chrome is harder for WAFs to flag. |
| `NK_CHROME_CHANNEL` | _(unset)_ | Puppeteer browser channel hint (e.g. `chrome`). |
| `REBROWSER_PATCHES_RUNTIME_FIX_MODE` | `addBinding` | rebrowser-patches `Runtime.Enable` fix mode. Other values: `alwaysIsolated`, `0` (disabled). |
| `REBROWSER_PATCHES_SOURCE_URL` | `app.js` | Replace the telltale `pptr:` script URL on injected sources. |
| `REBROWSER_PATCHES_UTILITY_WORLD_NAME` | `1` | Generic name for the Puppeteer utility world. |

## Outputs

File names follow the pattern `<categoryKey>Lists.json` /
`<categoryKey>Details.json`:

| Command | Listing file | Detail file |
| --- | --- | --- |
| `scrape:hanime` | `output/hanimeLists.json` | `output/hanimeDetails.json` |
| `scrape:2d-animation` | `output/2dAnimationLists.json` | `output/2dAnimationDetails.json` |
| `scrape:3d-hentai` | `output/3dHentaiLists.json` | `output/3dHentaiDetails.json` |
| `scrape:jav-cosplay` | `output/javCosplayLists.json` | `output/javCosplayDetails.json` |
| `scrape:jav` | `output/javLists.json` | `output/javDetails.json` |
| `scrape:hanimeindex` | `output/hanimeIndex.json` | _(no detail phase)_ |

A `*Details.progress.json` data checkpoint file is written next to each
detail file (so previously-scraped slugs survive an interrupted run),
and a small `*.progress.meta.json` file alongside every output captures
where the loop stopped (`command`, `status`, `lastCompletedIndex`,
`totalItems`, `outputFile`, `updatedAt`) so the resume prompt can
continue from the last successful index.

## Resume / Pause Flow

Every scraper command can be safely paused and resumed:

- All checkpoint writes are atomic (`*.tmp` + `fs.rename`), so a SIGINT,
  crash or kill never leaves a half-written file.
- A reusable graceful shutdown manager (`src/utils/shutdown.js`)
  handles `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGBREAK`,
  `uncaughtException` and `unhandledRejection`. On the first signal it
  flips a global `AbortSignal`, runs every registered sync handler
  (atomic JSON flush of partial results + progress meta), then awaits
  registered async handlers (closing the Puppeteer browser) before
  exiting. A second signal short-circuits to an immediate exit so the
  process is never un-killable.
- A reusable progress manager (`src/utils/progressManager.js`) writes
  the `*.progress.meta.json` snapshot after every successful loop
  iteration. The shape matches the spec:

  ```json
  {
    "command": "scrape:hanime:detail",
    "status": "interrupted",
    "lastCompletedIndex": 123,
    "totalItems": 500,
    "outputFile": "/abs/output/hanimeDetails.json",
    "updatedAt": "2026-04-27T10:03:00.000Z"
  }
  ```

  `status` cycles through `running` → `completed` (clean finish) /
  `interrupted` (signal) / `failed` (uncaught error).

When the CLI starts and finds an unfinished meta whose `command`
matches the current command, it asks:

```
An unfinished scraping progress was found. Continue from the last saved index?
> Yes
  No
  Cancel
```

- **Yes**: resume from `lastCompletedIndex + 1`. Already-completed items
  are skipped, existing output is preserved.
- **No**: a destructive-action confirmation follows
  (`This will overwrite the previously saved progress and output data.
  Are you sure?`). On Yes, the previous meta + output are archived to a
  timestamped sibling (`*.archive-<ISO>.json`) and a fresh run starts.
  On No / Cancel, nothing is overwritten and the program exits cleanly.
- **Cancel**: exit immediately without modifying any progress or output
  file.

The prompts are powered by `@inquirer/prompts.select` and respect two
non-interactive overrides for cron / CI use:

| Variable | Values | Effect |
| --- | --- | --- |
| `NK_RESUME` | `yes` / `no` / `cancel` | Pre-answer the resume prompt. |
| `NK_RESUME_OVERWRITE` | `yes` / `no` / `cancel` | Pre-answer the destructive overwrite prompt. |

When stdin is not a TTY and neither variable is set, both prompts
default to `cancel` — the safest answer because it never mutates an
existing progress or output file.

## Tests

The repository ships with a `node:test`-based suite that covers the
four DOM parsers and runs the listing + detail scrapers end-to-end
against a local fixture HTTP server (no live network required):

```bash
npm test
```

The integration test uses `NK_OUTPUT_DIR` to redirect output into a
temp directory, so it does not touch the real `output/` JSON files.
It asserts that:

- `output/hanimeLists.json` contains **at least 10** listing entries.
- `output/hanimeDetails.json` contains **at least 10** detail records,
  each merging the parsed `content`, `player` and `downloads` blocks.

Fixtures live under `test/fixtures/`. To validate a parser change
against a real captured page, drop the page's HTML into a fixture and
add an assertion in `test/parsers.test.js`.

## Reliability Notes

- The listing scraper saves after **every** page so a crash or `Ctrl+C`
  loses at most the page currently in flight.
- The detail scraper checkpoints after **every** slug.
- A SIGINT/SIGTERM (or uncaught exception) flushes the in-memory state
  to disk synchronously before the process exits.
- Every navigation is wrapped in `withRetry(...)` with exponential
  backoff so transient WAF challenges don't abort the run.
