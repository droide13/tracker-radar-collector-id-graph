'use strict';

/**
 * @file fieldFiller.js
 *
 * FieldFiller — fills form fields with realistic identity data and human-like input.
 *
 * Receives { session, evaluate, sleep, jitter } from the collector.
 * Extends MouseKeyboard for CDP mouse/keyboard primitives. No CdpHelper base class.
 *
 * ─── Two interaction modes ───────────────────────────────────────────────────────────
 *   humanFill            — full CDP simulation for the email input (highest visibility)
 *   fillAncillaryFields  — direct DOM injection for all other fields (selects,
 *                          checkboxes, name/phone/zip); no mouse events needed
 *
 * ─── Framework-compatible value injection ────────────────────────────────────────────
 *   React/Vue/Angular override the native input value setter. We use
 *   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
 *   to bypass the override and then fire input/change events so the framework
 *   registers the new value.
 *
 * ─── Honeypot avoidance ───────────────────────────────────────────────────────────────
 *   Inputs with a zero bounding rect are skipped — they are either hidden or honeypots.
 *
 * ─── Consent checkbox strategy ───────────────────────────────────────────────────────
 *   Check: opt-in / ToS / privacy / GDPR consent checkboxes.
 *   Skip:  any whose label contains "do not", "opt out", "unsubscribe", etc.
 */

const MouseKeyboard = require('./mouseKeyboard');
const loadIdentity  = require('./loadIdentity');
const { TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS } = require('./emailConstants');

class FieldFiller extends MouseKeyboard {

