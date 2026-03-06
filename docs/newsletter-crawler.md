# CDP Newsletter Crawler — Deep Dive Reference

A technical reference for the techniques used in a Node.js web crawler that finds and auto-submits newsletter signup forms using Chrome DevTools Protocol (CDP) via `puppeteer-core`, operating entirely through raw CDP sessions without the Puppeteer Page API.

---

## Table of Contents

1. [CDP Sessions and Runtime.evaluate](#1-cdp-sessions-and-runtimeevaluate)
2. [Cross-origin iframes and the DOM visibility problem](#2-cross-origin-iframes-and-the-dom-visibility-problem)
3. [CDP Input events and viewport coordinates](#3-cdp-input-events-and-viewport-coordinates)
4. [Consent wall suppression](#4-consent-wall-suppression)
5. [Human simulation via CDP](#5-human-simulation-via-cdp)
6. [reCAPTCHA v2 invisible / v3 interaction](#6-recaptcha-v2-invisible--v3-interaction)
7. [Form scoring and detection heuristics](#7-form-scoring-and-detection-heuristics)

---

## 1. CDP Sessions and Runtime.evaluate

### What is a CDPSession?

A `CDPSession` is a multiplexed connection to a specific **target** inside Chrome — a target being any inspectable context: a tab, a service worker, a dedicated worker, or a sub-frame. Puppeteer exposes `browser.target().createCDPSession()` or `page.target().createCDPSession()`, but you can also open sessions directly via the `Target` domain.

Internally, Chrome implements the [DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) over a WebSocket. Each session gets a `sessionId`. Every CDP message sent on that session is scoped to the target it represents. Two sessions pointing to two different frames are completely isolated — they run JS in different V8 contexts, with different `window` objects and different DOMs.

```js
// Attach to the browser target, then create a session for a specific target
const browser = await puppeteer.launch({ executablePath: '...', headless: true });
const client = await browser.target().createCDPSession();

// Or, from an existing page:
const page = await browser.newPage();
const session = await page.target().createCDPSession();
```

**Official reference:** [Chrome DevTools Protocol — Sessions](https://chromedevtools.github.io/devtools-protocol/)

---

### session.send('Runtime.evaluate', {...})

`Runtime.evaluate` executes a JavaScript expression in the context of the session's target. It is the lowest-level way to run code inside a browsing context from Node.js.

```js
const result = await session.send('Runtime.evaluate', {
  expression: `document.title`,
  returnByValue: true,
  userGesture: true,
  awaitPromise: false,
});
console.log(result.result.value); // "My Page Title"
```

**Official reference:** [Runtime.evaluate](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate)

---

### The key options

#### `returnByValue`

By default, `Runtime.evaluate` returns a **remote object handle** — a reference to the object living inside V8, described by its type, class, and a preview. You cannot directly use the data in Node.js without a further `Runtime.getProperties` call.

Setting `returnByValue: true` tells Chrome to JSON-serialize the result and return it as a plain value. This works for primitives, plain objects, and arrays. It **fails silently or throws** for DOM nodes, functions, circular references, or anything that cannot be JSON-serialized.

```js
// returnByValue: false (default) — returns a RemoteObject handle
{ result: { type: 'object', className: 'HTMLInputElement', objectId: '...' } }

// returnByValue: true — returns the serialized value directly
{ result: { type: 'string', value: 'hello@example.com' } }
```

Use `returnByValue: true` whenever you only need data (strings, numbers, booleans, POJOs). Use the default (false) when you need to hold a reference to a DOM node for further CDP calls like `DOM.getBoxModel`.

#### `userGesture`

Some browser APIs are gated behind a **user activation** requirement — `element.click()` on a file input, `window.open()`, clipboard writes, and fullscreen requests all require that the call originates from a user gesture (a real input event). Without user activation the call is silently ignored or throws a security error.

Setting `userGesture: true` marks the evaluation as if it were triggered by a real user gesture. Chrome grants transient activation to the browsing context for the duration of that call.

```js
// Without userGesture: true, this may be blocked
await session.send('Runtime.evaluate', {
  expression: `document.querySelector('input[type=file]').click()`,
  userGesture: true,
  returnByValue: true,
});
```

#### `awaitPromise`

If your `expression` evaluates to a `Promise`, setting `awaitPromise: true` instructs Chrome to await that promise before returning the result. Without it, you get back the Promise object handle itself, not the resolved value.

```js
const { result } = await session.send('Runtime.evaluate', {
  expression: `
    new Promise(resolve => {
      setTimeout(() => resolve(document.forms.length), 500);
    })
  `,
  awaitPromise: true,
  returnByValue: true,
});
console.log(result.value); // number of forms, after 500ms
```

If the promise rejects, the rejection reason surfaces in `exceptionDetails` (see below).

---

### The silent-nothing problem: evaluating in the wrong session

This is one of the most confusing bugs in CDP work. Suppose an email signup form lives inside a cross-origin iframe. If you call `Runtime.evaluate` on the **main frame's session** and try to `querySelector` for that form, you will get `null` — silently, with no error. The code ran fine; it just ran in the wrong context.

Chrome enforces the same-origin policy in the DevTools Protocol exactly as it does in the browser: the main frame's JavaScript context cannot access the DOM of a cross-origin child frame. Since `Runtime.evaluate` executes in the V8 context associated with the session, a session on the main frame literally cannot see the child frame's `document`.

Each frame — same-origin or cross-origin — has its own target, its own session, and its own JavaScript context. To interact with content in a sub-frame you **must** obtain a session for that frame's target.

```js
// This returns null if the form is in a cross-origin iframe — no error thrown
const result = await mainSession.send('Runtime.evaluate', {
  expression: `document.querySelector('form.newsletter')`,
  returnByValue: true,
});
// result.result.value === null — silently wrong
```

---

### Error surfacing: exceptionDetails vs thrown exceptions

`Runtime.evaluate` does not throw a Node.js exception when the evaluated JavaScript throws. Instead, it returns normally and populates the `exceptionDetails` field on the response object.

```js
const response = await session.send('Runtime.evaluate', {
  expression: `null.property`, // TypeError
  returnByValue: true,
});

if (response.exceptionDetails) {
  const ex = response.exceptionDetails;
  console.error(`JS Exception: ${ex.text}`);
  console.error(`Line ${ex.lineNumber}: ${ex.exception?.description}`);
}
```

`exceptionDetails` contains:
- `text` — a short message
- `lineNumber` / `columnNumber` — location in the evaluated expression
- `exception` — a `RemoteObject` describing the thrown value
- `stackTrace` — a `StackTrace` object

Node.js-level throws from `session.send(...)` itself only happen for **protocol errors** — malformed messages, unknown methods, or CDP-level failures (e.g. calling a method on a detached session). These are distinct from JavaScript exceptions thrown inside the evaluated expression.

```js
try {
  await session.send('Runtime.evaluate', { expression: `...`, returnByValue: true });
} catch (protocolError) {
  // A CDP-level problem, not a JS exception
  console.error('CDP protocol error:', protocolError.message);
}
```

---

## 2. Cross-origin iframes and the DOM visibility problem

### Why document.querySelector returns nothing

When a browser loads a page containing an `<iframe src="https://different-origin.com/widget">`, the browser enforces the **Same-Origin Policy**. The parent page's JavaScript cannot access `iframe.contentDocument` or `iframe.contentWindow` when the origins differ. This is not a Puppeteer limitation — it is enforced at the V8/Blink level.

Via CDP, this boundary maps directly to target isolation. The main frame's `Runtime.evaluate` context is the parent page's V8 context. Expressions like `document.forms`, `document.querySelector('input[type=email]')`, and `getBoundingClientRect()` all operate on `document` — which is the parent page's document. The iframe's document is invisible from here.

Even `document.querySelectorAll('iframe')` will find the `<iframe>` element in the parent DOM, but calling `.contentDocument` on it from the main frame's CDP session returns `null` for cross-origin frames.

```js
// In the main frame session — will NOT find form inside cross-origin iframe
const found = await mainSession.send('Runtime.evaluate', {
  expression: `!!document.querySelector('input[type=email]')`,
  returnByValue: true,
});
// found.result.value === false — even if a perfectly valid form exists in the iframe
```

**Further reading:** [MDN — Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy)

---

### How CDP exposes separate frame targets

Chrome creates a separate **Target** for each cross-origin browsing context. You discover these via the `Target` domain.

Enable target discovery on your session first:

```js
await session.send('Target.setDiscoverTargets', { discover: true });
```

Then listen for `Target.targetCreated` and `Target.targetInfoChanged` events:

```js
session.on('Target.targetCreated', ({ targetInfo }) => {
  if (targetInfo.type === 'iframe') {
    console.log('Found iframe target:', targetInfo.targetId, targetInfo.url);
  }
});
```

Each iframe target has:
- `targetId` — unique identifier
- `type: 'iframe'`
- `url` — the iframe's current URL
- `browserContextId` — which browser context it belongs to

**Note:** Same-origin iframes do **not** always get their own target in older Chrome versions. Chrome 96+ creates targets for all cross-origin iframes when target discovery is enabled, but same-origin frames share the parent's target/context. This behaviour is controlled by the [Site Isolation](https://www.chromium.org/Home/chromium-security/site-isolation/) architecture.

**Official reference:** [Target domain — CDP](https://chromedevtools.github.io/devtools-protocol/tot/Target/)

---

### Attaching to iframe targets and probing for the form

Once you have a `targetId` for an iframe, attach to it and create a session:

```js
const { sessionId } = await session.send('Target.attachToTarget', {
  targetId: iframeTargetInfo.targetId,
  flatten: true, // Flatten session for direct message routing
});

// Now send commands using that sessionId
const iframeSession = /* CDPSession wrapping sessionId */;

const hasForm = await iframeSession.send('Runtime.evaluate', {
  expression: `!!document.querySelector('input[type=email]')`,
  returnByValue: true,
});
```

In practice with `puppeteer-core`, you collect these iframe sessions by listening to the browser's `targetcreated` event:

```js
browser.on('targetcreated', async (target) => {
  if (target.type() === 'iframe') {
    const iframeSession = await target.createCDPSession();
    iframeSessions.set(target.url(), iframeSession);
  }
});
```

To find which iframe contains the form, probe each session:

```js
async function findFormSession(sessions) {
  for (const [url, sess] of sessions) {
    const { result } = await sess.send('Runtime.evaluate', {
      expression: `
        (() => {
          const input = document.querySelector('input[type=email]');
          return input ? JSON.stringify(input.getBoundingClientRect()) : null;
        })()
      `,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result.value !== null) return sess;
  }
  return null;
}
```

---

### Same-origin vs cross-origin iframes

| Property | Same-origin iframe | Cross-origin iframe |
|---|---|---|
| Parent can access `contentDocument` | Yes | No |
| Gets its own CDP target | Sometimes (Chrome 96+, Site Isolation) | Always |
| `document.querySelector` from parent session | Works | Returns null |
| Requires own CDPSession | Not always | Always |
| `getBoundingClientRect()` coordinate space | Parent viewport | Own viewport (offset) |

**Important coordinate note:** When you call `getBoundingClientRect()` inside an iframe's session, the returned coordinates are relative to the **iframe's own viewport**, not the top-level page viewport. To dispatch `Input.dispatchMouseEvent` (which always uses top-level viewport coordinates), you must add the iframe's offset within the page to the element's in-frame rect.

```js
// Get the iframe element's position in the parent page
const { result: iframeRect } = await mainSession.send('Runtime.evaluate', {
  expression: `JSON.stringify(document.querySelector('iframe').getBoundingClientRect())`,
  returnByValue: true,
});
const iframeOffset = JSON.parse(iframeRect.value);

// Get the input's position inside the iframe
const { result: inputRect } = await iframeSession.send('Runtime.evaluate', {
  expression: `JSON.stringify(document.querySelector('input[type=email]').getBoundingClientRect())`,
  returnByValue: true,
});
const input = JSON.parse(inputRect.value);

// Combine for top-level viewport coords
const x = iframeOffset.x + input.x + input.width / 2;
const y = iframeOffset.y + input.y + input.height / 2;
```

---

## 3. CDP Input events and viewport coordinates

### Input.dispatchMouseEvent and Input.dispatchKeyEvent

The `Input` domain lets you inject synthetic input events at the browser level, below the JavaScript event system. These events are indistinguishable from real hardware input from Chrome's perspective.

**`Input.dispatchMouseEvent`** parameters:
- `type`: `"mousePressed"`, `"mouseReleased"`, `"mouseMoved"`, `"mouseWheel"`
- `x`, `y`: viewport-relative coordinates (floats)
- `button`: `"left"`, `"right"`, `"middle"`, `"none"`
- `clickCount`: `1` for single click, `2` for double
- `modifiers`: bitmask (1=Alt, 2=Ctrl, 4=Meta, 8=Shift)

```js
async function cdpClick(session, x, y) {
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
}
```

**`Input.dispatchKeyEvent`** parameters:
- `type`: `"keyDown"`, `"keyUp"`, `"char"` (deprecated), `"rawKeyDown"`
- `key`: the key name per [UI Events KeyboardEvent key values](https://www.w3.org/TR/uievents-key/)
- `text`: the character text to insert (only relevant for `keyDown`)
- `unmodifiedText`: same as `text` but without modifiers applied

For typing characters, use `keyDown` with `text` set, then `keyUp`. For special keys (Tab, Enter, Backspace), use `rawKeyDown` + `keyUp` with the appropriate `key` value and `windowsVirtualKeyCode`.

**Official reference:** [Input domain — CDP](https://chromedevtools.github.io/devtools-protocol/tot/Input/)

---

### Why coordinates must be viewport-relative

`Input.dispatchMouseEvent` operates in the **viewport coordinate space** — the visible area of the browser window, with `(0, 0)` at the top-left of what is currently visible. This is fundamentally different from:

- **Page/document coordinates**: include scroll offset. `element.offsetTop` gives you page coordinates.
- **Screen coordinates**: absolute on the physical monitor.

`getBoundingClientRect()` returns a `DOMRect` with `top`, `left`, `bottom`, `right`, `width`, `height` — all **viewport-relative**. This makes it the right tool for getting coordinates to feed to CDP mouse events.

**The subtlety:** `getBoundingClientRect()` reflects the element's position at the moment you call it. If the page is scrolled after the call, those coordinates are stale. If the element is **below the fold** (not yet scrolled into view), its `top` value will be larger than the viewport height, meaning the point is not currently visible — and a mouse click at those coords would miss entirely or hit a different element.

---

### The below-the-fold problem and the fix

```js
// ❌ Wrong: reading rect before scrolling into view
const { result } = await session.send('Runtime.evaluate', {
  expression: `JSON.stringify(document.querySelector('#email-input').getBoundingClientRect())`,
  returnByValue: true,
});
const rect = JSON.parse(result.value);
// rect.top may be 1800 on a 900px viewport — element is off-screen
// clicking at y=1800 clicks nothing meaningful
```

The fix is to scroll the element into view first, then re-read the rect:

```js
// ✅ Correct: scroll first, then read rect
await session.send('Runtime.evaluate', {
  expression: `
    document.querySelector('#email-input').scrollIntoView({
      behavior: 'instant',
      block: 'center',
      inline: 'center'
    })
  `,
  returnByValue: true,
});

// Now rect reflects the post-scroll viewport position
const { result } = await session.send('Runtime.evaluate', {
  expression: `JSON.stringify(document.querySelector('#email-input').getBoundingClientRect())`,
  returnByValue: true,
});
const rect = JSON.parse(result.value);
const x = rect.left + rect.width / 2;
const y = rect.top + rect.height / 2;
```

Use `behavior: 'instant'` rather than `'smooth'` — smooth scrolling is asynchronous and there is no event to await. With instant scrolling, the scroll is synchronous within the evaluate call, so the rect is valid immediately after.

---

## 4. Consent wall suppression

### Storage.setCookies — injecting cookies before render

The CDP `Storage` domain allows you to set cookies for a specific URL before the page loads. This is critical for consent management platforms (CMPs) that check for a consent cookie on first paint and skip the consent wall if it is present.

```js
await session.send('Storage.setCookies', {
  cookies: [
    {
      name: 'CookieConsent',      // Cookiebot cookie name
      value: JSON.stringify({
        stamp: '+',
        necessary: true,
        preferences: true,
        statistics: true,
        marketing: true,
        ver: 1,
        utc: Date.now(),
        region: 'es',
      }),
      domain: '.example.com',
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'Lax',
    },
  ],
});
```

This must be called **before** `Page.navigate` — once the page starts loading, the cookie is already available to the server and to `document.cookie` on the client.

**Official reference:** [Storage.setCookies — CDP](https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-setCookies)

---

### Page.addScriptToEvaluateOnNewDocument

This CDP method injects a script that runs **before any page script**, including before the CMP bundle is parsed. It runs in the same V8 context as the page and has full access to `window`, `localStorage`, and the DOM (though the DOM is not yet populated — `DOMContentLoaded` has not fired).

This is the correct place to set `localStorage` flags that CMPs read to determine whether to show a consent wall.

```js
await session.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    // OneTrust — set consent for all categories
    window.OnetrustActiveGroups = ',C0001,C0002,C0003,C0004,';
    try {
      localStorage.setItem('OptanonConsent',
        'isGpcEnabled=0&datestamp=...' +
        '&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1&isIABGlobal=false'
      );
      localStorage.setItem('OptanonAlertBoxClosed', new Date().toISOString());
    } catch(e) {}

    // Didomi
    try {
      const didomiConsent = {
        vendors: { enabled: [], disabled: [] },
        purposes: { enabled: ['cookies','analytics','advertising'], disabled: [] },
        version: 2,
      };
      localStorage.setItem('didomi_token', btoa(JSON.stringify(didomiConsent)));
    } catch(e) {}
  `,
});
```

**Why this is the right place:** Scripts registered here run in the "document creation" phase — after the V8 context is created but before `<script>` tags are evaluated. Any global variables you set on `window` will be visible to the page scripts when they run. If you instead injected via `Runtime.evaluate` after navigation, there is a race: the CMP may have already read the localStorage, found nothing, and started rendering the consent wall.

**Official reference:** [Page.addScriptToEvaluateOnNewDocument — CDP](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument)

---

### What each CMP looks for

**OneTrust**
- Cookie: `OptanonConsent` — URL-encoded key-value pairs including `groups=C0001:1,...`
- Cookie: `OptanonAlertBoxClosed` — ISO 8601 timestamp; if present, the banner is suppressed
- `localStorage`: same keys as above
- `window.OnetrustActiveGroups` — a comma-delimited string of accepted group IDs

**Didomi**
- `localStorage`: `didomi_token` — a base64-encoded JSON object describing vendor/purpose consents
- Cookie: `euconsent-v2` — IAB TCF v2.0 consent string (used in combination with `didomi_token`)
- `window.didomiState` — Didomi reads this on init

**Cookiebot**
- Cookie: `CookieConsent` — a URL-encoded or JSON-encoded object with keys `necessary`, `preferences`, `statistics`, `marketing`, each set to `true`
- The cookie value must also contain a `stamp` field and a `utc` timestamp or Cookiebot will re-show the banner

**References:**
- [OneTrust SDK documentation](https://my.onetrust.com/s/article/UUID-69162cb7-c4a2-ac70-39a1-ca69c9340046)
- [Didomi SDK documentation](https://developers.didomi.io/)
- [Cookiebot documentation](https://www.cookiebot.com/en/developer/)
- [IAB TCF v2.0 specification](https://iabeurope.eu/tcf-2-0/)

---

### The runtime click fallback

Some CMPs perform **server-side verification** of consent — they send the consent cookie to their own servers to validate it, and if it doesn't check out cryptographically (e.g. Cookiebot's `stamp` HMAC is invalid), they display the consent wall regardless of the cookie value.

In these cases, you need to actually click the "Accept" button. The danger is accidentally clicking a "Log in", "Subscribe", or paywall button instead. A safe strategy:

```js
async function dismissConsentWall(session) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: `
      (() => {
        // Prioritise specific accept-all selectors, then fall back to text matching
        const selectors = [
          '#onetrust-accept-btn-handler',
          '.didomi-continue-without-agreeing',       // Didomi "accept"
          '[aria-label*="accept" i]',
          '[id*="accept-all" i]',
          '[class*="accept-all" i]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            // Sanity check: must be visible and not suspiciously large
            if (rect.width > 0 && rect.height > 0 && rect.width < 600) {
              el.scrollIntoView({ behavior: 'instant', block: 'center' });
              return JSON.stringify(rect);
            }
          }
        }
        return null;
      })()
    `,
    returnByValue: true,
    userGesture: true,
  });
  if (result.value) {
    const rect = JSON.parse(result.value);
    await cdpClick(session, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
}
```

The width check (`rect.width < 600`) is a heuristic guard: consent accept buttons are small. Paywall or full-page overlay buttons tend to be wide. Adjust as needed per site.

---

## 5. Human simulation via CDP

### Realistic mouse movement with interpolated paths

A real mouse does not teleport from point A to point B. It follows a curve with micro-variations in velocity and direction. Naive CDP crawlers that dispatch a single `mousePressed` + `mouseReleased` pair are easily detected by fingerprinting scripts that hook `mousemove` and measure event cadence.

The strategy is to interpolate a series of `mouseMoved` events between the current cursor position and the target, with small random noise applied to each step:

```js
async function humanMouseMove(session, fromX, fromY, toX, toY, steps = 25) {
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Ease in-out for natural acceleration/deceleration
    const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    const noise = () => (Math.random() - 0.5) * 3;
    const x = fromX + (toX - fromX) * eased + (i < steps ? noise() : 0);
    const y = fromY + (toY - fromY) * eased + (i < steps ? noise() : 0);

    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'none',
    });

    // Random delay between moves: 5–20ms
    await new Promise(r => setTimeout(r, 5 + Math.random() * 15));
  }
}
```

Call this before every click to simulate the approach. You can also add a slight arc using a Bezier curve for more organic paths.

---

### Per-character typing with random delays

```js
async function humanType(session, text) {
  for (const char of text) {
    // keyDown with text inserts the character
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      key: char,
      unmodifiedText: char,
    });
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char,
    });

    // Random inter-keystroke delay: 40–180ms (mimics 70–150 WPM)
    await new Promise(r => setTimeout(r, 40 + Math.random() * 140));
  }
}
```

The delay distribution matters. A perfectly uniform inter-key delay (e.g. always 80ms) is statistically impossible for a human. Mix in occasional longer pauses (200–400ms) to simulate momentary hesitation on ~5% of characters.

---

### Why native events are necessary for SPAs

React, Vue, and Angular maintain their own internal state for controlled form inputs. They attach `onChange` / `oninput` synthetic event listeners that update the framework's state tree. If you set `input.value = 'foo'` directly (or drive input via raw CDP key events alone), the framework's event listener may not fire — because the DOM property setter doesn't automatically dispatch events.

The fix is to programmatically dispatch `input` and `change` events after modifying the value:

```js
await session.send('Runtime.evaluate', {
  expression: `
    (() => {
      const input = document.querySelector('input[type=email]');
      // Use the native value setter (bypasses framework-overridden setters)
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeInputValueSetter.call(input, 'test@example.com');

      // Trigger the events React/Vue/Angular listen to
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    })()
  `,
  returnByValue: true,
});
```

Using `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` is necessary because frameworks (particularly React 16+) override the `value` property on the element instance. Calling `input.value = 'x'` hits the overridden setter, which may update the DOM but **not** emit the events React needs. Calling the prototype's native setter bypasses the override and triggers a genuine DOM property change that the framework's event listeners detect.

**Reference:** [React — Simulating events](https://legacy.reactjs.org/docs/test-utils.html#simulate), [JSDOM issue on native setters](https://github.com/jsdom/jsdom/issues/1665)

---

### Honeypot field detection

Many forms include hidden "honeypot" fields — inputs invisible to real users but visible to scrapers. Their names often look plausible (`phone2`, `website`, `company_name`) to trick bots into filling them. If any honeypot field is filled, the server silently discards or flags the submission.

Detection is simple: honeypots are hidden via CSS, and CSS-hidden elements report a bounding rect of `{ width: 0, height: 0, top: 0, left: 0 }` from `getBoundingClientRect()`. Additionally, they may have `display: none`, `visibility: hidden`, `opacity: 0`, or be positioned off-screen.

```js
async function getVisibleInputs(session) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: `
      (() => {
        return Array.from(document.querySelectorAll('input, textarea, select'))
          .filter(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none') return false;
            if (style.visibility === 'hidden') return false;
            if (parseFloat(style.opacity) === 0) return false;
            return true;
          })
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            name: el.name || '',
            id: el.id || '',
            placeholder: el.placeholder || '',
            rect: el.getBoundingClientRect(),
          }));
      })()
    `,
    returnByValue: true,
  });
  return result.value;
}
```

Only fill inputs that pass the visibility check. Do not fill any input with `rect.width === 0` or `rect.height === 0`.

---

## 6. reCAPTCHA v2 invisible / v3 interaction

### What grecaptcha.execute() does

Google reCAPTCHA exposes `window.grecaptcha` on pages that include the reCAPTCHA script. For **invisible reCAPTCHA v2** and **reCAPTCHA v3**, `grecaptcha.execute(widgetIdOrSiteKey, options)` triggers the risk analysis and eventually calls the callback registered when the widget was rendered — typically the callback that submits the form.

Calling `grecaptcha.execute()` directly in an `Runtime.evaluate` expression can **bypass the button click entirely** and jump straight to the point where the form is ready to submit (if the challenge score is adequate):

```js
await session.send('Runtime.evaluate', {
  expression: `
    if (window.grecaptcha && typeof grecaptcha.execute === 'function') {
      // For v3 or invisible v2 programmatic invocation
      grecaptcha.execute();
    }
  `,
  returnByValue: true,
  userGesture: true,
});
```

Whether this works depends on whether the widget was set up with an explicit callback, and whether Google's servers issue a passing score.

---

### Invisible reCAPTCHA v2 — data-bind and click interception

For invisible reCAPTCHA v2 embedded via a `<button data-sitekey="..." data-callback="onSubmit">` pattern, reCAPTCHA's JavaScript wraps the button with a click handler. When the button is clicked, reCAPTCHA:

1. Intercepts the click event
2. Calls `grecaptcha.execute()` to trigger the risk assessment
3. On success, calls the callback specified in `data-callback` (e.g. `onSubmit`)
4. Inside that callback, the developer typically calls `document.getElementById('myForm').submit()`

A raw CDP mouse click (`Input.dispatchMouseEvent`) dispatches a real click on the button, which **should** trigger the reCAPTCHA-bound click handler — unlike synthetic `element.click()` calls from JavaScript which can be treated differently. However, if Chrome's security heuristics decide the click is not from a genuine user gesture (e.g. no prior mouse movement, immediate click on page load), the reCAPTCHA token may be scored as a bot.

**The workaround:** Simulate mouse movement toward the button first (see Section 5), then perform the click. The `userGesture: true` flag in the preceding evaluate call also helps establish user activation context.

---

### Why raw CDP clicks bypass reCAPTCHA callbacks

Some reCAPTCHA integrations use `form.addEventListener('submit', handler)` where the handler checks for a valid token, rather than using `data-bind`. In these cases, submitting the form via CDP without a token (e.g. calling `form.submit()` via `Runtime.evaluate`) skips the event listener and sends the form without the `g-recaptcha-response` field.

```js
// ❌ Bypasses submit event listeners — g-recaptcha-response will be empty
await session.send('Runtime.evaluate', {
  expression: `document.querySelector('form').submit()`,
  returnByValue: true,
});

