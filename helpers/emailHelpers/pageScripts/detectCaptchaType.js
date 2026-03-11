'use strict';

/**
 * @file pageScripts/detectCaptchaType.js
 *
 * Browser-context script.
 * Detects the presence and type of CAPTCHA widget(s) on the current page.
 *
 * Serialised and injected by CaptchaDetector.detectCaptchaType() via CDP Runtime.evaluate.
 *
 * ─── CAPTCHA type reference ──────────────────────────────────────────────────────────
 *   recaptcha_v2 — checkbox widget; clicking almost always triggers image challenge
 *   recaptcha_v3 — invisible/score-based; detected via script tag only
 *   hcaptcha     — always presents image challenge in headless contexts
 *   turnstile    — score-based (Cloudflare); challenge if score too low
 *   unknown      — [data-sitekey] present but vendor unrecognised
 *
 * @returns {'recaptcha_v2'|'recaptcha_v3'|'hcaptcha'|'turnstile'|'unknown'|null}
 */
function detectCaptchaType() {
    if (document.querySelector('iframe[src*="recaptcha/api2/anchor"]') ||
        document.querySelector('.g-recaptcha')) {
        return 'recaptcha_v2';
    }
    if (document.querySelector('script[src*="recaptcha/api.js?render="]')) {
        return 'recaptcha_v3';
    }
    if (document.querySelector('iframe[src*="hcaptcha.com"]') ||
        document.querySelector('.h-captcha')) {
        return 'hcaptcha';
    }
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
        document.querySelector('.cf-turnstile') ||
        document.querySelector('#cf-turnstile')) {
        return 'turnstile';
    }
    if (document.querySelector('[data-sitekey]')) {
        return 'unknown';
    }
    return null;
}

module.exports = detectCaptchaType;
