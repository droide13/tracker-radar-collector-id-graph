'use strict';

/**
 * @file emailFillCollector.js
 *
 * EmailFillCollector — BaseCollector orchestrator for the emailFill collector family.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * ROLE OF THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * This class owns:
 *   • The BaseCollector lifecycle  (id / init / addTarget / postLoad / getData)
 *   • The CDPSession               (_mainSession, _evaluate)
 *   • Timing utilities             (_sleep, _jitter)
 *   • All chalk logging            (_log — single cyan colour, three weights)
 *   • The top-level attempt loop   (_attemptFill)
 *   • The result object            (EmailFillResult)
 *
 * Domain logic is delegated to helper classes under ../helpers/emailHelpers/:
 *
 *   CaptchaDetector  detectCaptchaType()      — CAPTCHA presence and type
 *   FormDetector     findCandidateLinks()      — newsletter link discovery
 *                    locateEmailForm()         — form scoring and email field location
 *   FieldFiller      humanFill()              — email typing with CDP events
 *                    fillAncillaryFields()    — selects, checkboxes, name/phone/zip
 *   FormSubmitter    submitForm()             — submit button click or Enter fallback
 *
 * Helpers receive a plain deps object { session, evaluate, sleep, jitter }
 * rather than inheriting from a shared base class. cdpHelper.js is no longer used.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * BASECOLLECTER LIFECYCLE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 *   id()         → returns the string key used in per-URL JSON output
 *   init()       → called once per URL; initialise state, load identity
 *   addTarget()  → called per CDP session; capture the main page session
 *   postLoad()   → called after navigation + network-idle + collectorExtraTimeMs;
 *                  all form interaction runs here
 *   getData()    → returns the result object written to the per-URL JSON file
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * PARALLELISM CONSTRAINTS
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Other collectors (har, cookiepopups, …) run concurrently. We must:
 *   • Not monkey-patch the Page object or any shared crawler state
 *   • Not intercept network events (the HAR collector owns those)
 *   • Wrap every external call in try/catch to avoid crashing the crawler
 *   • Not navigate away without recording the current URL first
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * CAPTCHA BEHAVIOUR
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * We detect, record, and continue — we never bail on a CAPTCHA.
 *   • Score-based (reCAPTCHA v3, Turnstile): run invisibly; form may still accept the
 *     submission with a low score and simply not confirm.
 *   • Checkbox (reCAPTCHA v2, hCaptcha): will block server-side. We still attempt and
 *     record so the HAR collector captures whatever response the server returns.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * CONSENT WALL HANDLING  (work in progress)
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Goal: ignore consent walls entirely — never genuinely accept, just suppress them
 * so the newsletter form underneath becomes reachable.
 *
 * Two layers:
 *
 *   1. Pre-render injection (_preAcceptConsent) — fires in addTarget() before the
 *      first paint. Sets well-known CMP cookies (OneTrust, Didomi, Cookiebot, generic)
 *      and localStorage flags via Page.addScriptToEvaluateOnNewDocument. Prevents most
 *      walls from mounting at all.
 *
 *   2. Runtime click fallback (_dismissCookieBanner) — fires as Step 0 of every
 *      _attemptFill(). Handles walls backed by server-side consent verification that
 *      survived the injection. Only clicks buttons whose text unambiguously signals
 *      "accept all" (multilingual regex) — deliberately skips "Continue", "Next",
 *      and any button that could belong to a paywall or registration flow.
 *
 * Known limitation: sites that verify consent server-side and re-render the wall
 * after each navigation may still block access intermittently.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * IFRAME FORM HANDLING  (work in progress)
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Some newsletter forms are embedded in cross-origin iframes (e.g. plus.elpais.com
 * served inside elpais.com). Runtime.evaluate in the main frame cannot see their DOM,
 * so form detection returns nothing and the wrong button gets clicked.
 *
 * addTarget() collects every non-noise iframe CDPSession keyed by URL. If the main
 * frame yields no form, _attemptFill() probes each stored iframe session in turn.
 * Whichever session owns the form is used for all subsequent steps (field filling,
 * submit). CDP mouse events are still dispatched through Input.dispatchMouseEvent
 * which operates in viewport coordinates regardless of which session is active.
 *
 * Known limitation: deeply nested iframes (iframe inside iframe) are not probed.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * RESULT SCHEMA  →  see ../helpers/emailHelpers/constants.js for full JSDoc typedef
 * ═══════════════════════════════════════════════════════════════════════════════════════
 */

