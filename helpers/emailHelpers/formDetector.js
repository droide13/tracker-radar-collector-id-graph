'use strict';

/**
 * @file formDetector.js
 *
 * FormDetector — discovers newsletter signup forms on a loaded page.
 *
 * Receives { evaluate } from the collector. No base class.
 *
 * ─── Form scoring heuristics ─────────────────────────────────────────────────────────
 *   +3  per newsletter keyword in form text / id / class / action URL
 *   -20 if the form contains "password", "login", "checkout", or "payment"
 *
 * ─── Fallback ────────────────────────────────────────────────────────────────────────
 *   If no qualifying <form> is found, locateEmailForm() looks for standalone email
 *   inputs (outside <form> elements) not inside login-flagged containers.
 *
 * ─── Pending TODOs ───────────────────────────────────────────────────────────────────
 *   • Shadow DOM traversal (_querySelectorAllDeep)
 *   • Cross-origin iframe detection via Page.getFrameTree
 *   • _triggerDynamicForms (scroll, exit-intent, button reveals)
 *   • _advanceMultiStep for two-step forms
 */

const {
    NEWSLETTER_KEYWORDS,
    SUBMIT_TEXT_PATTERNS,
    MAX_CANDIDATE_LINKS
} = require('./constants');

class FormDetector {

    /**
     * @param {{ evaluate: Function }} deps
     *   evaluate — bound _evaluate method from EmailFillCollector
     */
    constructor({ evaluate }) {
        this._evaluate = evaluate;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // LINK DISCOVERY
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Scan the live DOM for anchor links whose combined text signals suggest a
     * newsletter or subscription destination.
     *
     * @returns {Promise<string[]>} Absolute URLs of candidate links, in DOM order
     */
    async findCandidateLinks() {
        return await this._evaluate(`
            (function () {
                const KW      = ${JSON.stringify(NEWSLETTER_KEYWORDS)};
                const seen    = new Set();
                const results = [];

                for (const el of document.querySelectorAll('a[href]')) {
                    const href     = el.href || '';
                    const text     = (el.textContent || '').toLowerCase();
                    const title    = (el.title || '').toLowerCase();
                    const ariaL    = (el.getAttribute('aria-label') || '').toLowerCase();
                    const combined = href.toLowerCase() + ' ' + text + ' ' + title + ' ' + ariaL;

                    if (KW.some(k => combined.includes(k)) && !seen.has(href)) {
                        seen.add(href);
                        results.push(href);
                        if (results.length >= ${MAX_CANDIDATE_LINKS}) break;
                    }
                }
                return results;
            })();
        `);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // FORM LOCATION
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Locate the most likely newsletter email form on the current page.
     *
     * Returns stable DOM indices (formIndex, fieldIndex) that other helpers use to
     * interact with the identified form and email field within the same page load.
     *
     * @returns {Promise<{formIndex: number, fieldIndex: number, submitSelector: string|null}|null>}
     */
    async locateEmailForm() {
        return await this._evaluate(`
            (function () {
                const SUBMIT_PATTERNS = ${JSON.stringify(SUBMIT_TEXT_PATTERNS.map(r => r.source))};
                const submitRe        = SUBMIT_PATTERNS.map(p => new RegExp(p, 'i'));

                function scoreForm(form) {
                    let score    = 0;
                    const text   = (form.textContent || '').toLowerCase();
                    const id     = (form.id          || '').toLowerCase();
                    const cls    = (form.className   || '').toLowerCase();
                    const action = (form.action      || '').toLowerCase();
                    const combined = text + ' ' + id + ' ' + cls + ' ' + action;

                    const KW = ${JSON.stringify(NEWSLETTER_KEYWORDS)};
                    KW.forEach(k => { if (combined.includes(k)) score += 3; });

                    if (combined.includes('password') || combined.includes('login') ||
                        combined.includes('checkout') || combined.includes('payment')) {
                        score -= 20;
                    }
                    return score;
                }

                const rankedForms = Array.from(document.querySelectorAll('form'))
                    .filter(f => {
                        const r = f.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    })
                    .map(f => ({ form: f, score: scoreForm(f) }))
                    .filter(x => x.score > -10)
                    .sort((a, b) => b.score - a.score);

                for (const { form } of rankedForms) {
                    if (form.querySelector('input[type="password"]')) continue;

                    const emailField = Array.from(
                        form.querySelectorAll(
                            'input[type="email"], input[name*="email" i], ' +
                            'input[placeholder*="email" i], input[id*="email" i]'
                        )
                    ).find(el => {
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly;
                    });

                    if (!emailField) continue;

                    const formIndex  = Array.from(document.forms).indexOf(form);
                    const allInputs  = Array.from(document.querySelectorAll('input'));
                    const fieldIndex = allInputs.indexOf(emailField);

                    let submitSelector = null;
                    const btns = Array.from(
                        form.querySelectorAll('button, input[type="submit"], [role="button"]')
                    );
                    for (const btn of btns) {
                        const label = (
                            btn.textContent ||
                            btn.value       ||
                            btn.getAttribute('aria-label') || ''
                        ).trim();
                        if (submitRe.some(r => r.test(label)) || btn.type === 'submit') {
                            if (btn.id)   { submitSelector = '#' + CSS.escape(btn.id);    break; }
                            if (btn.name) { submitSelector = '[name="' + btn.name + '"]'; break; }
                            submitSelector = 'button[type="submit"], input[type="submit"]';
                            break;
                        }
                    }

                    return { formIndex, fieldIndex, submitSelector };
                }

                // Fallback: standalone email inputs outside any <form>
                const standalone = Array.from(
                    document.querySelectorAll(
                        'input[type="email"], input[name*="email" i], input[placeholder*="email" i]'
                    )
                ).find(el => {
                    const r = el.getBoundingClientRect();
                    return (
                        r.width > 0 && r.height > 0 &&
                        !el.disabled && !el.readOnly &&
                        !el.closest('form[action*="login"]') &&
                        !el.closest('[id*="login"]')
                    );
                });

                if (standalone) {
                    const allInputs = Array.from(document.querySelectorAll('input'));
                    return {
                        formIndex     : -1,
                        fieldIndex    : allInputs.indexOf(standalone),
                        submitSelector: null
                    };
                }

                return null;
            })();
        `);
    }
}

module.exports = FormDetector;
