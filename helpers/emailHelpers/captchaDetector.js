'use strict';

/**
 * @file captchaDetector.js
 *
 * CaptchaDetector — detects the presence and type of CAPTCHA widgets on a page.
 *
 * Receives { evaluate } from the collector. No base class.
 * All DOM logic lives in pageScripts/detectCaptchaType.js.
 *
 * Note: we detect and record but never bail. The caller decides how to proceed.
 */

const detectCaptchaType = require('./pageScripts/detectCaptchaType');

class CaptchaDetector {

    /**
     * @param {{ evaluate: Function }} deps
     */
    constructor({ evaluate }) {
        this._evaluate = evaluate;
    }

    /**
     * Detect the presence and type of CAPTCHA widget(s) on the current page.
     *
     * @returns {Promise<'recaptcha_v2'|'recaptcha_v3'|'hcaptcha'|'turnstile'|'unknown'|null>}
     */
    async detectCaptchaType() {
        return this._evaluate(`(${detectCaptchaType.toString()})()`);
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