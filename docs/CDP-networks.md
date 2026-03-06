# CDP & Puppeteer — Practical HAR Capture Guide

> Quick reference for Node.js crawlers using Puppeteer CDPSession + chrome-har.
> Generated with Claude Sonnet 4.6 (`claude-sonnet-4-6`)

---

## Index

1. [Request lifecycle](#1-request-lifecycle)
2. [Network idle](#2-network-idle)
3. [Targets and sessions](#3-targets-and-sessions)
4. [Page events](#4-page-events)
5. [Body capture](#5-body-capture)
6. [Attachment and waitForDebuggerOnStart](#6-attachment-and-waitfordebuggeronstart)
7. [Race conditions in multi-session](#7-race-conditions-in-multi-session)
8. [HAR capture failure modes](#8-har-capture-failure-modes)
9. [JS/JSDoc patterns](#9-jsjsdoc-patterns)

---

## 1. Request lifecycle

Event order for a normal request:

```
requestWillBeSent          → renderer decides to make the request
requestWillBeSentExtraInfo → browser process adds real cookies to the wire
responseReceived           → response headers received
responseReceivedExtraInfo  → real wire headers (including HttpOnly Set-Cookie)
dataReceived               → body chunks (0..N times)
loadingFinished            → body complete, safe to call getResponseBody
  — or —
loadingFailed              → error (net::ERR_*, canceled, blocked)
```

**Why two parallel streams?**
Chrome separates the renderer process and browser process. The renderer has no access to HttpOnly cookies — only the browser process attaches them to the wire. So `requestWillBeSentExtraInfo` is the only place you see the real sent cookies, and `responseReceivedExtraInfo` the only place you see `Set-Cookie` with HttpOnly values.

> ⚠️ `requestWillBeSentExtraInfo` can arrive **before** `requestWillBeSent`. Always correlate by `requestId`, not by arrival order.

**Docs:** [Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/) · [requestWillBeSent](https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-requestWillBeSent) · [responseReceived](https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-responseReceived) · [loadingFinished](https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-loadingFinished)

---

## 2. Network idle

Puppeteer doesn't use any Chrome-internal idle concept — it synthesizes it by counting events:

| `waitUntil` | Condition | Debounce |
|---|---|---|
| `networkidle0` | 0 in-flight requests | 500ms |
| `networkidle2` | ≤2 in-flight requests | 500ms |

Every `requestWillBeSent` increments the counter, every `loadingFinished`/`loadingFailed` decrements it.

**Where it breaks:**
- **Long-polling / SSE** — connection never closes, counter never reaches 0
- **SPAs with setTimeout** — network goes idle, Puppeteer resolves, then a second wave of requests fires
- **Service worker precaching** — its requests go through its own session, invisible to the page
- **WebSockets** — not counted in the in-flight counter, don't block idle

**Practical advice:** use `networkidle2` + a hard timeout, and don't declare done until `Page.loadEventFired` has fired.

**Docs:** [waitForNavigation](https://pptr.dev/api/puppeteer.page.waitfornavigation) · [PuppeteerLifeCycleEvent](https://pptr.dev/api/puppeteer.puppeteerlifecycleevent)

---

## 3. Targets and sessions

Each target (page, cross-process iframe, worker, service worker) has its own independent CDP session with its own network stack. Network events **do not bubble** to the parent.

**When does Chrome create a new process for an iframe?**
- Cross-site iframe → always its own process (Site Isolation, on by default since Chrome 67)
- Same-site iframe → shares the parent's process, its events appear in the parent's session
- If Chrome hits the process cap → it may collapse targets into the same process (non-deterministic)

**Why call `Network.enable` on each session?**
Because `Network.enable` activates instrumentation only in that session's `NetworkHandler`. There is no global enable.

```javascript
// Must do this on EVERY new session
await session.send('Network.enable', {
  maxTotalBufferSize: 20 * 1024 * 1024,
  maxResourceBufferSize: 5 * 1024 * 1024,
});
```

**Docs:** [Target domain](https://chromedevtools.github.io/devtools-protocol/tot/Target/) · [Network.enable](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-enable) · [Site Isolation](https://www.chromium.org/Home/chromium-security/site-isolation/)

---

## 4. Page events

| Event | When it fires | Web equivalent |
|---|---|---|
| `Page.frameStartedLoading` | Frame begins loading | — |
| `Page.frameNavigated` | Frame commits the navigation | — |
| `Page.domContentEventFired` | Parser done + defer scripts executed | `DOMContentLoaded` |
| `Page.loadEventFired` | All subresources loaded | `window.load` |
| `Page.frameStoppedLoading` | Frame load fully complete | — |
| `Page.navigatedWithinDocument` | Hash change or History API | No reload |

For a crawler, `Page.loadEventFired` is the minimum floor before declaring the navigation complete.

**Docs:** [Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/) · [loadEventFired](https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-loadEventFired)

---

## 5. Body capture

After `loadingFinished`, Chrome keeps the body in memory in the CDP session. You can retrieve it with `getResponseBody` until it gets evicted from the buffer.

**Buffer limits (`Network.enable`):**
- `maxTotalBufferSize` — total max for all bodies in that session (default: 10 MB)
- `maxResourceBufferSize` — max per individual response (default: 5 MB)

**When `getResponseBody` fails:**
- The request finished before you called `Network.enable`
- The buffer filled up and that entry was evicted
- Response has no body (204, 304, HEAD)
- Streaming response that never closes (SSE)
- You used the wrong session ← **very common mistake**

**The body is tied to the session that received `loadingFinished`.** If the event came from an iframe's session, you must call `getResponseBody` on that same session, not on the main page session.

```javascript
session.on('Network.loadingFinished', async (event) => {
  // `session` is captured in the closure — correct
  const body = await session.send('Network.getResponseBody', {
    requestId: event.requestId,
  });
});
```

**Docs:** [getResponseBody](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getResponseBody)

---

## 6. Attachment and `waitForDebuggerOnStart`

When using `Target.setAutoAttach` with `waitForDebuggerOnStart: true`, Chrome pauses the target before executing anything. The instrumentation window is:

```
attachedToTarget fires
  → you call Network.enable (and whatever else you need)
  → you call Runtime.runIfWaitingForDebugger
  → target resumes execution
  → first request fires → you catch it
```

If you call `Network.enable` **after** `runIfWaitingForDebugger` on a fast page, you miss the first wave of requests. The HAR will be incomplete.

**Propagation:** `setAutoAttach` only applies to the direct children of that session. To capture iframes inside iframes, call `setAutoAttach` on each new session you receive too.

**Docs:** [setAutoAttach](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach) · [attachedToTarget](https://chromedevtools.github.io/devtools-protocol/tot/Target/#event-attachedToTarget) · [runIfWaitingForDebugger](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-runIfWaitingForDebugger)

---

## 7. Race conditions in multi-session

### The `Promise.all` problem

If you use `Promise.all` to enable domains across sessions in parallel and one dead session rejects, **all the others get canceled**. Result: empty HAR.

```javascript
// ❌ Bad — one dead session kills all the others
await Promise.all(sessions.map(s => s.send('Network.enable', {})));

// ✅ Good — failures are expected, continues with the ones that work
await Promise.allSettled(sessions.map(s => s.send('Network.enable', {})));
```

### Why does Chrome attach the same target twice?

Happens most often with already-registered service workers. Chrome creates two sessions for the same target. The first becomes stale but its WebSocket stays open. Any command to that session returns `"Session closed"` or `"Target already exists"`.

**Detecting a dead session:** `session.connection()` returns `null` once the detach event is processed. But there's a window where it hasn't been processed yet — don't use it as a pre-check. Use try/catch instead.

### Defensive pattern

```javascript
async addTarget(session, targetInfo) {
  // Enable domains — ignore failures from dead sessions
  await Promise.allSettled([
    session.send('Network.enable', {}),
    session.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    }),
  ]);

  session.on('Network.loadingFinished', async (event) => {
    try {
      const body = await session.send('Network.getResponseBody', {
        requestId: event.requestId,
      });
      this._bodies[event.requestId] = body;
    } catch {
      // Expected: evicted buffer, closed session, bodyless response
    }
  });

  // Release the target — catch in case it wasn't paused
  await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
}
```

**Docs:** [Promise.allSettled](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled) · [detachedFromTarget](https://chromedevtools.github.io/devtools-protocol/tot/Target/#event-detachedFromTarget)

---

## 8. HAR capture failure modes

| Case | What happens | How to handle |
|---|---|---|
| **Duplicate requestId** | Unique per session, not across sessions | Prefix with sessionId: `"${sessionId}::${requestId}"` |
| **Redirects** | Same `requestId` fires multiple `requestWillBeSent`, each with `redirectResponse` | Don't overwrite in the Map — add one entry per event |
| **Memory cache** | Only fires `requestServedFromCache`, no `responseReceived` | `getResponseBody` will fail — HAR entry with no timing or body |
| **Disk cache** | Full sequence but `response.fromDiskCache === true` | Normal, works fine |
| **CORS preflight** | OPTIONS with its own `requestId`, no link to the actual request | Two separate HAR entries with no explicit relationship |
| **SSE / infinite chunked** | `loadingFinished` never fires | Detect by content-type and handle separately, or accept incomplete body |
| **Service worker** | May respond from cache without hitting the network | `responseReceived` with `fromServiceWorker: true`, no network events |
| **QUIC / HTTP3** | `timing.connectStart` can be `-1` on 0-RTT | Clamp timings to 0 to avoid negative values in the HAR |
| **304 / 204 / HEAD** | No body | `getResponseBody` fails — set `bodySize: 0` in the HAR entry |

**Docs:** [chrome-har](https://github.com/sitespeedio/chrome-har) · [HAR 1.2 spec](http://www.softwareishard.com/blog/har-12-spec/) · [requestServedFromCache](https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-requestServedFromCache)

---

## 9. JS/JSDoc patterns

### `async addTarget()` must actually be async

The framework does `await collector.addTarget(...)`. If the function isn't `async` or doesn't return the promise, the framework moves on without waiting and you miss everything.

```javascript
// ❌ Returns undefined — framework doesn't wait
addTarget(session, targetInfo) {
  session.send('Network.enable', {}).then(() => { /* too late */ });
}

// ✅ Framework waits until everything is ready
async addTarget(session, targetInfo) {
  await session.send('Network.enable', {});
}
```

### Closure over `session` in a loop — why it works

```javascript
for (const session of sessions) {
  session.on('Network.loadingFinished', async (event) => {
    await session.send('Network.getResponseBody', { requestId: event.requestId });
    //    ↑ captures the `session` from THIS iteration, not a shared variable
  });
}
```

`for...of` with `const` creates a new binding per iteration. Each closure captures its own `session`. This is not the classic `var` bug where all closures share the same variable.

### `Set<Promise>` for tracking in-flight work

```javascript
this._inFlight = new Set();

const p = fetchBody(session, event);
this._inFlight.add(p);
p.finally(() => this._inFlight.delete(p)); // self-cleaning, no leak

// In getData():
await Promise.allSettled([...this._inFlight]);
```

### JSDoc type imports across packages

```javascript
/**
 * @param {import('puppeteer-core').CDPSession} session
 * @param {import('devtools-protocol/types/protocol').Protocol.Target.TargetInfo} targetInfo
 */
async addTarget(session, targetInfo) { ... }
```

No `tsconfig.json` needed. VS Code resolves types directly from each package's `.d.ts`.

### `@typedef` goes before where it's used

JSDoc doesn't hoist. If you put the `@typedef` after the function that references it, the type checker won't find it.

### `?.()` for optional loggers

```javascript
this._log?.('message');  // won't throw TypeError if _log is undefined
```

Use it when the logger is genuinely optional. If it's required, call it directly so it fails loudly.

**Docs:** [Optional chaining](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Optional_chaining) · [JSDoc @typedef](https://jsdoc.app/tags-typedef) · [TypeScript JSDoc](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)

---

*Generated with Claude Sonnet 4.6 (`claude-sonnet-4-6`) — Anthropic*
