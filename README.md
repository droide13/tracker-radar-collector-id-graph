# DuckDuckGo Tracker Radar Collector - ID Graph
Modified version of tracker radar collector

## Quick start

```sh
git clone git@github.com:duckduckgo/tracker-radar-collector.git
npm i
npm run crawl -- -u "https://example.com" -o ./data/ -v
```

## CLI options

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
| `--autoconsent-action <action>` | `optIn` or `optOut` (requires `cookiepopups`) |

## Programmatic usage

```js
const { crawlerConductor, crawler } = require('tracker-radar-collector');
const { RequestCollector, CookieCollector } = require('tracker-radar-collector');

// Multiple URLs
crawlerConductor({
    urls: ['https://example.com', …],
    dataCallback: (url, result) => { … },
    dataCollectors: [new RequestCollector(), new CookieCollector()],
    numberOfCrawlers: 12,
    filterOutFirstParty: true,
    emulateMobile: false,
    maxLoadTimeMs: 30000,
    extraExecutionTimeMs: 2500,
});

// Single URL
const data = await crawler(new URL('https://example.com'), {
    collectors: [new RequestCollector()],
    log: console.log,
    maxLoadTimeMs: 30000,
});
```

## Output format

Each crawled site produces a JSON file named after the domain. Schema is defined in `crawler.js` (`CollectResult`). A `metadata.json` summarising the crawl configuration is also written per run.

## Creating a collector

Extend `BaseCollector` and implement:

| Method | Required | Description |
|---|---|---|
| `id()` | ✅ | Unique string identifier |
| `getData(options)` | ✅ | Return collected data. `options` provides `finalUrl` and `filterFunction` |
| `init(options)` | — | Called before crawl begins |
| `addTarget(session, targetInfo)` | — | Called for each new CDP target (page, iframe, worker) |
| `postLoad()` | — | Called after page load, before `extraExecutionTimeMs` wait |

Register every new collector in `crawlerConductor.js`, `main.js`, and optionally extend `CollectorData` in `collectorsList.js` for full type coverage.

---

## `emailFill` Collector

> **File:** `collectors/EmailFillCollector.js` · **ID:** `emailFill`

Finds newsletter / email-signup forms and submits them using human-like CDP interactions to avoid bot detection.

### How it works

1. After page load, tries to find and fill an email form on the current page.
2. If none found, scans links for newsletter-related keywords and visits up to 6 candidate pages.
3. On each candidate: checks for captcha first (skips if found), fills required ancillary fields (selects, checkboxes), types the email with realistic keystroke timing, then clicks submit.

### Registration

```js
// crawlerConductor.js
const EmailFillCollector = require('./collectors/EmailFillCollector');
// add to knownCollectors: { emailFill: EmailFillCollector, … }

// main.js
module.exports = { …, EmailFillCollector };

// collectorsList.js — CollectorData type
emailFill?: {
    filled: boolean; captchaPresent: boolean;
    formUrl: string | null; visitedLinks: string[]; error: string | null;
};
```

### Usage
First modify email in helpers/emails.js to enter a e-mail address then exectue the command below (use -f to overwrite). Also can be run using option --config.
```sh
# CLI — pass emailAddress via config file
 npm run crawl -- -u "https://example.com" -d emailFill -v -o ./data/captures
```

### Output

| Field | Type | Description |
|---|---|---|
| `filled` | `boolean` | `true` if a form was submitted |
| `captchaPresent` | `boolean` | `true` if a captcha was detected on any visited page |
| `formUrl` | `string\|null` | URL where submission occurred |
| `visitedLinks` | `string[]` | Candidate pages navigated to |
| `error` | `string\|null` | Unhandled exception message, if any |

### Form detection

Forms are scored by keyword density (`newsletter`, `subscribe`, `signup`, …) across `textContent`, `id`, `class`, and `action`. Forms with `password`, `login`, `checkout`, or `payment` fields are disqualified. The email input is matched by `type="email"` or `name`/`placeholder`/`id` containing `email`. Standalone inputs outside a `<form>` (common in footers) are supported as a fallback.