    /**
     * @param {{ session: object, evaluate: Function, sleep: Function, jitter: Function }} deps
     */
    constructor({ session, evaluate, sleep, jitter }) {
        super({ session, sleep, jitter });
        this._evaluate = evaluate;
        this._identity = loadIdentity();
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // EMAIL INPUT — HUMAN SIMULATION
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Click the email input and type the address with realistic CDP input events.
     *
     * Calls _randomMouseWander() first so the wander and the field click form one
     * continuous gesture, keeping the orchestrator free of internal method calls.
     *
     * @param {number} fieldIndex - Index in document.querySelectorAll('input')
     * @param {string} email      - The email address to type
     * @returns {Promise<boolean>} true if typing succeeded
     */
    async humanFill(fieldIndex, email) {
        await this._randomMouseWander();

        const rect = await this._evaluate(`
            (function () {
                const el = document.querySelectorAll('input')[${fieldIndex}];
                if (!el) return null;
                const r  = el.getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height };
            })();
        `);

        if (!rect) return false;

        const cx = rect.x + rect.w / 2 + this._jitter(-4, 4);
        const cy = rect.y + rect.h / 2 + this._jitter(-2, 2);

        await this._cdpMouseMove(cx, cy);
        await this._sleep(this._jitter(80, 200));
        await this._cdpClick(cx, cy);
        await this._sleep(this._jitter(150, 350));

        // Clear any pre-filled content (Ctrl+A → Delete)
        await this._session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 });
        await this._session.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'a', modifiers: 2 });
        await this._session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete' });
        await this._session.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Delete' });
        await this._sleep(this._jitter(50, 150));

        for (const char of email) {
            await this._cdpTypeChar(char);
            await this._sleep(this._jitter(TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS));
            if (Math.random() < 0.05) {
                await this._sleep(this._jitter(200, 500));
            }
        }

        // Commit value via native setter so React/Vue/Angular register it
        await this._evaluate(`
            (function () {
                const el = document.querySelectorAll('input')[${fieldIndex}];
                if (!el) return;
                const nativeInputValueSetter =
                    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeInputValueSetter.call(el, ${JSON.stringify(email)});
                el.dispatchEvent(new Event('input',  { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur',   { bubbles: true }));
            })();
        `);

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // ANCILLARY FIELDS — DIRECT INJECTION
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Fill all non-email required fields via direct DOM value injection.
     *
     * Select handling:
     *   Detects DOB-component selects by name/id/aria-label hints (year/año, month/mes,
     *   day/dia and equivalents in FR/DE/IT/PT) and picks the option matching the
     *   corresponding part of identity.dob (YYYY-MM-DD), tolerating zero-padding
     *   differences between the identity value and the option values.
     *   Unknown selects fall back to the first non-empty, non-zero option.
     *
     * Checkbox handling:
     *   Checks any consent/ToS/privacy checkbox whose label matches a multilingual
     *   regex (EN/ES/FR/DE/IT/PT). Skips opt-out checkboxes whose label signals removal.
     *
     * Text input mapping (hints = name + id + placeholder + aria-label):
     *   first.?name | fname     → identity.firstName
     *   last.?name  | lname     → identity.lastName
     *   \bname\b | full.?name   → identity.fullName
     *   phone | tel | mobile    → identity.phone
     *   zip | postal | postcode → identity.zip
     *   dob | birth | birthday  → identity.dob
     *   (required, unmatched)   → identity.freeText
     *
     * @param {number} formIndex - Index in document.forms[]; -1 = standalone (skip)
     */
    async fillAncillaryFields(formIndex) {
        if (formIndex < 0) return;

        await this._evaluate(`
            (function () {
                const form = document.forms[${formIndex}];
                if (!form) return;

                const identity = ${JSON.stringify(this._identity)};

                // ── Selects ─────────────────────────────────────────────────────────
                // Parse identity.dob (YYYY-MM-DD) into parts for DOB-component selects.
                const dobParts = (identity.dob || '').split('-');  // ['1990', '06', '15']
                const dobYear  = dobParts[0] || '';
                const dobMonth = dobParts[1] || '';   // zero-padded, e.g. '06'
                const dobDay   = dobParts[2] || '';   // zero-padded, e.g. '15'

                for (const sel of form.querySelectorAll('select')) {
                    if (sel.value && sel.value !== '0') continue;

                    // Build a hints string from name, id, and aria-label
                    const sh = [
                        sel.name || '',
                        sel.id   || '',
                        sel.getAttribute('aria-label') || ''
                    ].join(' ').toLowerCase();

                    // Try to match a DOB component first
                    let targetValue = null;
                    if (/year|año|anno|yr/i.test(sh) && dobYear) {
                        targetValue = dobYear;
                    } else if (/month|mes|mois|monat/i.test(sh) && dobMonth) {
                        // Options may be zero-padded ('06') or not ('6') — try both
                        targetValue = dobMonth;
                    } else if (/day|dia|día|jour|tag/i.test(sh) && dobDay) {
                        targetValue = dobDay;
                    }

                    if (targetValue) {
                        // Find the option whose value matches with or without leading zero
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

                    // Generic fallback: pick the first non-empty, non-zero option
                    const opt = Array.from(sel.options).find(
                        o => o.value.trim() !== '' && o.value !== '0'
                    );
                    if (opt) {
                        sel.value = opt.value;
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }

                // ── Checkboxes: opt-in / consent ─────────────────────────────────────
                // OPT_OUT_SIGNALS: skip any checkbox whose label clearly means "remove me".
                const OPT_OUT_SIGNALS = [
                    'do not', 'opt out', 'unsubscribe', 'remove me', 'stop sending',
                    'no quiero', 'darse de baja', 'cancelar suscripci'
                ];
                // CONSENT_RE: matches privacy/ToS acceptance in multiple languages.
                // Covers English, Spanish, French, German, Italian, Portuguese.
                const CONSENT_RE = /terms|privacy|privac|consent|agree|acepto|leído|entiendo|política|politique|datenschutz|condizioni|aceitar|rgpd|gdpr/i;

                for (const cb of form.querySelectorAll('input[type="checkbox"]')) {
                    if (cb.checked) continue;
                    const label = (
                        form.querySelector('label[for="' + cb.id + '"]') ||
                        cb.closest('label')
                    );
                    const labelText = (label ? label.textContent : '').toLowerCase();
                    const isOptOut  = OPT_OUT_SIGNALS.some(s => labelText.includes(s));
                    const isConsent = cb.required ||
                                      cb.getAttribute('aria-required') === 'true' ||
                                      CONSENT_RE.test(labelText);
                    if (!isOptOut && isConsent) {
                        cb.checked = true;
                        cb.dispatchEvent(new Event('change', { bubbles: true }));
                        cb.dispatchEvent(new Event('input',  { bubbles: true }));
                    }
                }

                // ── Text / tel / number inputs ────────────────────────────────────────
                const inputSelector =
                    'input[type="text"], input[type="tel"], ' +
                    'input[type="number"], input:not([type])';

                for (const inp of form.querySelectorAll(inputSelector)) {
                    if (inp.disabled || inp.readOnly || inp.value) continue;
                    const r = inp.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;  // hidden / honeypot

                    const hints = [
                        inp.name        || '',
                        inp.id          || '',
                        inp.placeholder || '',
                        (inp.getAttribute('aria-label') || '')
                    ].join(' ').toLowerCase();

                    let value = null;

                    if      (/first.?name|fname/i.test(hints))       value = identity.firstName;
                    else if (/last.?name|lname/i.test(hints))        value = identity.lastName;
                    else if (/\\bname\\b|full.?name/i.test(hints))   value = identity.fullName;
                    else if (/phone|tel|mobile/i.test(hints))        value = identity.phone;
                    else if (/zip|postal|postcode/i.test(hints))     value = identity.zip;
                    else if (/dob|birth|birthday/i.test(hints))      value = identity.dob;
                    else if (inp.required || inp.getAttribute('aria-required') === 'true') {
                        value = identity.freeText;
                    }

                    if (value !== null) {
                        const nativeSet =
                            Object.getOwnPropertyDescriptor(
                                window.HTMLInputElement.prototype, 'value'
                            ).set;
                        nativeSet.call(inp, value);
                        inp.dispatchEvent(new Event('input',  { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
            })();
        `);
    }
}

module.exports = FieldFiller;