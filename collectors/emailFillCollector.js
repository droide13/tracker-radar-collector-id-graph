'use strict';

const BaseCollector = require('./BaseCollector');

// ─── Constants ────────────────────────────────────────────────────────────────

const NEWSLETTER_KEYWORDS = [
    'newsletter', 'subscribe', 'signup', 'sign-up', 'sign_up',
    'join', 'updates', 'mailing', 'email-list', 'notify', 'alerts'
];

const SUBMIT_TEXT_PATTERNS = [
    /^subscribe$/i, /^sign\s*up$/i, /^join$/i, /^submit$/i,
    /^get\s+updates$/i, /^notify\s+me$/i, /^keep\s+me\s+posted$/i,
    /^stay\s+informed$/i, /^get\s+started$/i, /^send$/i
];

const CAPTCHA_SELECTORS = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]',
    '.g-recaptcha',
    '.h-captcha',
    '[data-sitekey]',
    '#cf-turnstile',
    '.cf-turnstile'
];

const MAX_CANDIDATE_LINKS  = 6;
const POST_NAVIGATE_DELAY  = 4500;
const POST_SUBMIT_DELAY    = 3000;
const TYPING_DELAY_MIN_MS  = 60;
const TYPING_DELAY_MAX_MS  = 180;
const MOUSE_MOVE_STEPS     = 8;

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * EmailFillCollector
 *
 * Discovers newsletter / email-signup forms and submits them using
 * realistic human-like CDP interactions to avoid bot detection.
 *
 * Architecture
 * ────────────
 *  • BaseCollector lifecycle:  id → init → addTarget → postLoad → getData
 *  • _findCandidateLinks       DOM scan for newsletter-related hrefs
 *  • _attemptFill              high-level form-detection + submission flow
 *  • _locateEmailForm          pure DOM logic (runs inside page)
 *  • _humanFill                CDP Input events: mouse moves, realistic typing
 *  • _fillAncillaryFields      required selects / checkboxes (no email field)
 *  • _submitForm               click submit button or press Enter
 *  • _hasCaptcha               detect captcha iframes / widgets
 *  • _evaluate / _callFn       CDP Runtime helpers
 *  • _cdpClick / _cdpType      low-level human-simulation helpers
 */
class EmailFillCollector extends BaseCollector {

    /** Extra wait after page load so JS-heavy SPAs can settle. */
    collectorExtraTimeMs = 5000;

    // ── Lifecycle ──────────────────────────────────────────────────────────

    id() { return 'emailFill'; }

    init(options) {
        const { browserConnection, url, log, collectorFlags } = options;

        this._browserConnection = browserConnection;
        this._url               = url;
        this._log               = log;
        this._email             = (collectorFlags && collectorFlags['emailAddress']) || 'test@example.com';
        this._mainSession       = null;

        /** @type {{ visitedLinks: string[], filled: boolean, captchaPresent: boolean, formUrl: string|null, error: string|null }} */
        this._result = {
            visitedLinks : [],
            filled       : false,
            captchaPresent: false,
            formUrl      : null,
            error        : null
        };
    }

    async addTarget(session, targetInfo) {
        if (targetInfo.type === 'page' && !this._mainSession) {
            this._mainSession = session;
            // Enable Input domain so we can dispatch keyboard / mouse events
            await session.send('Input.enable').catch(() => {});
        }
    }

    async postLoad() {
        if (!this._mainSession) return;

        try {
            // 1. Try the page as-is
            let success = await this._attemptFill();

            // 2. Walk candidate newsletter links
            if (!success) {
                const links = await this._findCandidateLinks();
                this._log(`[emailFill] Found ${links.length} candidate link(s)`);

                for (const link of links) {
                    this._result.visitedLinks.push(link);
                    this._log(`[emailFill] Navigating to: ${link}`);

                    await this._mainSession.send('Page.navigate', { url: link });
                    await this._sleep(POST_NAVIGATE_DELAY);

                    success = await this._attemptFill();
                    if (success) break;
                }
            }

            this._result.filled = success;
            if (success) {
                const vl = this._result.visitedLinks;
                this._result.formUrl = (vl.length > 0 ? vl[vl.length - 1] : null) || this._url.href;
            }

        } catch (err) {
            this._log(`[emailFill] Unhandled error: ${err.message}`);
            this._result.error = err.message;
        }
    }

