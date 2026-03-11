'use strict';

/**
 * @file pageScripts/injectFields.js
 *
 * Browser-context script.
 * Fills all non-email form fields via direct DOM injection:
 *   • <select>              — DOB components first, generic fallback second
 *   • <input type=checkbox> — consent / privacy boxes and first newsletter group box
 *   • <input type=text|tel|number> — mapped from identity by name/id/placeholder hints
 *
 * Serialised and injected by FieldFiller.fillAncillaryFields() via CDP Runtime.evaluate.
 * No Node.js APIs are used — only standard DOM.
 *
 * ─── Checkbox strategy ───────────────────────────────────────────────────────────────
 *
 *   Label resolution (4-level fallback):
 *     1. label[for=id]        standard explicit label
 *     2. closest('label')     checkbox wrapped inside a label
 *     3. nextElementSibling   sibling span/div — common in Italian / EU CMP forms
 *     4. parentElement.text   last-resort container text
 *
 *   Consent detection:
 *     Matches cb.required, aria-required, label text, cb.name, or cb.id against
 *     CONSENT_RE (EN / ES / FR / DE / IT / PT keywords).
 *     Also catches name="Privacy" directly via cb.name check.
 *
 *   Newsletter group:
 *     Checks the first unchecked checkbox whose name matches
 *     /newsletter.subscri/i to satisfy "select at least one" validation.
 *
 * ─── Text input hints ────────────────────────────────────────────────────────────────
 *   Concatenates name + id + placeholder + aria-label, then matches:
 *     first.?name | fname     → identity.firstName
 *     last.?name  | lname     → identity.lastName
 *     \bname\b | full.?name   → identity.fullName
 *     phone | tel | mobile    → identity.phone
 *     zip | postal | postcode → identity.zip
 *     dob | birth | birthday  → identity.dob
 *     (required, unmatched)   → identity.freeText
 *
 * @param {number} formIndex - Index into document.forms[]
 * @param {object} identity  - Plain object from loadIdentity()
 */
function injectFields(formIndex, identity) {

    const form = document.forms[formIndex];
    if (!form) return;

    // ── Selects ───────────────────────────────────────────────────────────────────────
    const dobParts = (identity.dob || '').split('-');
    const dobYear  = dobParts[0] || '';
    const dobMonth = dobParts[1] || '';   // zero-padded e.g. '06'
    const dobDay   = dobParts[2] || '';   // zero-padded e.g. '15'

    for (const sel of form.querySelectorAll('select')) {
        if (sel.value && sel.value !== '0') continue;

        const sh = [
            sel.name || '',
            sel.id   || '',
            sel.getAttribute('aria-label') || '',
        ].join(' ').toLowerCase();

        let targetValue = null;
        if      (/year|año|anno|yr/i.test(sh)      && dobYear)  targetValue = dobYear;
        else if (/month|mes|mois|monat/i.test(sh)  && dobMonth) targetValue = dobMonth;
        else if (/day|dia|día|jour|tag/i.test(sh)  && dobDay)   targetValue = dobDay;

        if (targetValue) {
            const numeric = String(parseInt(targetValue, 10));
            const padded  = targetValue.padStart(2, '0');
            const opt = Array.from(sel.options).find(
                o => o.value === targetValue || o.value === numeric || o.value === padded
            );
            if (opt) {
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                continue;
            }
        }

        // Generic fallback: first non-empty, non-zero option
        const opt = Array.from(sel.options).find(
            o => o.value.trim() !== '' && o.value !== '0'
        );
        if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // ── Checkboxes ────────────────────────────────────────────────────────────────────
    const OPT_OUT_SIGNALS = [
        'do not', 'opt out', 'unsubscribe', 'remove me', 'stop sending',
        'no quiero', 'darse de baja', 'cancelar suscripci',
    ];
    const CONSENT_RE = /terms|privacy|privac|consent|agree|acepto|leído|entiendo|política|politique|datenschutz|condizioni|aceitar|rgpd|gdpr/i;

    /**
     * Resolve the human-readable label text for a checkbox using a 4-level fallback.
     * @param {HTMLInputElement} cb
     * @returns {string}
     */
    function resolveLabel(cb) {
        if (cb.id) {
            const explicit = form.querySelector('label[for="' + cb.id + '"]');
            if (explicit) return explicit.textContent;
        }
        const inLabel = cb.closest('label');
        if (inLabel) return inLabel.textContent;
        const sibling = cb.nextElementSibling;
        if (sibling) return sibling.textContent;
        return (cb.parentElement || {}).textContent || '';
    }

    let newsletterGroupChecked = false;

    for (const cb of form.querySelectorAll('input[type="checkbox"]')) {
        if (cb.checked) continue;

        const labelText = resolveLabel(cb).toLowerCase();
        const isOptOut  = OPT_OUT_SIGNALS.some(s => labelText.includes(s));

        const isConsent = !isOptOut && (
            cb.required ||
            cb.getAttribute('aria-required') === 'true' ||
            CONSENT_RE.test(labelText) ||
            CONSENT_RE.test((cb.name || '').toLowerCase()) ||
            CONSENT_RE.test((cb.id   || '').toLowerCase())
        );

        const isNewsletterGroup = /newsletter.subscri/i.test(cb.name || '');

        if (isConsent) {
            cb.checked = true;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            cb.dispatchEvent(new Event('input',  { bubbles: true }));
        } else if (isNewsletterGroup && !newsletterGroupChecked) {
            cb.checked = true;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            cb.dispatchEvent(new Event('input',  { bubbles: true }));
            newsletterGroupChecked = true;
        }
    }

    // ── Text / tel / number inputs ────────────────────────────────────────────────────
    const inputSelector =
        'input[type="text"], input[type="tel"], input[type="number"], input:not([type])';

    for (const inp of form.querySelectorAll(inputSelector)) {
        if (inp.disabled || inp.readOnly || inp.value) continue;
        const r = inp.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;   // hidden / honeypot

        const hints = [
            inp.name        || '',
            inp.id          || '',
            inp.placeholder || '',
            inp.getAttribute('aria-label') || '',
        ].join(' ').toLowerCase();

        let value = null;
        if      (/first.?name|fname/i.test(hints))      value = identity.firstName;
        else if (/last.?name|lname/i.test(hints))       value = identity.lastName;
        else if (/\bname\b|full.?name/i.test(hints))    value = identity.fullName;
        else if (/phone|tel|mobile/i.test(hints))       value = identity.phone;
        else if (/zip|postal|postcode/i.test(hints))    value = identity.zip;
        else if (/dob|birth|birthday/i.test(hints))     value = identity.dob;
        else if (inp.required || inp.getAttribute('aria-required') === 'true') {
            value = identity.freeText;
        }

        if (value !== null) {
            const nativeSet =
                Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSet.call(inp, value);
            inp.dispatchEvent(new Event('input',  { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
}

module.exports = injectFields;