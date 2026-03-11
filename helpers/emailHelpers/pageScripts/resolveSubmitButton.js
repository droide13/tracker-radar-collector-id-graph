'use strict';

/**
 * @file pageScripts/resolveSubmitButton.js
 *
 * Browser-context script.
 * Inspects the form and resolves the submit button using a 4-level priority chain:
 *   1. submitSelector pre-identified by FormDetector (id- or name-based)
 *   2. Any [type="submit"] button or input within the identified form
 *   3. The last <button> in the form (common single-button pattern)
 *   4. Global document-level [type="submit"] fallback (formIndex === -1)
 *
 * Returns a plain result object — no DOM references, only serialisable data.
 * Serialised and injected by FormSubmitter.submitForm() via CDP Runtime.evaluate.
 *
 * @param {number}      formIndex      - Index in document.forms[] (-1 = standalone)
 * @param {string|null} submitSelector - Pre-identified CSS selector from FormDetector, or null
 * @returns {{
 *   formExists:   boolean,
 *   formVisible:  boolean,
 *   totalForms:   number,
 *   allButtons:   Array<{ tag, type, id, name, text, rect, visible }>,
 *   btn:          boolean,
 *   btnText:      string|null,
 *   btnRect:      { x, y, w, h }|null,
 *   btnOffscreen: boolean,
 *   resolvedBy:   string|null
 * }}
 */
function resolveSubmitButton(formIndex, submitSelector) {
    const result = {
        formExists   : false,
        formVisible  : false,
        totalForms   : document.forms.length,
        allButtons   : [],
        btn          : null,
        btnText      : null,
        btnRect      : null,
        btnOffscreen : false,
        resolvedBy   : null,
    };

    // Priority 1: pre-identified selector inside the known form
    if (formIndex >= 0 && submitSelector) {
        const form = document.forms[formIndex];
        if (form) {
            const el = form.querySelector(submitSelector);
            if (el) { result.btn = el; result.resolvedBy = 'pre-identified selector'; }
        }
    }

    // Priority 2 + 3: [type=submit] or last button inside the form
    if (!result.btn && formIndex >= 0) {
        const form = document.forms[formIndex];
        if (form) {
            result.formExists  = true;
            const fr           = form.getBoundingClientRect();
            result.formVisible = fr.width > 0 && fr.height > 0;

            result.allButtons = Array.from(
                form.querySelectorAll('button, input[type="submit"], [role="button"]')
            ).map(b => ({
                tag    : b.tagName,
                type   : b.type || null,
                id     : b.id   || null,
                name   : b.name || null,
                text   : (b.textContent || b.value || '').trim().slice(0, 60),
                rect   : (r => ({ w: Math.round(r.width), h: Math.round(r.height),
                                  x: Math.round(r.left),  y: Math.round(r.top) }))(b.getBoundingClientRect()),
                visible: (() => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
            }));

            const el = form.querySelector(
                'button[type="submit"], input[type="submit"], button:last-of-type'
            );
            if (el) { result.btn = el; result.resolvedBy = 'form [type=submit] / last button'; }
        }
    }

    // Priority 4: global fallback
    if (!result.btn) {
        const el = document.querySelector('button[type="submit"], input[type="submit"]');
        if (el) { result.btn = el; result.resolvedBy = 'global [type=submit] fallback'; }
    }

    if (!result.btn) {
        result.resolvedBy = null;
        return result;
    }

    result.btnText = (result.btn.textContent || result.btn.value || '').trim().slice(0, 60);
    const r        = result.btn.getBoundingClientRect();
    result.btnRect = {
        x: r.left + r.width  / 2,
        y: r.top  + r.height / 2,
        w: Math.round(r.width),
        h: Math.round(r.height),
    };
    result.btnOffscreen = r.width === 0 || r.height === 0;
    result.btn          = true;   // replace DOM ref with serialisable flag
    return result;
}

module.exports = resolveSubmitButton;