    async getData() {
        return this._result;
    }

    // ── Form Discovery ─────────────────────────────────────────────────────

    /**
     * Scan the page DOM for links that likely lead to a newsletter/signup page.
     * Runs entirely inside the page context via CDP evaluate.
     * @returns {Promise<string[]>}
     */
    async _findCandidateLinks() {
        return await this._evaluate(`
            (function () {
                const KW = ${JSON.stringify(NEWSLETTER_KEYWORDS)};
                const seen = new Set();
                const results = [];

                for (const el of document.querySelectorAll('a[href]')) {
                    const href  = el.href || '';
                    const text  = (el.textContent || '').toLowerCase();
                    const title = (el.title || '').toLowerCase();
                    const ariaL = (el.getAttribute('aria-label') || '').toLowerCase();
                    const combined = href.toLowerCase() + ' ' + text + ' ' + title + ' ' + ariaL;

                    if (KW.some(k => combined.includes(k)) && !seen.has(href)) {
                        seen.add(href);
                        results.push(href);
                        if (results.length >= ${MAX_CANDIDATE_LINKS}) break;
                    }
                }
                return results;
            })();
        `);
    }

    // ── Attempt Fill ───────────────────────────────────────────────────────

    /**
     * High-level: detect captcha, find email form, fill, submit.
     * @returns {Promise<boolean>}
     */
    async _attemptFill() {
        // Captcha check — bail out early, do not interact
        const captcha = await this._hasCaptcha();
        if (captcha) {
            this._log('[emailFill] Captcha detected – skipping page');
            this._result.captchaPresent = true;
            return false;
        }

        // Locate the best email form on this page
        const formInfo = await this._locateEmailForm();
        if (!formInfo) {
            this._log('[emailFill] No suitable email form found on page');
            return false;
        }

        this._log(`[emailFill] Email form found (index ${formInfo.formIndex}, field index ${formInfo.fieldIndex})`);

        // Fill ancillary required fields (selects, checkboxes) *before* typing email
        await this._fillAncillaryFields(formInfo.formIndex);

        // Human-like: move mouse somewhere random on the page first
        await this._randomMouseWander();

        // Type the email address character-by-character
        const typed = await this._humanFill(formInfo.fieldIndex, this._email);
        if (!typed) {
            this._log('[emailFill] Failed to focus / type into email field');
            return false;
        }

        // Small human pause before submitting
        await this._sleep(this._jitter(600, 1200));

        // Submit
        const submitted = await this._submitForm(formInfo.formIndex, formInfo.submitSelector);
        if (submitted) {
            await this._sleep(POST_SUBMIT_DELAY);
        }

        return submitted;
    }

    // ── DOM Introspection (runs inside page) ───────────────────────────────

