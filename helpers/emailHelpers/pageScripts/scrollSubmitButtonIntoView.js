'use strict';

/**
 * @file pageScripts/scrollSubmitButtonIntoView.js
 *
 * Browser-context script.
 * Scrolls the submit button into the centre of the viewport using instant behaviour
 * so CDP mouse-click coordinates (which are viewport-relative) will be valid.
 *
 * Must be called before getFreshButtonRect.js whenever the button may be off-screen.
 *
 * Serialised and injected by FormSubmitter.submitForm() via CDP Runtime.evaluate.
 *
 * @param {string|null} submitSelector - CSS selector from FormDetector, or null
 */
function scrollSubmitButtonIntoView(submitSelector) {
    const sel = submitSelector || 'button[type="submit"], input[type="submit"]';
    const btn = document.querySelector(sel);
    if (btn) btn.scrollIntoView({ behavior: 'instant', block: 'center' });
}

module.exports = scrollSubmitButtonIntoView;
