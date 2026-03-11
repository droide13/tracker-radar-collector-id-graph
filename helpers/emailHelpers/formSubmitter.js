'use strict';

/**
 * @file formSubmitter.js
 *
 * FormSubmitter — locates and activates the submit control for a detected form.
 *
 * Receives { session, evaluate, sleep, jitter } from the collector.
 * Extends MouseKeyboard for CDP mouse primitives. No CdpHelper base class.
 * All DOM logic lives in ./pageScripts/.
 *
 * Button resolution priority:
 *   1. The submitSelector pre-identified by FormDetector (id- or name-based)
 *   2. Any [type="submit"] button or input within the identified form
 *   3. The last <button> in the form (common single-button pattern)
 *   4. Global document-level [type="submit"] fallback (formIndex === -1)
 *   5. Enter key press
 */

const MouseKeyboard              = require('./mouseKeyboard');
const resolveSubmitButton        = require('./pageScripts/resolveSubmitButton');
const triggerRecaptchaCallback   = require('./pageScripts/triggerRecaptchaCallback');
const scrollSubmitButtonIntoView = require('./pageScripts/scrollSubmitButtonIntoView');
const getFreshButtonRect         = require('./pageScripts/getFreshButtonRect');

class FormSubmitter extends MouseKeyboard {

    /**
     * @param {{ session: object, evaluate: Function, sleep: Function, jitter: Function }} deps
     */
    constructor({ session, evaluate, sleep, jitter }) {
        super({ session, sleep, jitter });
        this._evaluate = evaluate;
    }

    /**
     * Locate the form's submit control and activate it with a human-like click.
     *
     * @param {number}      formIndex      - Index in document.forms[] (-1 = standalone)
     * @param {string|null} submitSelector - Pre-identified CSS selector, or null
     * @returns {Promise<{
     *   dispatched:       boolean,
     *   method:           'click'|'enter'|null,
     *   btnText:          string|null,
     *   btnRect:          { x: number, y: number }|null,
     *   captchaTriggered: boolean,
     *   diagnosis:        string
     * }>}
     */
    async submitForm(formIndex, submitSelector) {

        // Step 1: inspect the form and locate the submit button
        const info = await this._evaluate(
            `(${resolveSubmitButton.toString()})(${formIndex}, ${JSON.stringify(submitSelector)})`
        );

        // Step 2: try to trigger any reCAPTCHA callback bound to the submit button
        const captchaTriggered = await this._evaluate(
            `(${triggerRecaptchaCallback.toString()})()`
        );

        // Step 3: build diagnosis string
        const lines = [];
        lines.push(`formIndex:${formIndex}  totalForms:${info?.totalForms ?? '?'}  submitSelector:${submitSelector ?? 'none'}`);
        lines.push(`formExists:${info?.formExists}  formVisible:${info?.formVisible}`);

        if (info?.allButtons?.length) {
            lines.push(`buttons in form (${info.allButtons.length}):`);
            for (const b of info.allButtons) {
                lines.push(`  [${b.tag}] type=${b.type} id=${b.id} text="${b.text}" visible=${b.visible} rect=${JSON.stringify(b.rect)}`);
            }
        } else {
            lines.push('no buttons found in form');
        }

        if (info?.resolvedBy) {
            lines.push(`resolved via: ${info.resolvedBy}  text:"${info.btnText}"  rect:${JSON.stringify(info.btnRect)}  offscreen:${info.btnOffscreen}`);
        } else {
            lines.push('no submit button resolved — will fall back to Enter key');
        }
        lines.push(`captchaCallbackTriggered:${captchaTriggered}`);

        const diagnosis = lines.join('\n          ');

        if (captchaTriggered) {
            await this._sleep(2000);
        }

        // Step 4: dispatch
        if (info?.btnRect && !info.btnOffscreen) {

            // Scroll the button into the centre of the viewport so CDP viewport-relative
            // coordinates are valid, then re-read the rect after settling.
            await this._evaluate(
                `(${scrollSubmitButtonIntoView.toString()})(${JSON.stringify(submitSelector)})`
            );
            await this._sleep(300);

            const freshRect = await this._evaluate(
                `(${getFreshButtonRect.toString()})(${JSON.stringify(submitSelector)})`
            );

            const target = freshRect || info.btnRect;
            await this._cdpMouseMove(target.x, target.y);
            await this._sleep(this._jitter(100, 250));
            await this._cdpClick(target.x, target.y);

            return {
                dispatched      : true,
                method          : 'click',
                btnText         : info.btnText,
                btnRect         : target,
                captchaTriggered,
                diagnosis,
            };
        }

        // Step 5: Enter key fallback
        await this._session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Return' });
        await this._session.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Return' });

        return {
            dispatched      : true,
            method          : 'enter',
            btnText         : null,
            btnRect         : null,
            captchaTriggered,
            diagnosis,
        };
    }
}

module.exports = FormSubmitter;