    /**
     * Locate the most likely newsletter email form.
     * Returns metadata usable to drive CDP events from Node.
     *
     * Returns null when no suitable form found.
     * @returns {Promise<{formIndex:number, fieldIndex:number, submitSelector:string|null}|null>}
     */
    async _locateEmailForm() {
        return await this._evaluate(`
            (function () {
                const SUBMIT_PATTERNS = ${JSON.stringify(SUBMIT_TEXT_PATTERNS.map(r => r.source))};
                const submitRe = SUBMIT_PATTERNS.map(p => new RegExp(p, 'i'));

                // Score a form: higher = more likely to be a newsletter form
                function scoreForm(form) {
                    let score = 0;
                    const text = (form.textContent || '').toLowerCase();
                    const id   = (form.id   || '').toLowerCase();
                    const cls  = (form.className || '').toLowerCase();
                    const action = (form.action || '').toLowerCase();
                    const combined = text + ' ' + id + ' ' + cls + ' ' + action;

                    const KW = ${JSON.stringify(NEWSLETTER_KEYWORDS)};
                    KW.forEach(k => { if (combined.includes(k)) score += 3; });

                    // Penalise login / checkout forms
                    if (combined.includes('password') || combined.includes('login') ||
                        combined.includes('checkout') || combined.includes('payment')) {
                        score -= 20;
                    }

                    return score;
                }

                // All visible forms, ranked
                const forms = Array.from(document.querySelectorAll('form'))
                    .filter(f => {
                        const r = f.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    })
                    .map(f => ({ form: f, score: scoreForm(f) }))
                    .filter(x => x.score > -10)
                    .sort((a, b) => b.score - a.score);

                for (const { form } of forms) {
                    // Skip if any password field present
                    if (form.querySelector('input[type="password"]')) continue;

                    // Find email input
                    const emailField = Array.from(
                        form.querySelectorAll('input[type="email"], input[name*="email" i], input[placeholder*="email" i], input[id*="email" i]')
                    ).find(el => {
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly;
                    });

                    if (!emailField) continue;

                    // Resolve form index in document.forms
                    const formIndex = Array.from(document.forms).indexOf(form);

                    // Resolve field index in document.querySelectorAll inputs
                    const allInputs = Array.from(document.querySelectorAll('input'));
                    const fieldIndex = allInputs.indexOf(emailField);

                    // Find submit button
                    let submitSelector = null;
                    const btns = Array.from(
                        form.querySelectorAll('button, input[type="submit"], [role="button"]')
                    );
                    for (const btn of btns) {
                        const label = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim();
                        if (submitRe.some(r => r.test(label)) || btn.type === 'submit') {
                            // Build a unique-enough selector
                            if (btn.id) { submitSelector = '#' + CSS.escape(btn.id); break; }
                            if (btn.name) { submitSelector = '[name="' + btn.name + '"]'; break; }
                            submitSelector = 'button[type="submit"], input[type="submit"]';
                            break;
                        }
                    }

                    return { formIndex, fieldIndex, submitSelector };
                }

                // Fallback: standalone email inputs outside a <form>
                const standalone = Array.from(
                    document.querySelectorAll('input[type="email"], input[name*="email" i], input[placeholder*="email" i]')
                ).find(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly &&
                           !el.closest('form[action*="login"]') && !el.closest('[id*="login"]');
                });

                if (standalone) {
                    const allInputs = Array.from(document.querySelectorAll('input'));
                    return { formIndex: -1, fieldIndex: allInputs.indexOf(standalone), submitSelector: null };
                }

                return null;
            })();
        `);
    }

    // ── Ancillary Fields ───────────────────────────────────────────────────

    /**
     * Fill required <select> and <input type=checkbox> inside a form.
     * This runs DOM logic inside the page — no human simulation needed here
     * because real users often tab through these quickly.
     * @param {number} formIndex
     */
    async _fillAncillaryFields(formIndex) {
        if (formIndex < 0) return;

        await this._evaluate(`
            (function () {
                const form = document.forms[${formIndex}];
                if (!form) return;

                // Required selects: pick first non-empty option
                for (const sel of form.querySelectorAll('select[required], select')) {
                    if (sel.value) continue;
                    const opt = Array.from(sel.options).find(o => o.value.trim() !== '');
                    if (opt) {
                        sel.value = opt.value;
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }

                // Unchecked required checkboxes (e.g. "I agree to terms")
                for (const cb of form.querySelectorAll('input[type="checkbox"][required]')) {
                    if (!cb.checked) {
                        cb.checked = true;
                        cb.dispatchEvent(new Event('change', { bubbles: true }));
                        cb.dispatchEvent(new Event('input',  { bubbles: true }));
                    }
                }
            })();
        `);
    }