const BaseCollector   = require('./BaseCollector');
const chalk           = require('chalk');
const CaptchaDetector = require('../helpers/emailHelpers/captchaDetector');
const FormDetector    = require('../helpers/emailHelpers/formDetector');
const FieldFiller     = require('../helpers/emailHelpers/fieldFiller');
const FormSubmitter   = require('../helpers/emailHelpers/formSubmitter');
const loadIdentity    = require('../helpers/emailHelpers/loadIdentity');

const {
    MAX_CANDIDATE_LINKS,
    POST_NAVIGATE_DELAY,
    POST_SUBMIT_DELAY
} = require('../helpers/emailHelpers/constants');

// ── Chalk styles ─────────────────────────────────────────────────────────────────────
// Single colour: cyan. Three weights only.
const C = {
    bold  : chalk.cyan.bold,
    plain : chalk.cyan,
    dim   : chalk.cyan.dim
};

// Third-party iframe origins that will never contain a newsletter form.
// Sessions matching any of these strings are discarded in addTarget().
const IFRAME_NOISE = [
    'google.com/recaptcha',
    'recaptcha.net',
    'hcaptcha.com',
    'challenges.cloudflare.com',
    'doubleclick.net',
    'googletagmanager.com',
    'google-analytics.com',
    'facebook.com/plugins',
    'youtube.com/embed',
];


class EmailFillCollector extends BaseCollector {

    /**
     * Extra milliseconds to wait after page load before starting form interaction.
     * @type {number}
     */
    collectorExtraTimeMs = 5000;


    // ═══════════════════════════════════════════════════════════════════════════════════
    // 1. LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════════════════

    id() { return 'emailFill'; }

    /**
     * @param {{ browserConnection: object, url: URL, log: Function }} options
     */
    init(options) {
        const { browserConnection, url, log } = options;

        this._browserConnection = browserConnection;
        this._url               = url;
        this._rawLog            = log;

        const identity   = loadIdentity();
        this._email      = identity.email;

        /** @type {object|null} */
        this._mainSession = null;

        /**
         * Non-noise iframe sessions collected by addTarget(), keyed by iframe URL.
         * Probed in _attemptFill() when the main frame contains no email form.
         * @type {Map<string, object>}
         */
        this._iframeSessions = new Map();

        this._result = {
            hasNewsletter      : false,
            submissionSucceeded: false,
            captchaBlocked     : false,
            doubleOptIn        : false,
            visitedLinks       : [],
            formUrl            : null,
            forms              : [],
            filled             : false,
            captchaPresent     : false,
            error              : null
        };
    }

    /**
     * Capture the main page CDPSession and all non-noise iframe sessions.
     *
     * Main page:
     *   - Enables the Input domain.
     *   - Calls _preAcceptConsent() to inject CMP cookies and localStorage flags
     *     before the page renders, preventing most consent walls from mounting.
     *
     * Iframes:
     *   - Stored in _iframeSessions for later probing if the main frame has no form.
     *   - Known third-party noise (reCAPTCHA, analytics, ads) is filtered out.
     *
     * @param {object} session
     * @param {{ type: string, url?: string }} targetInfo
     */
    async addTarget(session, targetInfo) {
        if (targetInfo.type === 'page' && !this._mainSession) {
            this._mainSession = session;
            await session.send('Input.enable').catch(() => {});
            await this._preAcceptConsent(session).catch(() => {});
            return;
        }

        if (targetInfo.type === 'iframe') {
            const url = targetInfo.url || '';
            if (IFRAME_NOISE.some(n => url.includes(n))) return;
            this._iframeSessions.set(url, session);
            this._log(C.dim(`iframe session stored: ${url}`));
        }
    }

