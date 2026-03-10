# Tracker Radar Collector — ID Graph Fork

A web crawling framework for large-scale, automated data collection from websites. This project is a modified fork of [DuckDuckGo's Tracker Radar Collector](https://github.com/duckduckgo/tracker-radar-collector), extended with custom collectors designed for identity graph and email tracking research.

The original tool was built to power DuckDuckGo's Tracker Radar dataset by crawling sites and recording network requests, cookies, API calls, and other signals. This fork preserves that foundation and adds purpose-built collectors for newsletter form interaction and full HTTP archive capture.

At a high level, the crawler launches headless Chromium instances, navigates to each target URL over the Chrome DevTools Protocol (CDP), runs a configurable set of data collectors during and after page load, and writes structured JSON output per site.

```sh
# Quick start — crawl a single URL with all collectors
git clone <this-repo>
npm i
npm run crawl -- -u "https://example.com" -o ./data/ -v
```

```sh
# Helpful command to run the default configuration declining the popups
npm run crawl --  --autoconsent-action optOut --config .\config.json
```

> 🚧 **Prototype Status**
>
> This repository contains a prototype implementation.  
> It is not production-ready and is intended for experimentation and early feedback.
---

## Table of Contents

1. [CLI Reference](#cli-reference)
2. [Architecture](#architecture)
   - [Pipeline Overview](#pipeline-overview)
   - [CLI — `crawl/index.js`](#cli--crawlindexjs)
   - [Crawler Conductor — `crawlerConductor.js`](#crawler-conductor--crawlerconductorjs)
   - [Crawler — `crawler.js`](#crawler--crawlerjs)
   - [Collectors](#collectors)
   - [Reporters](#reporters)
3. [Creating a Collector](#creating-a-collector)
4. [Custom Collectors](#custom-collectors)
   - [`emailFill` Collector](#emailfill-collector)
   - [`har` Collector](#har-collector)
5. [Output Format](#output-format)


---

## CLI Reference

| Flag | Description |
|---|---|
| `-o, --output <path>` | **(required)** Output folder |
| `-u, --url <url>` | Single URL to crawl |
| `-i, --input-list <path>` | Text file with one URL per line |
| `-d, --data-collectors <list>` | Comma-separated collectors to use (all by default) |
| `-c, --crawlers <number>` | Number of concurrent crawlers |
| `--reporters <list>` | Reporters: `cli`, `file`, `html` (default: `cli`) |
| `-v, --verbose` | Verbose logging |
| `-l, --log-path <path>` | Write logs to file |
| `-f, --force-overwrite` | Overwrite existing output files |
| `-3, --only-3p` | Skip first-party data |
| `-m, --mobile` | Emulate mobile device |
| `-p, --proxy-config <host>` | SOCKS proxy host |
| `-a, --disable-anti-bot` | Disable built-in anti-bot script |
| `--chromium-version <version>` | Custom Chromium version |
| `--selenium-hub <url>` | Use remote Selenium hub |
| `--config <path>` | Path to JSON config file |
| `--autoconsent-action <action>` | `optIn` or `optOut` (requires `cookiepopups` collector) |

---

## Architecture

### Pipeline Overview

Every crawl moves through three sequential layers. Collectors and reporters plug in at the sides.

```
CLI (crawl/index.js)
    │  resolves config, filters URLs, sets up output paths
    ▼
CrawlerConductor (crawlerConductor.js)
    │  concurrency control, retries, Chromium download
    ▼
Crawler (crawler.js)
    │  CDP session management, page lifecycle, timeouts
    │
    ├── Collectors[]   (data extraction plugins)
    └── Reporters[]    (output / logging plugins)
```

---

### CLI — `crawl/index.js`

Entry point for all crawls. Responsibilities:

- Parses CLI flags via `commander` and merges them with an optional JSON config file (`crawlConfig.figureOut`).
- Instantiates collectors and reporters by string ID from their respective registries.
- Filters the input URL list, skipping URLs whose output file already exists (unless `-f` is set).
- After each successful crawl, splits large data out of the main JSON: screenshots are saved as `.jpg` and HAR data as `.har`, with only the file path kept in the JSON.
- Writes a `metadata.json` at the end of every run summarising configuration, timing, and success/failure counts.

---

### Crawler Conductor — `crawlerConductor.js`

Manages parallel execution across all input URLs. Responsibilities:

- Spawns up to `floor(cores × 0.8)` concurrent crawlers by default, capped at the number of input URLs. Override with `-c`.
- Downloads the correct Chromium binary **once**, before any parallel work begins.
- Runs each URL through `crawlAndSaveData`, which wraps the core crawler call.
- On failure, automatically retries up to **2 times**. Async stack traces are disabled on retries as they can themselves cause crashes.
- Supports per-URL collector overrides: different URLs in the same batch can run different collectors.

---

### Crawler — `crawler.js`

Core crawl logic, built directly on the Chrome DevTools Protocol via Puppeteer's `CDPSession`. A `Crawler` instance orchestrates the full lifecycle for a single URL:

1. **Target attachment** — Sets up CDP auto-attach recursively for all target types: pages, iframes, workers, shared workers, and service workers. Each new target gets its own session with user-agent override, viewport emulation, dialog dismissal, and the anti-bot script injected if enabled.
2. **Collector init** — Calls `collector.init()` on every collector before navigation begins.
3. **Navigation** — Sends `Page.navigate` and waits for `networkIdle` on the main frame. On timeout, calls `Page.stopLoading` and continues rather than failing hard.
4. **Post-load** — Calls `collector.postLoad()`, then waits `extraExecutionTimeMs` (default 2500 ms) for the page to settle.
5. **Data extraction** — Calls `collector.getData()` on each collector and assembles results into a keyed object.
6. **Timeout enforcement** — A hard outer timeout of `maxLoadTimeMs × 2 + collectorExtraTime` prevents any single URL from hanging the queue.

First-party filtering (`--only-3p`) is applied via `isThirdPartyRequest`, which compares eTLD+1 of the document against each request URL using `tldts`.

---

### Collectors

Collectors are the data extraction plugins. Each extends `BaseCollector` and is identified by a unique string `id()`. They are registered in `helpers/collectorsList.js`.

The lifecycle a collector sees per crawl:

```
init(options)
    │  called once before navigation; use to set up state
    ▼
addTarget(session, targetInfo)   [called N times — once per page, iframe, worker…]
    │  subscribe to CDP events here
    ▼
postLoad()
    │  called after networkIdle; trigger any post-load interactions
    ▼
getData({ finalUrl, urlFilter })
    │  return the collected data object
```

---

### Reporters

Reporters handle all user-facing output. Each extends `BaseReporter` and receives three lifecycle hooks:

| Hook | When |
|---|---|
| `init({ verbose, startTime, urls, logPath })` | Before the crawl batch starts |
| `update({ site, successes, failures, … })` | After each URL completes or fails |
| `cleanup({ startTime, endTime, successes, … })` | After the entire batch finishes |

The default reporter is `cli` (progress display + console logging). Multiple reporters can be active simultaneously via `--reporters cli,file`.

---

## Creating a Collector

Extend `BaseCollector` and implement the required methods:

| Method | Required | Description |
|---|---|---|
| `id()` | ✅ | Unique string identifier |
| `getData(options)` | ✅ | Return collected data. `options` provides `finalUrl` and `urlFilter` |
| `init(options)` | — | Called before navigation begins |
| `addTarget(session, targetInfo)` | — | Called for each new CDP target (page, iframe, worker…) |
| `postLoad()` | — | Called after page load, before `extraExecutionTimeMs` wait |

Register every new collector in `helpers/collectorsList.js`, `crawlerConductor.js`, and `main.js`. Optionally extend the `CollectorData` type in `collectorsList.js` for full type coverage.

---

## Custom Collectors

### emailFill Collector

> ⚠️ Work in progress

File: collectors/EmailFillCollector.js · ID: emailFill

Finds newsletter and email signup forms on a page and submits them using human-like CDP interactions to avoid bot detection.

#### How it works

After page load, tries to find and fill an email form on the current page.
If none is found, scans links for newsletter-related keywords and visits up to 6 candidate pages.
On each candidate: checks for CAPTCHA (records type but continues regardless), fills required ancillary fields (selects, checkboxes), types the email with realistic keystroke timing, then clicks submit.

#### Registration

```js
// crawlerConductor.js
const EmailFillCollector = require('./collectors/EmailFillCollector');
// add to knownCollectors: { emailFill: EmailFillCollector, … }

// main.js
module.exports = { …, EmailFillCollector };

// collectorsList.js — CollectorData type
emailFill?: {
    filled: boolean;
    captchaPresent: boolean;
    captchaBlocked: boolean;
    submissionSucceeded: boolean;
    formUrl: string | null;
    visitedLinks: string[];
    error: string | null;
};
```

#### Identity configuration

The email address and form-fill identity (name, phone, date of birth, etc.) are loaded from a JSON file in helpers/emailHelpers/identities/.
To switch identity, edit the single line in helpers/emailHelpers/emailFill.config.json:

```json
{ "identity": "identity.james.json" }
```

The value is just the filename — no path needed. Two identities are included (identity.laura.json, identity.james.json); add more by dropping new JSON files in the identities/ folder.

For a one-off override without editing the config (e.g. in CI):
```sh
IDENTITY_FILE=/absolute/path/to/identity.json npm run crawl -- …
```

Identity schema — email is required, all other fields are optional (default to empty string):

| Field | Required | Example |
|---|---|---|
| email | ✓ | "laura.mitchell@example.com" |
| firstName | | "Laura" |
| lastName | | "Mitchell" |
| fullName | | "Laura Mitchell" |
| phone | | "2025550173" |
| zip | | "10001" |
| dob | | "1990-06-15" |
| gender | | "Female" |
| country | | "United States" |
| state | | "New York" |
| freeText | | "General inquiry" |

#### Usage

```sh
npm run crawl -- -u "https://example.com" -d emailFill -v -o ./data/captures
```

#### Output

| Field | Type | Description |
|---|---|---|
| filled | boolean | true if a form was submitted (legacy alias for submissionSucceeded) |
| submissionSucceeded | boolean | true if submit was dispatched successfully |
| captchaPresent | boolean | true if a CAPTCHA was detected on any visited page |
| captchaBlocked | boolean | true only if a CAPTCHA prevented submission entirely |
| formUrl | string\|null | URL where submission occurred |
| visitedLinks | string[] | Candidate pages navigated to |
| error | string\|null | Unhandled exception message, if any |

#### Form detection

Forms are scored by keyword density (newsletter, subscribe, signup, …) across textContent, id, class, and action. Forms containing password, login, checkout, or payment fields are disqualified. The email input is matched by type="email" or name/placeholder/id containing email. Standalone inputs outside a `<form>` (common in footers) are supported as a fallback.

#### Consent wall handling (work in progress)

The crawler never genuinely accepts consent — it suppresses consent walls to reach the newsletter form underneath.

Two layers run automatically:

1. **Pre-render injection** — fires before the first page paint by setting well-known CMP cookies (OneTrust, Didomi, Cookiebot) and localStorage flags. Prevents most walls from mounting at all.
2. **Runtime click fallback** — if a wall survived the injection (e.g. server-side verified CMPs), the crawler clicks its dismiss button and waits 1500 ms before continuing. Only buttons whose text unambiguously matches "accept all" in multiple languages are targeted — paywall and registration buttons are explicitly excluded.

Known limitation: sites that re-render the consent wall after each navigation may still intermittently block access.

#### Cross-origin iframe forms (work in progress)

Some newsletter forms are embedded in cross-origin iframes (e.g. a publisher's subscription subdomain served inside the main site). The main page frame cannot see their DOM, which previously caused the wrong button to be clicked.

`addTarget()` now collects a CDP session for every non-noise iframe. If form detection returns nothing in the main frame, each iframe session is probed in turn. Whichever session owns the form is used for all subsequent steps — field filling, ancillary fields, and submit all run in the correct frame context.

Known third-party iframes that are skipped: reCAPTCHA, hCaptcha, Cloudflare Turnstile, Google Tag Manager, Google Analytics, DoubleClick, Facebook plugins, YouTube embeds.

Known limitation: deeply nested iframes (iframe inside iframe) are not probed.

#### Submit button / scroll fix (work in progress)

`getBoundingClientRect()` returns viewport-relative coordinates at the moment of the call. If the submit button is below the fold, the raw coordinates point to empty space and the CDP click misses. `FormSubmitter` now calls `scrollIntoView()` on the resolved button before clicking, then re-reads the rect to get updated viewport coordinates.

#### Ancillary field filling

| Field type | Strategy |
|---|---|
| Date-of-birth selects | Detects day/month/year selects by name/id/aria-label hints (EN/ES/FR/DE) and picks the option matching identity.dob (YYYY-MM-DD), tolerating zero-padding differences |
| Other selects | First non-empty, non-zero option |
| Consent checkboxes | Checked if label matches a multilingual privacy/ToS regex (EN/ES/FR/DE/IT/PT); skipped if label signals opt-out |
| Text inputs | Mapped to identity fields by name/id/placeholder hints; required unmatched inputs receive identity.freeText |
| Honeypots | Inputs with zero bounding rect are skipped |

#### Human simulation

| Behaviour | Detail |
|---|---|
| Mouse movement | 8-step interpolated path with pixel-level noise, starting from a random offset |
| Pre-fill wander | Mouse visits 3 random viewport coordinates before touching the form |
| Typing | Per-character keyDown + insertText + keyUp, 60–180 ms between keystrokes, ~5% hesitation pauses |
| SPA compatibility | Fires input, change, blur via native HTMLInputElement value setter after typing |
| Pre-submit pause | 600–1200 ms random wait before clicking |

#### CAPTCHA behaviour

CAPTCHA type is detected and recorded but never causes the page to be skipped. Submission is always attempted:

- Score-based (reCAPTCHA v3, Cloudflare Turnstile) — run invisibly; the form may still accept the submission with a low score.
- Checkbox (reCAPTCHA v2, hCaptcha) — will block server-side; the attempt is still made so the HAR collector captures the server response.

Detected via: `iframe[src*="recaptcha"]`, `iframe[src*="hcaptcha"]`, `iframe[src*="turnstile"]`, `.g-recaptcha`, `.h-captcha`, `[data-sitekey]`, `#cf-turnstile`, `.cf-turnstile`.

#### Tunable constants

`NEWSLETTER_KEYWORDS` · `SUBMIT_TEXT_PATTERNS` · `CAPTCHA_SELECTORS` · `MAX_CANDIDATE_LINKS` (6) · `POST_NAVIGATE_DELAY` (4500 ms) · `POST_SUBMIT_DELAY` (3000 ms) · `TYPING_DELAY_MIN_MS` (60) · `TYPING_DELAY_MAX_MS` (180) · `MOUSE_MOVE_STEPS` (8)

All constants are in helpers/emailHelpers/constants.js.

#### Known limitations

- Forms revealed by a click, scroll, or modal may be missed.
- Multi-step signup flows are not supported.
- `filled: true` means submit was dispatched, not that the server accepted it.
- Consent walls verified server-side may re-render after navigation and block access intermittently.
- Deeply nested iframes (iframe inside iframe) are not probed for forms.

---

### `har` Collector

> **File:** `collectors/HarCollector.js` · **ID:** `har`

Captures a full [HTTP Archive (HAR 1.2)](http://www.softwareishard.com/blog/har-12-spec/) of every network request made during a crawl, including response bodies, cookies, WebSocket frames, and cache events.

#### How it works

1. Subscribes to CDP `Network.*` and `Page.*` events as soon as a page target is attached.
2. On each `Network.loadingFinished`, immediately fetches the response body from Chrome's buffer before it can be evicted.
3. After the crawl, passes all recorded events to `chrome-har` to assemble the HAR, then stitches the fetched response bodies into the matching entries.

#### Registration

```js
// crawlerConductor.js
const HarCollector = require('./collectors/HarCollector');
// add to knownCollectors: { har: HarCollector, … }

// main.js
module.exports = { …, HarCollector };

// collectorsList.js — CollectorData type
har?: HARData | null;
```

#### Usage

```sh
npm run crawl -- -u "https://example.com" -d har -o ./data/captures -v
```

#### Output

Standard HAR 1.2 object (`har.log.pages[]` + `har.log.entries[]`). Each entry includes full request/response headers (including actual `Cookie` / `Set-Cookie` via `ExtraInfo` events), response body as plain text or base64, precise timings, WebSocket frames, server IP, and connection ID. Returns `null` if no page target was attached.

The HAR is written to a separate `.har` file by the CLI (not embedded in the main JSON) to keep output sizes manageable.

#### CDP events captured

**Page:** `loadEventFired`, `domContentEventFired`, `frameStartedLoading`, `frameRequestedNavigation`, `frameAttached`, `frameNavigated`, `frameDetached`

**Network:** `requestWillBeSent`, `requestServedFromCache`, `dataReceived`, `responseReceived`, `resourceChangedPriority`, `loadingFinished`, `loadingFailed`, `requestWillBeSentExtraInfo`, `responseReceivedExtraInfo`, `webSocketCreated`, `webSocketFrameSent`, `webSocketFrameReceived`, `webSocketClosed`

#### Buffer configuration

`Network.enable` is called with `maxTotalBufferSize: 100 MB` and `maxResourceBufferSize: 10 MB`. Adjust in `addSessionEvents()` if you need to capture larger responses or reduce memory usage.

#### Known limitations

- Response bodies for cached, redirected, or no-body responses are silently skipped (unavailable via CDP).
- Very large responses may still be evicted from Chrome's buffer before `getResponseBody` is called on high-traffic pages.

---

## Output Format

Each crawled URL produces a JSON file named after a hash of the URL. Schema is defined in `crawler.js` (`CollectResult`):

| Field | Type | Description |
|---|---|---|
| `initialUrl` | `string` | URL as provided to the crawler |
| `finalUrl` | `string` | URL after all redirects |
| `timeout` | `boolean` | `true` if the page did not fully load before the timeout |
| `testStarted` | `number` | Unix timestamp (ms) when the crawl began |
| `testFinished` | `number` | Unix timestamp (ms) when the crawl ended |
| `data` | `object` | Keyed by collector ID; each value is that collector's output |

A `metadata.json` is also written per run, summarising configuration, timing, collector list, and success/failure counts.

---