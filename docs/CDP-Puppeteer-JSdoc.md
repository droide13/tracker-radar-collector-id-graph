# Puppeteer · CDP · JSDoc — Deep Dive

> A practical reference grounded in the crawler codebase  
> `crawler.js` · `HarCollector.js` · CDP & Puppeteer HAR Capture

---

## Table of Contents

- [Part 1 — Puppeteer](#part-1--puppeteer)
  - [1.1 What Puppeteer actually is](#11-what-puppeteer-actually-is)
  - [1.2 The object model](#12-the-object-model)
  - [1.3 CDPSession — the object you use constantly](#13-cdpsession--the-object-you-use-constantly)
  - [1.4 Target lifecycle — how your crawler discovers every target](#14-target-lifecycle--how-your-crawler-discovers-every-target)
  - [1.5 waitForDebuggerOnStart — the instrumentation window](#15-waitfordebuggeronstart--the-instrumentation-window)
  - [1.6 networkIdle — what it is and where it breaks](#16-networkidle--what-it-is-and-where-it-breaks)
- [Part 2 — Chrome DevTools Protocol (CDP)](#part-2--chrome-devtools-protocol-cdp)
  - [2.1 What CDP is](#21-what-cdp-is)
  - [2.2 Domains](#22-domains)
  - [2.3 Sessions are per-target — and so is Network.enable](#23-sessions-are-per-target--and-so-is-networkenable)
  - [2.4 The Network event lifecycle](#24-the-network-event-lifecycle)
  - [2.5 requestId — the key that ties events together](#25-requestid--the-key-that-ties-events-together)
  - [2.6 Body capture — the session binding problem](#26-body-capture--the-session-binding-problem)
  - [2.7 Buffer limits and eviction](#27-buffer-limits-and-eviction)
  - [2.8 Dead sessions — the duplicate target problem](#28-dead-sessions--the-duplicate-target-problem)
  - [2.9 Promise.allSettled vs Promise.all for multi-session work](#29-promiseallsettled-vs-promiseall-for-multi-session-work)
  - [2.10 HAR failure modes quick reference](#210-har-failure-modes-quick-reference)
- [Part 3 — JSDoc Patterns](#part-3--jsdoc-patterns)
  - [3.1 Why JSDoc in a plain JS project](#31-why-jsdoc-in-a-plain-js-project)
  - [3.2 @param with type imports across packages](#32-param-with-type-imports-across-packages)
  - [3.3 @typedef for complex internal shapes](#33-typedef-for-complex-internal-shapes)
  - [3.4 @typedef for the Crawler's constructor options](#34-typedef-for-the-crawlers-constructor-options)
  - [3.5 The async addTarget() contract](#35-the-async-addtarget-contract)
  - [3.6 Closure over session in event loops](#36-closure-over-session-in-event-loops)
  - [3.7 Set\<Promise\> for in-flight work tracking](#37-setpromise-for-in-flight-work-tracking)
  - [3.8 Optional chaining for optional loggers](#38-optional-chaining-for-optional-loggers)
  - [3.9 @type on class fields](#39-type-on-class-fields)
- [Key Takeaways](#key-takeaways)

---

## Part 1 — Puppeteer

> What it is, what it hides, and where your code takes over

### 1.1 What Puppeteer actually is

Puppeteer is a **thin Node.js wrapper around the Chrome DevTools Protocol**. It opens a WebSocket to Chrome, serialises commands into JSON messages, and fires JavaScript events when Chrome replies. Almost everything you do in Puppeteer translates 1-to-1 to a CDP command. The library exists so you don't have to manage raw WebSocket frames and message IDs yourself.

Your crawler goes one level deeper: it uses `browserConnection` to send CDP commands **directly**, bypassing Puppeteer's higher-level `Page`/`Browser` abstractions wherever they are too coarse-grained. The `CDPSession` object returned by Puppeteer is the raw channel to a single Chrome target.

---

### 1.2 The object model

| Object | Description |
|---|---|
| **Browser** | One Chrome process (opened by `openBrowser()`) |
| **BrowserConnection** | The WebSocket to that process (stored as `this.browserConnection`) |
| **Target** | Any tab, iframe, worker, or service worker (one per independent OS process) |
| **CDPSession** | The bidirectional CDP channel to one specific target |

In `crawler.js`, the browser is opened and its connection stored:

```js
// crawl() — crawler.js
const browser = await openBrowser(log, options.proxyHost, options.executablePath);
const browserConnection = await browser.getConnection();

// browserConnection is passed into every Crawler instance
const crawler = new Crawler({ browserConnection, collectors, ... });
```

---

### 1.3 CDPSession — the object you use constantly

Every call to `session.send('Domain.method', params)` is a CDP request. The promise resolves when Chrome sends the matching response. `session.on('Domain.event', handler)` registers a listener for unsolicited push events.

From `crawler.js` `_onTargetAttached()`:

```js
async _onTargetAttached(session, targetInfo) {
  // CDP command — "please enable the Page domain on this target"
  await session.send('Page.enable');

  // CDP event — Chrome tells us a frame navigated
  session.on('Page.frameNavigated', (e) => {
    if (!e.frame.parentId) { // top-level frame only
      this.mainPageFrame = e.frame;
    }
  });
}
```

> [!NOTE]
> `session.send()` returns a `Promise`. If you forget `await`, the crawler moves on before Chrome has processed the command. This is the most common bug with Puppeteer/CDP code.

---

### 1.4 Target lifecycle — how your crawler discovers every target

Chrome creates a new target (and process) for every cross-origin iframe, worker, or service worker. Puppeteer exposes this through the **Target domain**. Your crawler sets up listeners on the top-level connection:

```js
// getSiteData() — crawler.js
conn.on('Target.targetCreated',      this.onTargetCreated.bind(this));
conn.on('Target.attachedToTarget',   this.onTargetAttached.bind(this));
conn.on('Target.detachedFromTarget', this.onDetachedFromTarget.bind(this));
conn.on('Target.targetInfoChanged',  this.onTargetInfoChanged.bind(this));
conn.on('Target.targetDestroyed',    this.onTargetDestroyed.bind(this));
conn.on('Target.targetCrashed',      this.onTargetCrashed.bind(this));
```

Then it enables automatic attachment — meaning Chrome will call `attachedToTarget` for every child target it discovers:

```js
// On the browser-level connection: attach to page targets
await conn.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: true, // PAUSE target until we're ready
  flatten: true,                // all sessions share one WebSocket
  filter: targetFilter,
});

// Inside _onTargetAttached — propagate to children of THIS target
session.on('Target.attachedToTarget', this.onTargetAttached.bind(this));
await session.send('Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: targetFilter,
});
```

> [!WARNING]
> `setAutoAttach` only covers direct children. To reach iframes inside iframes you must call it recursively on every new session — exactly what `_onTargetAttached` does by re-binding the handler on each new session.

---

### 1.5 waitForDebuggerOnStart — the instrumentation window

When `waitForDebuggerOnStart: true`, Chrome pauses the new target before executing a single byte of JavaScript. This gives you time to enable domains. The window closes when you send `Runtime.runIfWaitingForDebugger`:

```js
// _onTargetAttached — crawler.js (simplified order)

// 1. Propagate auto-attach to children
await session.send('Target.setAutoAttach', { ... });

// 2. Enable domains (Page, Inspector, Runtime...)
await session.send('Page.enable');
await session.send('Runtime.enable');

// 3. Let each collector attach its listeners + Network.enable
for (const collector of this.collectors) {
  await collector.addTarget(session, targetInfo); // HarCollector runs here
}

// 4. RELEASE — target resumes execution
await session.send('Runtime.runIfWaitingForDebugger');
// First network request fires AFTER step 4 -> nothing is missed
```

> [!TIP]
> This ordering guarantee is why `HarCollector.addTarget()` calls `Network.enable` before returning. By the time `runIfWaitingForDebugger` is called, every domain is already enabled on every session.

---

### 1.6 networkIdle — what it is and where it breaks

Puppeteer synthesises network idle by counting `requestWillBeSent` events (up) and `loadingFinished` / `loadingFailed` events (down). Your crawler uses the higher-level `Page.lifecycleEvent` instead:

```js
// navigateMainTarget() — crawler.js
const lifecycleHandler = async (e) => {
  if (e.name === 'networkIdle') {
    await this._mainFrameDeferred.promise; // wait for frame to be known
    if (e.frameId === this.mainPageFrame.id) { // only top-level frame matters
      session.off('Page.lifecycleEvent', lifecycleHandler);
      this._navigationDeferred.resolve();
    }
  }
};

session.on('Page.lifecycleEvent', lifecycleHandler);
```

The check `e.frameId === this.mainPageFrame.id` is critical. Without it, an iframe going idle would trigger the resolve and cut the crawl short while the main page is still loading.

> [!WARNING]
> Service worker requests go through a separate session and are invisible to the page's lifecycle counter. If a page relies on a service worker for prefetching, `networkIdle` may fire too early.

---

## Part 2 — Chrome DevTools Protocol (CDP)

> Domains · Events · Sessions · Network · Body capture

### 2.1 What CDP is

CDP is a JSON-RPC protocol. Chrome exposes it over a WebSocket. Commands look like:

```json
{ "id": 1, "method": "Network.enable", "params": {} }
```

Events (unsolicited pushes from Chrome) look like:

```json
{ "method": "Network.requestWillBeSent", "params": { ... } }
```

Puppeteer's `CDPSession.send()` and `CDPSession.on()` wrap these two patterns.

---

### 2.2 Domains

CDP is organised into **domains** — logical groups of commands and events. The key ones in your codebase:

| Domain | Used in | What it does |
|---|---|---|
| **Target** | `crawler.js` | Discover, attach, and manage targets (pages, iframes, workers) |
| **Network** | `HarCollector.js` | Observe all HTTP(S) requests + responses + body data |
| **Page** | `crawler.js` | Navigation, frame events, lifecycle, JavaScript dialogs |
| **Runtime** | `crawler.js` | Enable JS engine, `runIfWaitingForDebugger` |
| **Browser** | `HarCollector.js` | Browser-scoped info: `getVersion()` |
| **Inspector** | `crawler.js` | Low-level inspector hooks |
| **Emulation** | `crawler.js` | Device metrics, viewport override |

---

### 2.3 Sessions are per-target — and so is Network.enable

The most important CDP rule: **enabling a domain only affects the target the session belongs to**. There is no global enable. When Chrome creates a new cross-origin iframe, it creates a new process and a new session. That session starts with **zero enabled domains**.

This is why `HarCollector.addTarget()` always calls `Network.enable` itself:

```js
// HarCollector.js — addTarget()
async addTarget(session, targetInfo) {
  if (!NETWORK_TARGET_TYPES.has(targetInfo.type)) return;

  // Register event listeners BEFORE enabling — no events missed
  for (const method of OBSERVED_EVENTS) {
    session.on(method, (params) => {
      this._events.push({ method, params });
    });
  }

  // THIS specific session only — not all sessions
  await session.send('Network.enable', {
    maxTotalBufferSize:    100_000_000, // 100 MB
    maxResourceBufferSize:  10_000_000, // 10 MB per resource
  });
}
```

> [!WARNING]
> If you call `Network.enable` only on the page session, all cross-origin iframe and worker requests are invisible. The HAR will be missing entire origins.

---

### 2.4 The Network event lifecycle

For every HTTP request, Chrome emits events in this order. Each pair of events comes from two separate Chrome processes:

```
requestWillBeSent          <- renderer: "I'm about to send a request"
requestWillBeSentExtraInfo <- browser process: real wire cookies attached
                              ⚠ may arrive BEFORE requestWillBeSent

responseReceived           <- renderer: headers received
responseReceivedExtraInfo  <- browser process: HttpOnly Set-Cookie values

dataReceived               <- body chunk (fires 0..N times)

loadingFinished            <- body complete -> safe to call getResponseBody
    — or —
loadingFailed              <- network error, cancellation, or CSP block
```

In `HarCollector.js`, all these events are forwarded to `this._events` so that `chrome-har` can replay them and construct HAR entries:

```js
// HarCollector.js — addTarget()
for (const method of OBSERVED_EVENTS) { // from harEvents.js
  session.on(method, (params) => {
    this._events.push({ method, params }); // merged from ALL sessions
  });
}

// getData() — after all events collected:
const har = chromeHar.harFromMessages(this._events, {
  includeTextFromResponseBody: true,
  includeResourcesFromDiskCache: true,
});
```

---

### 2.5 requestId — the key that ties events together

Every event for a single request shares the same `requestId`. Chrome guarantees this ID is unique within a browser context. This is why merging events from multiple sessions into a single `this._events` array works — there are no ID collisions across sessions (unlike `documentId` which can collide).

Redirects reuse the same `requestId` but fire a new `requestWillBeSent` with a `redirectResponse` field. The HAR guide warns against overwriting map entries for this reason.

---

### 2.6 Body capture — the session binding problem

After `loadingFinished` fires, Chrome holds the response body in memory inside the CDP session's buffer. You retrieve it with `Network.getResponseBody`. The critical rule: **you must call `getResponseBody` on the exact same session that received `loadingFinished`**. The body does not exist in any other session.

```js
// registerBodyFetching() — harResponseBody.js
// `session` is captured in the closure — this is the same session that
// received loadingFinished, so getResponseBody will find the body.
session.on('Network.loadingFinished', async (event) => {
  const p = (async () => {
    try {
      const body = await session.send( // <- SAME session, not _pageSession
        'Network.getResponseBody',
        { requestId: event.requestId }
      );
      responseBodies.set(event.requestId, body);
    } catch {
      // Expected: evicted buffer, closed session, 204/304/HEAD response
    }
  })();

  pendingFetches.add(p);
  p.finally(() => pendingFetches.delete(p));
});
```

The `pendingFetches` `Set<Promise>` tracks in-flight body fetches. In `getData()`, the collector drains them before building the HAR:

```js
// HarCollector.getData()
await drainPendingFetches(this._pendingFetches);

// All bodies are now in this._responseBodies
const har = chromeHar.harFromMessages(this._events, { ... });

// Stitch the bodies into the HAR entries
stitchResponseBodies(har.log.entries, this._responseBodies);
```

---

### 2.7 Buffer limits and eviction

Chrome keeps bodies in a bounded buffer per session. When it fills, older entries are evicted silently — `getResponseBody` throws for them. Your `HarCollector` uses generous limits:

```js
await session.send('Network.enable', {
  maxTotalBufferSize:    100_000_000, // 100 MB — covers asset-heavy SPAs
  maxResourceBufferSize:  10_000_000, // 10 MB per resource
});
// Default is only 10 MB total / 5 MB per resource
// On a large SPA this fills in seconds
```

---

### 2.8 Dead sessions — the duplicate target problem

Chrome sometimes attaches the same logical target twice. This happens most often with already-registered service workers. The first session becomes stale but its WebSocket stays open. Any `session.send()` to that dead session throws. Your crawler logs these:

```js
// crawler.js — onTargetAttached()
if (this.targets.has(targetInfo.targetId)) {
  this.log(
    `Target ${targetInfo.targetId} already exists: ` +
    `old session: ${this.targets.get(targetInfo.targetId).session.id()}, ` +
    `new: ${session.id()}`
  );
}
this.targets.set(targetInfo.targetId, { targetInfo, session }); // overwrite
```

`HarCollector` guards against enabling a dead session:

```js
// HarCollector.js — addTarget()
if (session.connection && session.connection() === null) {
  this._log?.(HAR, `skipping already-closed session for ${targetInfo.url}`);
  return;
}

// Network.enable is in try/catch because session.connection() check
// has a race window — the session can die between the check and the send
try {
  await session.send('Network.enable', { ... });
} catch (err) {
  this._log?.(HAR, `Network.enable failed: ${err.message}`);
  // Non-fatal — other sessions continue normally
}
```

---

### 2.9 Promise.allSettled vs Promise.all for multi-session work

When operating across multiple sessions, one dead session must never kill the rest. The rule: use `Promise.allSettled` when you expect some calls may fail, `Promise.all` only when all must succeed.

```js
// HarCollector.getData() — flush Chrome's buffers
// Some sessions may be closed by now — that's fine
await Promise.allSettled(
  [...this._sessions].map((s) => s.send('Network.disable').catch(() => {})),
);

// ❌ If any session is dead, ALL bodies would be lost:
// await Promise.all([...this._sessions].map(s => s.send('Network.disable')));
```

---

### 2.10 HAR failure modes quick reference

| Symptom | Root cause and fix |
|---|---|
| **HAR has 0 entries** | `Network.enable` never called on page session. Ensure `addTarget()` awaits it. |
| **HAR missing iframe requests** | `Network.enable` not called on iframe session. Every session needs its own call. |
| **`getResponseBody` throws** | Called on wrong session, or buffer evicted. Check session closure and buffer limits. |
| **Duplicate `requestId` in HAR** | Requests from different sessions sharing same ID. Prefix with `sessionId` in `harEvents.js`. |
| **`networkIdle` fires too early** | iframe idle resolved the deferred. Check `frameId` matches `mainPageFrame.id`. |
| **First wave of requests missing** | `Network.enable` called after `runIfWaitingForDebugger`. Must enable before releasing target. |
| **Empty HAR after service worker** | Dead session rejected `Promise.all`. Use `Promise.allSettled` instead. |

---

## Part 3 — JSDoc Patterns

> Type imports · @typedef · async contracts · optional chaining

### 3.1 Why JSDoc in a plain JS project

Your codebase uses no TypeScript compiler, yet VS Code gives you type checking and autocomplete. This works because TypeScript's language server can read JSDoc annotations and resolve types from installed `.d.ts` files — no `tsconfig.json` required. The annotations are documentation that the editor can mechanically verify.

---

### 3.2 @param with type imports across packages

Your entire codebase passes CDP types between functions. The cleanest way to annotate this is with inline `@param {import(...)}`:

```js
// crawler.js

/**
 * @param {import('puppeteer-core').CDPSession} session
 * @param {import('devtools-protocol/types/protocol').Protocol.Target.TargetInfo} targetInfo
 */
async _onTargetAttached(session, targetInfo) {
  // VS Code now knows session.send(), session.on(), targetInfo.type, etc.
  await session.send('Page.enable');
  const type = targetInfo.type; // autocompletes to the correct union
}
```

The `import('...')` syntax works at the type level only — it does not add a runtime import. VS Code resolves it by walking to the package's `.d.ts` and finding the named export.

---

### 3.3 @typedef for complex internal shapes

When a shape is used in multiple places, define it once with `@typedef` and reference it everywhere. From `crawler.js`:

```js
/**
 * @typedef {Object} CollectResult
 * @property {string}  initialUrl   URL the crawl began from
 * @property {string}  finalUrl     URL after redirects
 * @property {boolean} timeout      true if load was cut short
 * @property {number}  testStarted  unix timestamp
 * @property {number}  testFinished unix timestamp
 * @property {import('./helpers/collectorsList').CollectorData} data
 */

/**
 * @returns {Promise<CollectResult>}
 */
async getSiteData(url) { ... }
```

> [!WARNING]
> JSDoc does not hoist. A `@typedef` must appear in the file **before** the function that references it, or the type checker will not find it. Place `@typedef` blocks at the top of the file or immediately above the first usage.

---

### 3.4 @typedef for the Crawler's constructor options

Crawler's constructor takes a large options bag. Rather than an untyped `options` parameter, `crawler.js` defines `GetSiteDataOptions`:

```js
/**
 * @typedef {Object} GetSiteDataOptions
 * @property {import('./browser/LocalChrome').BrowserConnection} browserConnection
 * @property {import('./collectors/BaseCollector')[]} collectors
 * @property {function(...any):void} log
 * @property {function(string, string):boolean} urlFilter
 * @property {boolean} emulateMobile
 * @property {number} maxLoadTimeMs
 */

class Crawler {
  /**
   * @param {GetSiteDataOptions} options
   */
  constructor(options) {
    this.options = options;
    // VS Code now autocompletes options.browserConnection,
    // options.collectors, options.log, etc.
  }
}
```

---

### 3.5 The async addTarget() contract

The crawler does `await collector.addTarget(session, targetInfo)`. This means **the function must be `async` and must `await` every setup step**. If the function returns before `Network.enable` completes, the target is released before instrumentation is in place.

```js
// ❌ WRONG — returns undefined, crawler doesn't wait
addTarget(session, targetInfo) {
  session.send('Network.enable', {}).then(() => {
    session.on('Network.requestWillBeSent', handler);
  });
  // Function returns here — crawler calls runIfWaitingForDebugger
  // Target resumes — first requests fire — listeners not attached yet
}

// ✅ CORRECT — crawler waits until everything is ready
async addTarget(session, targetInfo) {
  session.on('Network.requestWillBeSent', handler); // sync first
  await session.send('Network.enable', {});         // then async
  // Function resolves — crawler calls runIfWaitingForDebugger — safe
}
```

---

### 3.6 Closure over session in event loops

A subtle but important point: `for...of` with `const` creates a new binding per iteration. Closures inside the loop body capture the **iteration-specific** variable, not a shared reference.

```js
// This pattern works correctly in HarCollector.js
for (const session of sessions) {
  // Each iteration: `session` is a fresh const binding
  session.on('Network.loadingFinished', async (event) => {
    // `session` here is the binding from THIS iteration
    // Not a shared variable that later iterations will overwrite
    const body = await session.send('Network.getResponseBody', {
      requestId: event.requestId,
    });
  });
}

// ❌ This would be wrong — all handlers share the same `s` reference:
// for (var s of sessions) { ... } // var is hoisted, not block-scoped
```

---

### 3.7 Set\<Promise\> for in-flight work tracking

The `_pendingFetches` pattern in `HarCollector` is a clean way to track an arbitrary number of concurrent async operations without leaking memory:

```js
// HarCollector.js — init()
this._pendingFetches = new Set();

// harResponseBody.js — registerBodyFetching()
session.on('Network.loadingFinished', async (event) => {
  const p = (async () => {
    // ... fetch body ...
  })();

  pendingFetches.add(p);
  p.finally(() => pendingFetches.delete(p)); // self-cleaning — no leak
});

// HarCollector.getData() — wait for all bodies before building HAR
await Promise.allSettled([...this._pendingFetches]);
// Set is now empty; all bodies in this._responseBodies
```

The `p.finally(...)` removes the promise from the Set when it settles (resolve or reject). This means the Set never grows unboundedly regardless of how many requests the page makes.

---

### 3.8 Optional chaining for optional loggers

The `log` function is passed in by the caller and may be absent. Using `?.()` calls it only when it exists, without the verbosity of an `if (this._log)` guard:

```js
// HarCollector.js
this._log?.(HAR, `Network.enable OK for ${targetInfo.type}`);

// Equivalent to:
// if (this._log !== undefined && this._log !== null) {
//   this._log(HAR, `Network.enable OK for ${targetInfo.type}`);
// }

// In contrast, crawler.js always has a log function:
// const log = options.log || (() => {});
// So it calls this.log(...) directly — no optional chaining needed
```

> [!TIP]
> Use `?.` only when the property is genuinely optional. If it should always be present, call it directly so a missing logger fails loudly during development rather than silently in production.

---

### 3.9 @type on class fields

Class fields declared in the constructor should have `@type` comments so VS Code can infer the type throughout the class without needing to inspect every assignment:

```js
// HarCollector.js — init()

/** @type {Array<{method: string, params: object}>} */
this._events = [];

/** @type {Map<string, import('../helpers/harHelpers/harResponseBody').StoredResponseBody>} */
this._responseBodies = new Map();

/** @type {Set<Promise<void>>} */
this._pendingFetches = new Set();

/** @type {import('puppeteer-core').CDPSession | null} */
this._pageSession = null;
```

The `| null` union is important: it tells the type checker that `this._pageSession` might be `null`, so any access should be guarded. This is why `getData()` starts with:

```js
// HarCollector.getData()
if (!this._pageSession) {
  this._log?.(HAR, 'no page session — returning null');
  return null;
}
// After this guard VS Code knows _pageSession is non-null
```

---

## Key Takeaways

- `Network.enable` must be called on every `CDPSession` individually — there is no global enable.
- Call `Network.enable` **before** `Runtime.runIfWaitingForDebugger` or you miss the first requests.
- Call `getResponseBody` on the **session that received `loadingFinished`** — bodies are session-local.
- Use `Promise.allSettled` when operating across multiple sessions — one dead session must not kill the rest.
- `addTarget()` must be `async` and must `await` all setup — the crawler awaits it before releasing the target.
- `@typedef` and inline `import()` give you full type safety without a TypeScript compiler.

---

*Generated with Claude Sonnet 4.6 (`claude-sonnet-4-6`) — Anthropic*