    /**
     * Main entry point — runs after page load + network-idle + collectorExtraTimeMs.
     */
    async postLoad() {
        if (!this._mainSession) return;

        try {
            this._log(C.bold('── starting ──'), `identity: ${C.plain(this._email)}  url: ${C.dim(this._url.href)}`);

            let success = await this._attemptFill(this._mainSession);

            if (!success) {
                this._log(C.plain('No form filled on landing page — scanning for candidate links…'));

                const mainDeps     = this._buildDeps(this._mainSession);
                const mainDetector = new FormDetector(mainDeps);
                const links        = await mainDetector.findCandidateLinks();
                this._log(C.plain(`Found ${links.length} candidate link(s)`));

                for (const link of links.slice(0, MAX_CANDIDATE_LINKS)) {
                    this._result.visitedLinks.push(link);
                    this._log(C.plain('Navigating →'), C.dim(link));

                    await this._mainSession.send('Page.navigate', { url: link });
                    await this._sleep(POST_NAVIGATE_DELAY);
                    this._log(C.dim(`Settled after ${POST_NAVIGATE_DELAY}ms`));

                    success = await this._attemptFill(this._mainSession);
                    if (success) break;
                }
            }

            this._result.filled              = success;
            this._result.submissionSucceeded = success;

            if (success) {
                const vl = this._result.visitedLinks;
                this._result.formUrl = (vl.length > 0 ? vl[vl.length - 1] : null) || this._url.href;
                this._log(C.bold('── complete ──'), `formUrl: ${C.dim(this._result.formUrl)}`);
            } else {
                this._log(C.plain('No form successfully submitted for this URL'));
            }

        } catch (err) {
            this._log(C.plain('Unhandled error in postLoad:'), C.dim(err.message));
            this._result.error = err.message;
        }
    }

    async getData() {
        return this._result;
    }


    // ═══════════════════════════════════════════════════════════════════════════════════
    // 2. ATTEMPT FILL
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Build a deps bundle scoped to a specific CDPSession.
     * All evaluate calls in helpers will run in that session's frame context.
     *
     * @param {object} session
     * @returns {{ session, evaluate, sleep, jitter }}
     */
    _buildDeps(session) {
        return {
            session,
            evaluate : (expr, awaitPromise = false) => this._evaluateIn(session, expr, awaitPromise),
            sleep    : this._sleep.bind(this),
            jitter   : this._jitter.bind(this),
        };
    }

