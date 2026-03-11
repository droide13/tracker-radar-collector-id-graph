'use strict';

/**
 * @file pageScripts/getFreshButtonRect.js
 *
 * Browser-context script.
 * Re-reads the submit button's bounding rect AFTER scrollIntoView has been called.
 * Coordinates from before scrolling are stale — CDP mouse events are viewport-relative
 * so we must re-read them once the page has settled.
 *
 * Serialised and injected by FormSubmitter.submitForm() via CDP Runtime.evaluate.
 *
 * @param {string|null} submitSelector - CSS selector from FormDetector, or null
 * @returns {{ x: number, y: number, w: number, h: number } | null}
 */
function getFreshButtonRect(submitSelector) {
    const sel = submitSelector || 'button[type="submit"], input[type="submit"]';
    const btn = document.querySelector(sel);
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return {
        x: r.left + r.width  / 2,
        y: r.top  + r.height / 2,
        w: Math.round(r.width),
        h: Math.round(r.height),
    };
}

module.exports = getFreshButtonRect;
