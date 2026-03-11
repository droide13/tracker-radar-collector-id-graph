'use strict';

/**
 * @file pageScripts/getEmailFieldRect.js
 *
 * Browser-context script.
 * Returns the bounding rect of the input at `fieldIndex` in document.querySelectorAll('input'),
 * or null if the element does not exist.
 *
 * Serialised and injected by FieldFiller.humanFill() via CDP Runtime.evaluate.
 *
 * @param {number} fieldIndex
 * @returns {{ x: number, y: number, w: number, h: number } | null}
 */
function getEmailFieldRect(fieldIndex) {
    const el = document.querySelectorAll('input')[fieldIndex];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
}

module.exports = getEmailFieldRect;