    /**
     * Orchestrate one form-fill attempt.
     *
     * Starts with the provided session (usually main frame). If no form is found
     * there, probes each stored iframe session in turn — this handles newsletter
     * forms embedded in cross-origin iframes whose DOM is invisible to the main frame.
     *
     *   Step 0 — Consent overlay  click-dismiss if still present after pre-injection
     *   Step 1 — CAPTCHA check    detect type, record, continue regardless
     *   Step 2 — Form detection   main frame first, then iframe probe if needed
     *   Step 3 — Ancillary fields selects, checkboxes, name/phone/zip
     *   Step 4 — Email field      human-like typing via CDP events
     *   Step 5 — Submit           scroll into view, click or Enter fallback
     *   Step 6 — Wait             POST_SUBMIT_DELAY ms for page response
     *
     * @param {object} session - Starting CDPSession
     * @returns {Promise<boolean>}
     */
    async _attemptFill(session) {

        // ── Step 0: Consent overlay fallback ─────────────────────────────────────────
        // Pre-injection in addTarget() suppresses most walls before render.
        // This handles the remainder — server-side verified CMPs that still mounted.
        // We click "accept all" purely to clear the overlay, not as genuine consent.
        const dismissed = await this._dismissCookieBanner(session);
        if (dismissed) {
            this._log(C.plain('Consent overlay dismissed (click fallback) — settling 1500ms…'));
            await this._sleep(1500);
        } else {
            this._log(C.dim('No consent overlay detected'));
        }

        // ── Step 1: CAPTCHA ──────────────────────────────────────────────────────────
        const captchaType = await new CaptchaDetector(this._buildDeps(session)).detectCaptchaType();
        if (captchaType) {
            this._log(C.plain('CAPTCHA detected:'), C.bold(captchaType), C.dim('— continuing fill attempt'));
            this._result.captchaPresent = true;
        } else {
            this._log(C.dim('No CAPTCHA detected'));
        }

        // ── Step 2: Form detection — main frame, then iframe probe ───────────────────
        let activeSession = session;
        let formInfo      = await new FormDetector(this._buildDeps(session)).locateEmailForm();

        if (!formInfo && this._iframeSessions.size > 0) {
            this._log(C.plain(`No form in main frame — probing ${this._iframeSessions.size} iframe session(s)…`));
            for (const [iframeUrl, iframeSession] of this._iframeSessions) {
                this._log(C.dim(`Probing iframe: ${iframeUrl}`));
                formInfo = await new FormDetector(this._buildDeps(iframeSession)).locateEmailForm();
                if (formInfo) {
                    this._log(C.plain('Form found in iframe:'), C.dim(iframeUrl));
                    activeSession = iframeSession;
                    break;
                }
            }
        }

        if (!formInfo) {
            this._log(C.plain('No newsletter email form found on this page'));
            return false;
        }

        this._result.hasNewsletter = true;
        this._log(
            C.plain('Form located —'),
            C.dim(`formIndex:${formInfo.formIndex}  fieldIndex:${formInfo.fieldIndex}  submit:${formInfo.submitSelector || 'Enter'}  frame:${activeSession === session ? 'main' : 'iframe'}`)
        );

        // All subsequent steps use the session that owns the form
        const activeDeps    = this._buildDeps(activeSession);
        const fieldFiller   = new FieldFiller(activeDeps);
        const formSubmitter = new FormSubmitter(activeDeps);

        // ── Step 3: Ancillary fields ─────────────────────────────────────────────────
        this._log(C.dim('Filling ancillary fields…'));
        await fieldFiller.fillAncillaryFields(formInfo.formIndex);

        // ── Step 4: Email field ──────────────────────────────────────────────────────
        this._log(C.plain('Typing email address…'), C.dim(`(${this._email.length} chars)`));
        const typed = await fieldFiller.humanFill(formInfo.fieldIndex, this._email);
        if (!typed) {
            this._log(C.plain('Could not focus or type into email field — aborting'));
            return false;
        }
        this._log(C.plain('Email typed:'), C.dim(this._email));

        // ── Pre-submit pause ─────────────────────────────────────────────────────────
        const pauseMs = this._jitter(600, 1200);
        this._log(C.dim(`Pre-submit pause: ${pauseMs}ms`));
        await this._sleep(pauseMs);

        // ── Step 5: Submit ───────────────────────────────────────────────────────────
        this._log(C.plain('Submitting form…'));
        const submitResult = await formSubmitter.submitForm(
            formInfo.formIndex,
            formInfo.submitSelector
        );

        this._log(C.dim('Submit diagnosis:'), C.dim('\n          ' + submitResult.diagnosis));

        if (!submitResult.dispatched) return false;

        if (submitResult.method === 'click') {
            this._log(
                C.plain('Submit button clicked:'),
                C.dim(`"${submitResult.btnText}"  at (${Math.round(submitResult.btnRect.x)}, ${Math.round(submitResult.btnRect.y)})`)
            );
        } else {
            this._log(C.plain('Submit dispatched via Enter key fallback'));
        }

        // ── Step 6: Wait ─────────────────────────────────────────────────────────────
        this._log(C.dim(`Waiting ${POST_SUBMIT_DELAY}ms for page response…`));
        await this._sleep(POST_SUBMIT_DELAY);
        this._log(C.plain('Submission dispatched — response captured by HAR collector'));

        return true;
    }


