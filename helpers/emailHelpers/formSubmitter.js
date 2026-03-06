'use strict';

/**
 * @file formSubmitter.js
 *
 * FormSubmitter - locates and activates the submit control for a detected form.
 *
 * Receives { session, evaluate, sleep, jitter } from the collector.
 * Extends MouseKeyboard for CDP mouse primitives. No CdpHelper base class.
 *
 * Button resolution priority:
 *   1. The submitSelector pre-identified by FormDetector (id- or name-based)
 *   2. Any [type="submit"] button or input within the identified form
 *   3. The last <button> in the form (common single-button pattern)
 *   4. Global document-level [type="submit"] fallback (formIndex === -1)
 *   5. Enter key press
 */

const MouseKeyboard = require('./mouseKeyboard');

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
     *   dispatched: boolean,
     *   method: 'click'|'enter'|null,
     *   btnText: string|null,
     *   btnRect: {x:number,y:number}|null,
     *   captchaTriggered: boolean,
     *   diagnosis: string
     * }>}
     */
    async submitForm(formIndex, submitSelector) {

        // Step 1: inspect the form and locate the submit button
        const info = await this._evaluate(`
            (function () {
                const result = {
                    formExists   : false,
                    formVisible  : false,
                    totalForms   : document.forms.length,
                    allButtons   : [],
                    btn          : null,
                    btnText      : null,
                    btnRect      : null,
                    btnOffscreen : false,
                    resolvedBy   : null
                };

                if (${formIndex} >= 0 && ${JSON.stringify(submitSelector)}) {
                    const form = document.forms[${formIndex}];
                    if (form) {
                        const el = form.querySelector(${JSON.stringify(submitSelector)});
                        if (el) { result.btn = el; result.resolvedBy = 'pre-identified selector'; }
                    }
                }

                if (!result.btn && ${formIndex} >= 0) {
                    const form = document.forms[${formIndex}];
                    if (form) {
                        result.formExists  = true;
                        const fr = form.getBoundingClientRect();
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
                            visible: (() => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()
                        }));

                        const el = form.querySelector(
                            'button[type="submit"], input[type="submit"], button:last-of-type'
                        );
                        if (el) { result.btn = el; result.resolvedBy = 'form [type=submit] / last button'; }
                    }
                }

                if (!result.btn) {
                    const el = document.querySelector('button[type="submit"], input[type="submit"]');
                    if (el) { result.btn = el; result.resolvedBy = 'global [type=submit] fallback'; }
                }

                if (!result.btn) {
                    result.resolvedBy = null;
                    return result;
                }

                result.btnText = (result.btn.textContent || result.btn.value || '').trim().slice(0, 60);
                const r = result.btn.getBoundingClientRect();
                result.btnRect     = { x: r.left + r.width / 2, y: r.top + r.height / 2,
                                       w: Math.round(r.width), h: Math.round(r.height) };
                result.btnOffscreen = r.width === 0 || r.height === 0;
                result.btn = true;
                return result;
            })();
        `);

        // Step 2: try to trigger any reCAPTCHA callback bound to the submit button.
        // Invisible v2/v3 widgets hijack the button's click handler and generate a
        // token before allowing the POST. A raw mouse event bypasses this entirely.
        const captchaTriggered = await this._evaluate(`
            (function () {
                const btn = document.querySelector('button[type="submit"], input[type="submit"]');
                if (!btn) return false;

                const widget = document.querySelector(
                    '.g-recaptcha[data-bind="' + btn.id + '"], ' +
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
            })();
        `);

        // Step 3: build diagnosis string (after both evaluates so all vars are defined)
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

            // Scroll the button into the centre of the viewport before clicking.
            // btnRect coords are page-relative (getBoundingClientRect + scrollY),
            // but CDP mouse events are viewport-relative — we must align them first.
            await this._evaluate(`
                (function () {
                    const sel = ${JSON.stringify(submitSelector)} || 'button[type="submit"], input[type="submit"]';
                    const btn = document.querySelector(sel);
                    if (btn) btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                })();
            `);
            await this._sleep(300);

            // Re-read the rect AFTER scrolling — coords have changed in viewport space.
            const freshRect = await this._evaluate(`
                (function () {
                    const sel = ${JSON.stringify(submitSelector)} || 'button[type="submit"], input[type="submit"]';
                    const btn = document.querySelector(sel);
                    if (!btn) return null;
                    const r = btn.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2,
                            w: Math.round(r.width),   h: Math.round(r.height) };
                })();
            `);

            const target = freshRect || info.btnRect;
            await this._cdpMouseMove(target.x, target.y);
            await this._sleep(this._jitter(100, 250));
            await this._cdpClick(target.x, target.y);
            return { dispatched: true, method: 'click', btnText: info.btnText,
                    btnRect: target, captchaTriggered, diagnosis };
        }
    }
}

module.exports = FormSubmitter;