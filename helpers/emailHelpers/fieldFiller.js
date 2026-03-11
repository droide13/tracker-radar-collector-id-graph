'use strict';

/**
 * @file fieldFiller.js
 *
 * FieldFiller — fills form fields with realistic identity data and human-like input.
 *
 * Receives { session, evaluate, sleep, jitter } from the collector.
 * Extends MouseKeyboard for CDP mouse/keyboard primitives.
 *
 * ─── Two interaction modes ───────────────────────────────────────────────────────────
 *   humanFill            — full CDP simulation for the email input (highest visibility)
 *   fillAncillaryFields  — direct DOM injection for all other fields (selects,
 *                          checkboxes, name/phone/zip); no mouse events needed
 *
 * ─── DOM scripts ─────────────────────────────────────────────────────────────────────
 *   All browser-context JS lives in ./pageScripts/ and is serialised into CDP
 *   Runtime.evaluate calls via .toString(). No inline DOM code in this file.
 *
 *     getEmailFieldRect   returns bounding rect of the email input
 *     commitEmailValue    native setter + events after CDP typing loop
 *     injectFields        selects, checkboxes, text inputs
 *
 * ─── Crash propagation ───────────────────────────────────────────────────────────────
 *   All MouseKeyboard methods return false on renderer crash. humanFill checks each
 *   return value and propagates false up to emailFillCollector, which is the only
 *   place that logs. No logging in this file.
 */

const MouseKeyboard     = require('./mouseKeyboard');
const loadIdentity      = require('./loadIdentity');
const getEmailFieldRect = require('./pageScripts/getEmailFieldRect');
const commitEmailValue  = require('./pageScripts/commitEmailValue');
const injectFields      = require('./pageScripts/injectFields');
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
     * Each MouseKeyboard call returns false on renderer crash (STATUS_ACCESS_VIOLATION
     * or session detach). We propagate false immediately so emailFillCollector can log
     * and abort cleanly — no logging here.
     *
     * @param {number} fieldIndex - Index in document.querySelectorAll('input')
     * @param {string} email      - The email address to type
     * @returns {Promise<boolean>} false if typing failed or renderer crashed
     */
    async humanFill(fieldIndex, email) {
        if (!await this._randomMouseWander()) return false;

        const rect = await this._evaluate(
            `(${getEmailFieldRect.toString()})(${fieldIndex})`
        );
        if (!rect) return false;

        const cx = rect.x + rect.w / 2 + this._jitter(-4, 4);
        const cy = rect.y + rect.h / 2 + this._jitter(-2, 2);

        if (!await this._cdpMouseMove(cx, cy)) return false;
        await this._sleep(this._jitter(80, 200));

        if (!await this._cdpClick(cx, cy)) return false;
        await this._sleep(this._jitter(150, 350));

        // Clear any pre-filled content (Ctrl+A → Delete)
        await this._session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 });
        await this._session.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'a', modifiers: 2 });
        await this._session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete' });
        await this._session.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Delete' });
        await this._sleep(this._jitter(50, 150));

        for (const char of email) {
            if (!await this._cdpTypeChar(char)) return false;
            await this._sleep(this._jitter(TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS));
            if (Math.random() < 0.05) await this._sleep(this._jitter(200, 500));
        }

        // Commit value via native setter so React/Vue/Angular register it
        await this._evaluate(
            `(${commitEmailValue.toString()})(${fieldIndex}, ${JSON.stringify(email)})`
        );

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // ANCILLARY FIELDS — DIRECT INJECTION
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Fill all non-email required fields via direct DOM value injection.
     * All DOM logic lives in pageScripts/injectFields.js.
     *
     * @param {number} formIndex - Index in document.forms[]; -1 = standalone (skip)
     */
    async fillAncillaryFields(formIndex) {
        if (formIndex < 0) return;

        await this._evaluate(
            `(${injectFields.toString()})(${formIndex}, ${JSON.stringify(this._identity)})`
        );
    }
}

module.exports = FieldFiller;