    // ═══════════════════════════════════════════════════════════════════════════════════
    // 3. CONSENT WALL HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Inject CMP cookies and localStorage flags before the page renders.
     * Fires on the main page session in addTarget(), before the first paint.
     *
     * This is not genuine consent — it is noise suppression. The injected values
     * match what well-known CMPs (OneTrust, Didomi, Cookiebot, generic) look for
     * to decide whether to show the consent wall.
     *
     * @param {object} session
     */
    async _preAcceptConsent(session) {
        const domain = this._url?.hostname ?? '';

        await session.send('Storage.setCookies', {
            cookies: [
                // OneTrust
                { name: 'OptanonAlertBoxClosed', value: new Date().toISOString(), domain, path: '/' },
                { name: 'OptanonConsent',        value: 'isGpcEnabled=0&datestamp=' + encodeURIComponent(new Date().toISOString()) + '&version=6.33.0&isIABGlobal=false&hosts=&consentId=fake&interactionCount=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1&geolocation=%3B&AwaitingReconsent=false', domain, path: '/' },
                // Didomi
                { name: 'didomi_token',          value: 'eyJ1c2VyX2lkIjoiZmFrZSIsImNyZWF0ZWQiOiIyMDI0LTAxLTAxVDAwOjAwOjAwWiIsInVwZGF0ZWQiOiIyMDI0LTAxLTAxVDAwOjAwOjAwWiIsInZlbmRvcnMiOnsiZW5hYmxlZCI6W119LCJwdXJwb3NlcyI6eyJlbmFibGVkIjpbXX19', domain, path: '/' },
                { name: 'euconsent-v2',          value: 'CPfake', domain, path: '/' },
                // Cookiebot
                { name: 'CookieConsent',         value: '{stamp:%27fake%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1}', domain, path: '/' },
                // Generic
                { name: 'cookie_consent',        value: '1',    domain, path: '/' },
                { name: 'gdpr_consent',          value: 'true', domain, path: '/' },
                { name: 'consent_accepted',      value: '1',    domain, path: '/' },
            ]
        }).catch(() => {});

        await session.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `
                try {
                    localStorage.setItem('OptanonAlertBoxClosed', new Date().toISOString());
                    localStorage.setItem('didomi-consent-present', 'true');
                    localStorage.setItem('didomi_token',           'fake_accepted');
                    localStorage.setItem('cookie_consent',         '1');
                    localStorage.setItem('gdpr',                   'accepted');
                    localStorage.setItem('consent',                'true');
                    localStorage.setItem('cookiesAccepted',        'true');
                } catch (_) {}
            `
        }).catch(() => {});
    }

    /**
     * Click-dismiss a consent overlay that survived pre-acceptance.
     *
     * Tries known CMP selectors first, then falls back to any visible button
     * whose text exactly matches a multilingual "accept all" pattern.
     *
     * Deliberately conservative: "Continuar", "Continue", "Next", "Siguiente"
     * and similar are NOT matched, so paywall and registration buttons are safe.
     *
     * @param {object} session
     * @returns {Promise<boolean>}
     */
    async _dismissCookieBanner(session) {
        return await this._evaluateIn(session, `
            (function () {
                const SELECTORS = [
                    '#onetrust-accept-btn-handler',
                    '#didomi-notice-agree-button',
                    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
                    '.qc-cmp2-summary-buttons button:last-of-type',
                    '#borlabs-cookie-btn-accept-all',
                    '[aria-label*="Accept"]',
                    '[aria-label*="Aceptar"]',
                    '[aria-label*="Agree"]',
                    '[aria-label*="Allow"]',
                    'button'
                ];

                const ACCEPT_RE = /^(accept all|aceptar todo|agree|allow all|accepter tout|alle akzeptieren|accetta tutto|aceitar tudo)(\\s|$)/i;

                for (const sel of SELECTORS) {
                    let candidates;
                    try { candidates = Array.from(document.querySelectorAll(sel)); }
                    catch (_) { continue; }

                    for (const el of candidates) {
                        const text    = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
                        const r       = el.getBoundingClientRect();
                        const visible = r.width > 0 && r.height > 0;

                        if (sel === 'button' && !ACCEPT_RE.test(text)) continue;
                        if (!visible) continue;

                        el.click();
                        return true;
                    }
                }
                return false;
            })();
        `);
    }


    // ═══════════════════════════════════════════════════════════════════════════════════
    // 4. CDP SESSION
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Evaluate a JS expression in a specific CDPSession.
     * Returns undefined on any error so failures never crash the crawler.
     *
     * @param {object}  session
     * @param {string}  expression
     * @param {boolean} [awaitPromise=false]
     * @returns {Promise<any>}
     */
    async _evaluateIn(session, expression, awaitPromise = false) {
        try {
            const res = await session.send('Runtime.evaluate', {
                expression,
                awaitPromise,
                returnByValue: true,
                userGesture  : true
            });

            if (res?.exceptionDetails) {
                this._log(C.dim(`evaluate exception: ${res.exceptionDetails.text}`));
                return undefined;
            }

            return res?.result?.value;

        } catch (err) {
            this._log(C.dim(`CDP evaluate threw: ${err.message}`));
            return undefined;
        }
    }

    /**
     * Evaluate in the main session.
     * Kept for backward compatibility — helpers injected via _buildDeps use
     * _evaluateIn scoped to their own session.
     *
     * @param {string}  expression
     * @param {boolean} [awaitPromise=false]
     */
    async _evaluate(expression, awaitPromise = false) {
        return this._evaluateIn(this._mainSession, expression, awaitPromise);
    }


    // ═══════════════════════════════════════════════════════════════════════════════════
    // 5. UTILITIES
    // ═══════════════════════════════════════════════════════════════════════════════════

    _log(...parts) {
        this._rawLog(`${C.bold('[emailFill]')} ${parts.join(' ')}`);
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _jitter(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
}

module.exports = EmailFillCollector;