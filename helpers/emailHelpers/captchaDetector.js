'use strict';

/**
 * @file captchaDetector.js
 *
 * CaptchaDetector — detects the presence and type of CAPTCHA widgets on a page.
 *
 * Receives { evaluate } from the collector. No base class.
 *
 * ─── CAPTCHA type reference ──────────────────────────────────────────────────────────
 *   recaptcha_v2 — checkbox widget; clicking almost always triggers image challenge
 *   recaptcha_v3 — invisible/score-based; detected via script tag only
 *   hcaptcha     — always presents image challenge in headless contexts
 *   turnstile    — score-based (Cloudflare); challenge if score too low
 *   unknown      — [data-sitekey] present but vendor unrecognised
 *
 * Note: we detect and record but never bail. The caller decides how to proceed.
 */

class CaptchaDetector {

    /**
     * @param {{ evaluate: Function }} deps
     *   evaluate — bound _evaluate method from EmailFillCollector
     */
    constructor({ evaluate }) {
        this._evaluate = evaluate;
    }

    /**
     * Detect the presence and type of CAPTCHA widget(s) on the current page.
     *
     * @returns {Promise<string|null>}
     *   One of: 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile' | 'unknown' | null
     */
    async detectCaptchaType() {
        return await this._evaluate(`
            (function () {
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
            })();
        `);
    }

    /**
     * @returns {Promise<boolean>}
     * @deprecated Use detectCaptchaType() to get the type string.
     */
    async hasCaptcha() {
        return (await this.detectCaptchaType()) !== null;
    }
}

module.exports = CaptchaDetector;
