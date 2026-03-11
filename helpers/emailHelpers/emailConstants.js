'use strict';

/**
 * @file constants.js
 *
 * Shared constants, configuration values, and JSDoc type definitions for the
 * emailFill collector family.
 *
 * All values are module-level constants — no classes, no state.
 * Import this file in any helper that needs keywords, selectors, timing, or identity data.
 *
 * ─── Contents ───────────────────────────────────────────────────────────────────────
 *   1. Keyword lists      — newsletter signals, submit-button text patterns
 *   2. Selector lists     — CAPTCHA widget selectors
 *   3. Timing constants   — delays, step counts, link caps
 *   4. JSDoc typedefs     — EmailFillResult, FormRecord, FieldRecord
 *
 * Identity data lives in helpers/emailHelpers/identities/*.json
 * and is loaded at runtime by helpers/emailHelpers/loadIdentity.js.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */


// ═══════════════════════════════════════════════════════════════════════════════════════
// 1. KEYWORD LISTS
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * Keywords used to identify newsletter / subscription links and forms.
 * Matched against href, text content, title, and aria-label of anchor elements,
 * and against the id, class, action, and text content of form elements.
 * @type {string[]}
 */
const NEWSLETTER_KEYWORDS = [
    'newsletter', 'subscribe', 'signup', 'sign-up', 'sign_up',
    'join', 'updates', 'mailing', 'email-list', 'notify', 'alerts'
];

/**
 * Regex patterns for submit button labels that suggest a newsletter form.
 * Used by formDetector to score forms and identify the correct submit button.
 * Stored as RegExp objects; serialised to source strings when injected into page context.
 * @type {RegExp[]}
 */
const SUBMIT_TEXT_PATTERNS = [
    /^subscribe$/i,
    /^sign\s*up$/i,
    /^join$/i,
    /^submit$/i,
    /^get\s+updates$/i,
    /^notify\s+me$/i,
    /^keep\s+me\s+posted$/i,
    /^stay\s+informed$/i,
    /^get\s+started$/i,
    /^send$/i
];


// ═══════════════════════════════════════════════════════════════════════════════════════
// 2. SELECTOR LISTS
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * CSS selectors that identify known CAPTCHA widgets.
 * Covers reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, and generic data-sitekey.
 *
 * Extension notes:
 *   • reCAPTCHA v3 has no visible widget; detected separately via
 *     script[src*="recaptcha/api.js?render="] in captchaDetector.js.
 *   • Image CAPTCHAs (img[src*="captcha"]) are not listed — too many false positives.
 *   • Text CAPTCHAs (input[name*="captcha" i]) are handled in captchaDetector.js
 *     separately to avoid collision with honeypot detection.
 * @type {string[]}
 */
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


// ═══════════════════════════════════════════════════════════════════════════════════════
// 3. TIMING CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Maximum newsletter-related links to follow per page before giving up. */
const MAX_CANDIDATE_LINKS  = 10;

/** Milliseconds to wait after navigating to a candidate link (SPA hydration time). */
const POST_NAVIGATE_DELAY  = 4500;

/** Milliseconds to wait after form submission before evaluating the outcome. */
const POST_SUBMIT_DELAY    = 3000;

/** Minimum inter-keystroke delay (ms) when typing human-like text. */
const TYPING_DELAY_MIN_MS  = 60;

/** Maximum inter-keystroke delay (ms) when typing human-like text. */
const TYPING_DELAY_MAX_MS  = 180;

/** Number of intermediate waypoints in a simulated mouse movement path. */
const MOUSE_MOVE_STEPS     = 8;

/** Milliseconds to wait after cookiePopupsCollector actions a popup before scanning for forms. */
const POST_POPUP_SETTLE_MS = 1500;


// ═══════════════════════════════════════════════════════════════════════════════════════
// 5. JSDOC TYPEDEFS
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} FieldRecord
 * A single form field detected during page analysis.
 *
 * @property {string}  name         - Best available identifier: name → id → placeholder
 * @property {string}  type         - The input's type attribute ("email", "text", "checkbox", …)
 * @property {boolean} filled       - Whether this collector wrote a value into this field
 * @property {boolean} required     - True if the field has [required] or aria-required="true"
 * @property {string}  [filledWith] - The value placed in the field (omitted for checkboxes)
 */

/**
 * @typedef {Object} FormRecord
 * Full record for a single form found on the page (whether or not it was attempted).
 *
 * @property {number}        formIndex       - Index in document.forms; -1 for standalone inputs
 * @property {string}        domLocation     - Coarse location hint: "header"|"footer"|"modal"|"inline"
 * @property {number}        score           - Heuristic newsletter-likelihood score from formDetector
 * @property {FieldRecord[]} fields          - All fields detected within this form
 * @property {boolean}       attempted       - Whether a fill+submit was attempted on this form
 * @property {string}        outcome         - One of: "success" | "failure" | "captcha_blocked" |
 *                                             "captcha_challenge" | "silent_failure" |
 *                                             "double_opt_in" | "not_attempted" | "error"
 * @property {boolean}       captchaDetected - Whether a CAPTCHA widget was present in/near the form
 * @property {string}        [captchaType]   - "recaptcha_v2"|"recaptcha_v3"|"hcaptcha"|
 *                                             "turnstile"|"image"|"text"|"unknown"
 * @property {string[]}      errorMessages   - Validation or server error strings captured from DOM
 * @property {string[]}      consentChecked  - Labels of consent checkboxes that were checked
 */

/**
 * @typedef {Object} EmailFillResult
 * Top-level result object returned by EmailFillCollector.getData().
 * Written to the per-URL JSON file alongside HAR data.
 *
 * Aggregate flags — fast-filter friendly for downstream analysis:
 * @property {boolean}      hasNewsletter       - At least one newsletter form was found
 * @property {boolean}      submissionSucceeded - At least one form submission appeared to succeed
 * @property {boolean}      captchaBlocked      - All forms were blocked by CAPTCHA detection
 * @property {boolean}      doubleOptIn         - Submission succeeded but requires email confirmation
 *
 * Interaction metadata:
 * @property {string[]}     visitedLinks        - URLs navigated to during this crawl job
 * @property {string|null}  formUrl             - URL where the successful/attempted form was found
 * @property {FormRecord[]} forms               - All forms found, whether attempted or not
 *
 * Legacy fields — kept for backwards compatibility with existing downstream consumers:
 * @property {boolean}      filled              - Alias for submissionSucceeded
 * @property {boolean}      captchaPresent      - True if any CAPTCHA was seen (= captchaBlocked)
 *
 * Error state:
 * @property {string|null}  error               - Unhandled exception message, or null
 */


module.exports = {
    NEWSLETTER_KEYWORDS,
    SUBMIT_TEXT_PATTERNS,
    CAPTCHA_SELECTORS,
    MAX_CANDIDATE_LINKS,
    POST_NAVIGATE_DELAY,
    POST_SUBMIT_DELAY,
    TYPING_DELAY_MIN_MS,
    TYPING_DELAY_MAX_MS,
    MOUSE_MOVE_STEPS,
    POST_POPUP_SETTLE_MS
};