// ✅ Triggers submit event listeners (reCAPTCHA can intercept and add token)
await session.send('Runtime.evaluate', {
  expression: `
    document.querySelector('form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
  `,
  returnByValue: true,
  userGesture: true,
});
```

---

### The bframe and anchor iframes

When reCAPTCHA v2 is in **checkbox mode** (the "I'm not a robot" checkbox), it renders two iframes:

- **`anchor` iframe** (`https://www.google.com/recaptcha/api2/anchor?...`): contains the visible checkbox UI. Clicking the checkbox triggers the risk assessment.
- **`bframe` iframe** (`https://www.google.com/recaptcha/api2/bframe?...`): the challenge iframe. If the risk score is insufficient, the image challenge popup appears here.

Both are cross-origin iframes. You cannot interact with them from the main frame's JS. You must:
1. Find their CDP targets using the iframe target discovery approach from Section 2
2. Attach a session to the `anchor` iframe target
3. Use `Input.dispatchMouseEvent` to click the checkbox at the correct viewport-relative coordinates within that frame

The `bframe` challenge (image grid) requires additional handling — you would need to solve it (out of scope here) or rely on the risk score being high enough to skip it.

**Reference:** [Google reCAPTCHA documentation](https://developers.google.com/recaptcha/docs/display)

---

## 7. Form scoring and detection heuristics

### Keyword density scoring

Not every form on a page is a newsletter signup. Login forms, search bars, checkout forms, and contact forms all contain `<input type="email">`. A scoring heuristic based on keyword density is the most robust way to identify newsletter/subscription forms without site-specific logic.

Score a form by examining multiple signals and summing weights:

```js
function scoreForm(formEl) {
  // Collect all text visible on/around the form
  const text = [
    formEl.textContent,
    formEl.id,
    formEl.className,
    formEl.action || '',
    ...Array.from(formEl.querySelectorAll('*')).flatMap(el => [
      el.id, el.className, el.name || '', el.placeholder || '',
      el.getAttribute('aria-label') || '',
    ]),
  ].join(' ').toLowerCase();

  const POSITIVE = {
    newsletter: 10, subscribe: 10, subscription: 8, 'sign up': 8,
    signup: 8, 'email updates': 8, digest: 6, updates: 5, weekly: 5,
    monthly: 5, notify: 5, notification: 4, 'stay informed': 4, inbox: 4,
  };
  const NEGATIVE = {
    login: -15, 'log in': -15, signin: -15, 'sign in': -15, password: -15,
    checkout: -15, payment: -15, 'credit card': -15, billing: -15,
    register: -8, account: -8, cart: -10, order: -8,
    search: -10, comment: -6, reply: -6,
  };

  let score = 0;
  for (const [kw, weight] of Object.entries(POSITIVE)) {
    if (text.includes(kw)) score += weight;
  }
  for (const [kw, weight] of Object.entries(NEGATIVE)) {
    if (text.includes(kw)) score += weight; // weights are negative
  }
  return score;
}
```

A form with a score ≥ 8 is a strong newsletter candidate. Adjust thresholds based on observed false-positive rates.

---

### Disqualifying login, checkout, and payment forms

Before scoring, apply hard disqualification rules:

```js
function isDisqualified(formEl) {
  // Password fields are a near-certain disqualifier
  if (formEl.querySelector('input[type=password]')) return true;

  // Payment fields
  if (formEl.querySelector('input[autocomplete*=cc], input[name*=card], input[name*=cvv]'))
    return true;

  // Action URL hints
  const action = (formEl.action || '').toLowerCase();
  const disqualifyingPaths = ['/login', '/signin', '/checkout', '/payment', '/cart', '/register'];
  if (disqualifyingPaths.some(p => action.includes(p))) return true;

  return false;
}
```

---

### Matching email input fields

In decreasing order of reliability:

```js
function findEmailInput(formEl) {
  // 1. Explicit type="email" — most reliable
  let input = formEl.querySelector('input[type=email]');
  if (input) return input;

  // 2. Name, id, or placeholder hints
  const hints = ['email', 'e-mail', 'mail', 'correo', 'courriel'];
  for (const hint of hints) {
    input = formEl.querySelector(
      `input[name*="${hint}" i], input[id*="${hint}" i], input[placeholder*="${hint}" i]`
    );
    if (input) return input;
  }

  // 3. Aria-label
  input = Array.from(formEl.querySelectorAll('input')).find(el =>
    (el.getAttribute('aria-label') || '').toLowerCase().includes('email')
  );
  if (input) return input;

  // 4. Fallback: the only text input in the form
  const textInputs = Array.from(formEl.querySelectorAll('input[type=text], input:not([type])'));
  if (textInputs.length === 1) return textInputs[0];

  return null;
}
```

---

### Standalone email inputs outside a form element

Newsletter signups in footers and SPAs frequently don't use a `<form>` element at all. They might be a bare `<input type="email">` + `<button>Submit</button>` inside a `<div>`, connected by JavaScript event listeners rather than a native form submission.

Strategy:

```js
async function findStandaloneEmailInputs(session) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: `
      (() => {
        return Array.from(document.querySelectorAll('input[type=email]'))
          .filter(input => !input.closest('form'))
          .filter(input => {
            const rect = input.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })
          .map(input => {
            // Find the nearest sibling or parent button
            const parent = input.parentElement;
            const submitBtn = parent?.querySelector('button, input[type=submit]')
              || parent?.parentElement?.querySelector('button, input[type=submit]');
            return {
              inputRect: input.getBoundingClientRect(),
              buttonRect: submitBtn ? submitBtn.getBoundingClientRect() : null,
              buttonText: submitBtn ? submitBtn.textContent.trim() : null,
            };
          });
      })()
    `,
    returnByValue: true,
  });
  return result.value || [];
}
```

For SPA-based forms, after filling the email input and dispatching framework events (see Section 5), click the button using its viewport coordinates rather than calling `.click()` — the button's click handler is typically what initiates the API call.

---

## References

| Topic | Reference |
|---|---|
| Chrome DevTools Protocol | https://chromedevtools.github.io/devtools-protocol/ |
| Runtime.evaluate | https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate |
| Input domain | https://chromedevtools.github.io/devtools-protocol/tot/Input/ |
| Target domain | https://chromedevtools.github.io/devtools-protocol/tot/Target/ |
| Storage.setCookies | https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-setCookies |
| Page.addScriptToEvaluateOnNewDocument | https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument |
| puppeteer-core | https://pptr.dev/ |
| Same-origin policy (MDN) | https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy |
| getBoundingClientRect (MDN) | https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect |
| HTMLInputElement (MDN) | https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement |
| UI Events key values (W3C) | https://www.w3.org/TR/uievents-key/ |
| Chrome Site Isolation | https://www.chromium.org/Home/chromium-security/site-isolation/ |
| reCAPTCHA documentation | https://developers.google.com/recaptcha/docs/display |
| IAB TCF v2.0 | https://iabeurope.eu/tcf-2-0/ |
| OneTrust SDK | https://my.onetrust.com/s/article/UUID-69162cb7-c4a2-ac70-39a1-ca69c9340046 |
| Didomi SDK | https://developers.didomi.io/ |
| Cookiebot | https://www.cookiebot.com/en/developer/ |

---

*Last updated: 2026. CDP protocol behaviour noted against Chrome 120+. Site Isolation (and separate iframe targets) is stable from Chrome 96 onwards.*

*Generated with Claude Sonnet 4.6 (`claude-sonnet-4-6`) — Anthropic*