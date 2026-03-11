'use strict';

/**
 * @file pageScripts/triggerRecaptchaCallback.js
 *
 * Browser-context script.
 * Attempts to manually trigger the reCAPTCHA callback bound to the submit button
 * so that invisible v2/v3 widgets generate a token before the form POST.
 *
 * Without this, a raw CDP mouse click bypasses the widget's click handler entirely
 * and the server receives no reCAPTCHA token, causing silent rejection.
 *
 * Returns true if a callback or grecaptcha.execute() was successfully invoked.
 *
 * Serialised and injected by FormSubmitter.submitForm() via CDP Runtime.evaluate.
 *
 * @returns {boolean}
 */
function triggerRecaptchaCallback() {
    const btn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (!btn) return false;

    const widget = document.querySelector(
        '.g-recaptcha[data-bind="'  + btn.id + '"], ' +
        '.g-recaptcha[data-bind="#' + btn.id + '"]'
    );
    if (!widget) return false;

    const cb = widget.getAttribute('data-callback');
    if (cb && typeof window[cb] === 'function') {
        try { window[cb]('recaptcha-bypass-attempt'); return true; } catch (_) {}
    }

    if (window.grecaptcha && widget.getAttribute('data-size') === 'invisible') {
        try { window.grecaptcha.execute(); return true; } catch (_) {}
    }

    return false;
}

module.exports = triggerRecaptchaCallback;