    // ── Human Simulation ───────────────────────────────────────────────────

    /**
     * Focus the email input by clicking it (CDP mouse events),
     * then type the email character-by-character with randomised delays.
     *
     * @param {number} fieldIndex  index in document.querySelectorAll('input')
     * @param {string} email
     * @returns {Promise<boolean>}
     */
    async _humanFill(fieldIndex, email) {
        // Get the field's bounding box from the page
        const rect = await this._evaluate(`
            (function () {
                const el = document.querySelectorAll('input')[${fieldIndex}];
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height };
            })();
        `);

        if (!rect) return false;

        // Click centre of the input with a tiny random offset
        const cx = rect.x + rect.w / 2 + this._jitter(-4, 4);
        const cy = rect.y + rect.h / 2 + this._jitter(-2, 2);

        await this._cdpMouseMove(cx, cy);
        await this._sleep(this._jitter(80, 200));
        await this._cdpClick(cx, cy);
        await this._sleep(this._jitter(150, 350));

        // Clear existing value (Ctrl+A, Delete)
        await this._mainSession.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 });
        await this._mainSession.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'a', modifiers: 2 });
        await this._mainSession.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete' });
        await this._mainSession.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Delete' });
        await this._sleep(this._jitter(50, 150));

        // Type each character with human-like delay
        for (const char of email) {
            await this._cdpTypeChar(char);
            await this._sleep(this._jitter(TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS));

            // Occasional extra pause (simulates hesitation ~5% of the time)
            if (Math.random() < 0.05) {
                await this._sleep(this._jitter(200, 500));
            }
        }

        // Fire input / change events so React / Vue / Angular pick up the value
        await this._evaluate(`
            (function () {
                const el = document.querySelectorAll('input')[${fieldIndex}];
                if (!el) return;
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeInputValueSetter.call(el, ${JSON.stringify(email)});
                el.dispatchEvent(new Event('input',  { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur',   { bubbles: true }));
            })();
        `);

        return true;
    }

    /**
     * Simulate a natural multi-step mouse movement towards a target.
     * @param {number} x
     * @param {number} y
     */
    async _cdpMouseMove(x, y) {
        // Start from a random nearby origin
        let curX = x + this._jitter(-80, 80);
        let curY = y + this._jitter(-60, 60);

        for (let i = 0; i < MOUSE_MOVE_STEPS; i++) {
            const t  = (i + 1) / MOUSE_MOVE_STEPS;
            const nx = curX + (x - curX) * t + this._jitter(-3, 3);
            const ny = curY + (y - curY) * t + this._jitter(-3, 3);

            await this._mainSession.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved', x: nx, y: ny, buttons: 0
            });
            await this._sleep(this._jitter(8, 25));
        }
    }

    /**
     * Dispatch a realistic mouse click (move → down → up).
     * @param {number} x
     * @param {number} y
     */
    async _cdpClick(x, y) {
        await this._mainSession.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1
        });
        await this._sleep(this._jitter(40, 120));
        await this._mainSession.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0
        });
    }

    /**
     * Type a single character using CDP Input events.
     * Handles printable ASCII; ignores others gracefully.
     * @param {string} char
     */
    async _cdpTypeChar(char) {
        const code = char.charCodeAt(0);

        // For printable characters, dispatchKeyEvent with insertText is most reliable
        await this._mainSession.send('Input.dispatchKeyEvent', {
            type        : 'keyDown',
            key         : char,
            text        : char,
            unmodifiedText: char,
            windowsVirtualKeyCode: code,
            nativeVirtualKeyCode : code
        });
        await this._mainSession.send('Input.insertText', { text: char });
        await this._mainSession.send('Input.dispatchKeyEvent', {
            type        : 'keyUp',
            key         : char,
            windowsVirtualKeyCode: code,
            nativeVirtualKeyCode : code
        });
    }

    /**
     * Wander the mouse over a random region before interacting.
     * Makes the session look less robotic.
     */
    async _randomMouseWander() {
        const points = Array.from({ length: 3 }, () => ({
            x: 200 + Math.random() * 800,
            y: 100 + Math.random() * 400
        }));

        for (const p of points) {
            await this._mainSession.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved', x: p.x, y: p.y, buttons: 0
            });
            await this._sleep(this._jitter(60, 180));
        }
    }

    // ── Form Submission ────────────────────────────────────────────────────

    /**
     * Click the submit button (or press Enter if none found).
     * @param {number}      formIndex
     * @param {string|null} submitSelector
     * @returns {Promise<boolean>}
     */
    async _submitForm(formIndex, submitSelector) {
        // Locate submit button rect
        const btnRect = await this._evaluate(`
            (function () {
                let btn = null;

                // 1. Try the provided selector inside the form
                if (${formIndex} >= 0 && ${JSON.stringify(submitSelector)}) {
                    const form = document.forms[${formIndex}];
                    if (form) btn = form.querySelector(${JSON.stringify(submitSelector)});
                }

                // 2. Any submit button in the form
                if (!btn && ${formIndex} >= 0) {
                    const form = document.forms[${formIndex}];
                    if (form) btn = form.querySelector('button[type="submit"], input[type="submit"], button:last-of-type');
                }

                // 3. Global fallback
                if (!btn) {
                    btn = document.querySelector('button[type="submit"], input[type="submit"]');
                }

                if (!btn) return null;
                const r = btn.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return null;
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            })();
        `);

        if (btnRect) {
            this._log(`[emailFill] Clicking submit at (${Math.round(btnRect.x)}, ${Math.round(btnRect.y)})`);
            await this._cdpMouseMove(btnRect.x, btnRect.y);
            await this._sleep(this._jitter(100, 250));
            await this._cdpClick(btnRect.x, btnRect.y);
            return true;
        }

        // Fallback: press Enter
        this._log('[emailFill] No submit button found — pressing Enter');
        await this._mainSession.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
        await this._sleep(50);
        await this._mainSession.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Enter', windowsVirtualKeyCode: 13 });
        return true;
    }

    // ── Captcha Detection ──────────────────────────────────────────────────

    /**
     * Check for known captcha widgets in the DOM.
     * @returns {Promise<boolean>}
     */
    async _hasCaptcha() {
        return await this._evaluate(`
            (function () {
                const selectors = ${JSON.stringify(CAPTCHA_SELECTORS)};
                return selectors.some(s => !!document.querySelector(s));
            })();
        `);
    }

    // ── CDP Helpers ────────────────────────────────────────────────────────

    /**
     * Evaluate a JS expression in the page context.
     * @param {string}  expression
     * @param {boolean} [awaitPromise=false]
     * @returns {Promise<any>}
     */
    async _evaluate(expression, awaitPromise = false) {
        try {
            const res = await this._mainSession.send('Runtime.evaluate', {
                expression,
                awaitPromise,
                returnByValue: true,
                userGesture  : true
            });

            if (res?.exceptionDetails) {
                this._log(`[emailFill] evaluate error: ${res.exceptionDetails.text}`);
                return undefined;
            }

            return res?.result?.value;
        } catch (err) {
            this._log(`[emailFill] CDP evaluate threw: ${err.message}`);
            return undefined;
        }
    }

    // ── Utility ────────────────────────────────────────────────────────────

    /**
     * Sleep for ms milliseconds.
     * @param {number} ms
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Return a random integer in [min, max].
     * @param {number} min
     * @param {number} max
     * @returns {number}
     */
    _jitter(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
}

module.exports = EmailFillCollector;