### Human simulation

| Behaviour | Detail |
|---|---|
| Mouse movement | 8-step interpolated path with pixel-level noise, starting from a random offset |
| Pre-fill wander | Mouse visits 3 random viewport coordinates before touching the form |
| Typing | Per-character `keyDown` + `insertText` + `keyUp`, 60–180 ms between keystrokes, ~5% hesitation pauses |
| SPA compatibility | Fires `input`, `change`, `blur` via native `HTMLInputElement` value setter after typing |
| Pre-submit pause | 600–1200 ms random wait before clicking |

### Captcha detection

Checked before any interaction. Skips the page if any of these match: `iframe[src*="recaptcha"]`, `iframe[src*="hcaptcha"]`, `iframe[src*="turnstile"]`, `.g-recaptcha`, `.h-captcha`, `[data-sitekey]`, `#cf-turnstile`, `.cf-turnstile`.

### Tunable constants

`NEWSLETTER_KEYWORDS` · `SUBMIT_TEXT_PATTERNS` · `CAPTCHA_SELECTORS` · `MAX_CANDIDATE_LINKS` (6) · `POST_NAVIGATE_DELAY` (4500 ms) · `TYPING_DELAY_MIN_MS` (60) · `TYPING_DELAY_MAX_MS` (180) · `MOUSE_MOVE_STEPS` (8)

### Known limitations

- Forms revealed by a click/modal may be missed.
- Multi-step signup flows are not supported.
- `filled: true` means submit was dispatched, not that the server accepted it.

---

## `har` Collector

> **File:** `collectors/HarCollector.js` · **ID:** `har`

Captures a full [HTTP Archive (HAR)](http://www.softwareishard.com/blog/har-12-spec/) of every network request made during a crawl, including response bodies, cookies, WebSocket frames, and cache events.

### How it works

1. Subscribes to CDP `Network.*` and `Page.*` events as soon as a page target is attached.
2. On each `Network.loadingFinished`, immediately fetches the response body from Chrome's buffer before it is evicted.
3. After the crawl, passes all recorded events to `chrome-har` to assemble the HAR, then stitches the fetched response bodies into the matching entries.

### Registration

```js
// crawlerConductor.js
const HarCollector = require('./collectors/HarCollector');
// add to knownCollectors: { har: HarCollector, … }

// main.js
module.exports = { …, HarCollector };

// collectorsList.js — CollectorData type
har?: HARData | null;
```

### Usage

```sh
npm run crawl -- -u "https://example.com" -d har -o ./data/captures -v
```

### Output

Standard HAR 1.2 object (`har.log.pages[]` + `har.log.entries[]`). Each entry includes full request/response headers (including actual `Cookie` / `Set-Cookie` via `ExtraInfo` events), response body as plain text or base64, precise timings, WebSocket frames, server IP, and connection ID. Returns `null` if no page target was attached.

### CDP events captured

**Page:** `loadEventFired`, `domContentEventFired`, `frameStartedLoading`, `frameRequestedNavigation`, `frameAttached`, `frameNavigated`, `frameDetached`

**Network:** `requestWillBeSent`, `requestServedFromCache`, `dataReceived`, `responseReceived`, `resourceChangedPriority`, `loadingFinished`, `loadingFailed`, `requestWillBeSentExtraInfo`, `responseReceivedExtraInfo`, `webSocketCreated`, `webSocketFrameSent`, `webSocketFrameReceived`, `webSocketClosed`

### Buffer configuration

`Network.enable` is called with `maxTotalBufferSize: 100 MB` and `maxResourceBufferSize: 10 MB`. Adjust in `addSessionEvents()` if you need to capture larger responses or reduce memory usage.

### Known limitations

- Response bodies for cached, redirected, or no-body responses are silently skipped (unavailable via CDP).
- Very large responses may still be evicted from Chrome's buffer before `getResponseBody` is called on high-traffic pages.