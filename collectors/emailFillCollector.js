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
 *   • The BaseCollector lifecycle  (id / init / addTarget / postLoad / interact / getData)
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
 * rather than inheriting from a shared base class.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * BASECOLLECTER LIFECYCLE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 *   id()         → returns the string key used in per-URL JSON output
 *   init()       → called once per URL; initialise state, load identity, subscribe
 *                  to POPUP_ACCEPTED on the event bus
 *   addTarget()  → called per CDP session; capture the main page session + iframes
 *   postLoad()   → called after navigation + network-idle; lightweight snapshot only,
 *                  no form interaction
 *   interact()   → called after extraExecutionTimeMs pause, AFTER all other interact()
 *                  calls (including cookiePopupsCollector) have completed;
 *                  all form interaction runs here
 *   getData()    → returns the result object written to the per-URL JSON file
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * CONSENT WALL HANDLING
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Consent wall dismissal is fully owned by cookiePopupsCollector, which runs its
 * interact() phase before this collector. EmailFillCollector no longer injects CMP
 * cookies/localStorage flags and no longer clicks any consent buttons.
 *
 * The POPUP_ACCEPTED bus event is recorded in _result.popupInfo for diagnostics.
 * interact() waits an additional POST_POPUP_SETTLE_MS after a popup was actioned to
 * let the page re-render before scanning for forms.
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
 * IFRAME FORM HANDLING
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Some newsletter forms are embedded in cross-origin iframes. addTarget() collects
 * every non-noise iframe CDPSession keyed by URL. If the main frame yields no form,
 * _attemptFill() probes each stored iframe session in turn.
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
    POPUP_ACCEPTED,
    SCREENSHOT_REQUESTED,
    SCREENSHOT_TAKEN,
    SCREENSHOT_ERR,
} = require('../helpers/collectorEvents');

const {
    MAX_CANDIDATE_LINKS,
    POST_NAVIGATE_DELAY,
    POST_SUBMIT_DELAY,
    POST_POPUP_SETTLE_MS,
} = require('../helpers/emailHelpers/constants');

// ── Chalk styles ──────────────────────────────────────────────────────────────
const C = {
    bold  : chalk.cyan.bold,
    plain : chalk.cyan,
    dim   : chalk.cyan.dim,
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
     * @param {{ browserConnection: object, url: URL, log: Function, bus: import('events').EventEmitter, testStarted: number }} options
     */
    init(options) {
        const { browserConnection, url, log, bus, testStarted } = options;

        this._browserConnection = browserConnection;
        this._url               = url;
        this._rawLog            = log;
        this._bus               = bus;
        this._testStarted       = testStarted;

        const identity = loadIdentity();
        this._email    = identity.email;

        /** @type {object|null} */
        this._mainSession = null;

        /**
         * Non-noise iframe sessions collected by addTarget(), keyed by iframe URL.
         * Probed in _attemptFill() when the main frame contains no email form.
         * @type {Map<string, object>}
         */
        this._iframeSessions = new Map();

        /**
         * Payload from the POPUP_ACCEPTED event, if cookiePopupsCollector fired one.
         * @type {{ cmp: string, action: string, timestamp: number, relativeMs: number }|null}
         */
        this._popupAcceptedPayload = null;

        if (bus) {
            bus.on(POPUP_ACCEPTED, payload => {
                this._popupAcceptedPayload = payload;
                this._log(
                    C.plain('POPUP_ACCEPTED received:'),
                    C.dim(`cmp=${payload?.cmp}  action=${payload?.action}  +${payload?.relativeMs}ms`)
                );
            });
        }

        this._result = {
            hasNewsletter            : false,
            submissionSucceeded      : false,
            captchaBlocked           : false,
            doubleOptIn              : false,
            visitedLinks             : [],
            formUrl                  : null,
            forms                    : [],
            filled                   : false,
            captchaPresent           : false,
            popupInfo                : null,
            popupActionedAt          : null,
            popupActionedAtRelativeMs: null,
            error                    : null,
        };
    }

    /**
     * Capture the main page CDPSession and all non-noise iframe sessions.
     *
     * @param {object} session
     * @param {{ type: string, url?: string }} targetInfo
     */
    async addTarget(session, targetInfo) {
        if (targetInfo.type === 'page' && !this._mainSession) {
            this._mainSession = session;
            await session.send('Input.enable').catch(() => {});
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
     * Called after networkIdle. Lightweight — all interaction happens in interact().
     */
    async postLoad() {
        this._log(C.dim('postLoad — waiting for interact() phase'));
    }

    /**
     * Main entry point — runs after extraExecutionTimeMs pause, sequentially after
     * cookiePopupsCollector.interact() has already completed.
     */
    async interact() {
        if (!this._mainSession) return;

        try {
            this._log(
                C.bold('── interact() starting ──'),
                `identity: ${C.plain(this._email)}  url: ${C.dim(this._url.href)}`
            );

            // ── Post-popup settle ────────────────────────────────────────────────────
            if (this._popupAcceptedPayload) {
                this._result.popupInfo = this._popupAcceptedPayload;
                this._log(
                    C.plain(`Popup was actioned (${this._popupAcceptedPayload.cmp}) — settling ${POST_POPUP_SETTLE_MS}ms before form scan…`)
                );
                await this._sleep(POST_POPUP_SETTLE_MS);
            } else {
                this._log(C.dim('No popup actioned — proceeding directly to form scan'));
            }

            // ── Form fill attempt ────────────────────────────────────────────────────
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
            this._log(C.plain('Unhandled error in interact():'), C.dim(err.message));
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
     * there, probes each stored iframe session in turn.
     *
     *   Step 1 — CAPTCHA check    detect type, record, continue regardless
     *   Step 2 — Form detection   main frame first, then iframe probe if needed
     *   Step 3 — Ancillary fields selects, checkboxes, name/phone/zip
     *   Step 4 — Email field      human-like typing via CDP events
     *   Step 5 — Submit           scroll into view, click or Enter fallback
     *   Step 6 — Wait             POST_SUBMIT_DELAY ms for page response
     *   Step 7 — Screenshot       emits SCREENSHOT_REQUESTED, waits for result
     *
     * @param {object} session - Starting CDPSession
     * @returns {Promise<boolean>}
     */
    async _attemptFill(session) {

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

        // ── Step 7: Screenshot ───────────────────────────────────────────────────────
        await new Promise(resolve => {
            const onDone = () => {
                this._bus.off(SCREENSHOT_TAKEN, onDone);
                this._bus.off(SCREENSHOT_ERR,   onDone);
                resolve();
            };
            this._bus.once(SCREENSHOT_TAKEN, onDone);
            this._bus.once(SCREENSHOT_ERR,   onDone);
            this._bus.emit(SCREENSHOT_REQUESTED, 'form_submitted');
        });
        this._log(C.dim('Screenshot taken after form submission'));

        // ── Timestamps ───────────────────────────────────────────────────────────────
        const submittedAt = Date.now();
        this._result.popupActionedAt           = submittedAt;
        this._result.popupActionedAtRelativeMs = submittedAt - this._testStarted;

        return true;
    }


    // ═══════════════════════════════════════════════════════════════════════════════════
    // 3. CDP SESSION
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
     *
     * @param {string}  expression
     * @param {boolean} [awaitPromise=false]
     */
    async _evaluate(expression, awaitPromise = false) {
        return this._evaluateIn(this._mainSession, expression, awaitPromise);
    }


    // ═══════════════════════════════════════════════════════════════════════════════════
    // 4. UTILITIES
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