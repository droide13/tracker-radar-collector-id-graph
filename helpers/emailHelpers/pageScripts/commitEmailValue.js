'use strict';

/**
 * @file pageScripts/commitEmailValue.js
 *
 * Browser-context script.
 * Commits a value to the email input using the native HTMLInputElement setter so
 * React / Vue / Angular frameworks register the change, then fires input/change/blur.
 *
 * Serialised and injected by FieldFiller.humanFill() via CDP Runtime.evaluate
 * after the CDP key-event typing loop has finished.
 *
 * @param {number} fieldIndex
 * @param {string} email
 */
function commitEmailValue(fieldIndex, email) {
    const el = document.querySelectorAll('input')[fieldIndex];
    if (!el) return;

    const nativeSet =
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

    nativeSet.call(el, email);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
}

module.exports = commitEmailValue;
