'use strict';

/**
 * @file pageScripts/locateEmailForm.js
 *
 * Browser-context script.
 * Locates the most likely newsletter email form on the current page using a
 * keyword-based scoring heuristic, then falls back to standalone email inputs.
 *
 * Serialised and injected by FormDetector.locateEmailForm() via CDP Runtime.evaluate.
 *
 * ─── Form scoring heuristics ─────────────────────────────────────────────────────────
 *   +3  per newsletter keyword in form text / id / class / action URL
 *   -20 if the form contains "password", "login", "checkout", or "payment"
 *
 * ─── Fallback ────────────────────────────────────────────────────────────────────────
 *   If no qualifying <form> is found, scans for standalone email inputs outside
 *   <form> elements that are not inside login-flagged containers.
 *
 * @param {string[]} keywords       - NEWSLETTER_KEYWORDS from emailConstants
 * @param {string[]} submitPatterns - SUBMIT_TEXT_PATTERNS regex sources from emailConstants
 * @returns {{ formIndex: number, fieldIndex: number, submitSelector: string|null } | null}
 */
function locateEmailForm(keywords, submitPatterns) {
    const submitRe = submitPatterns.map(p => new RegExp(p, 'i'));

    function scoreForm(form) {
        let score      = 0;
        const text     = (form.textContent || '').toLowerCase();
        const id       = (form.id          || '').toLowerCase();
        const cls      = (form.className   || '').toLowerCase();
        const action   = (form.action      || '').toLowerCase();
        const combined = text + ' ' + id + ' ' + cls + ' ' + action;

        keywords.forEach(k => { if (combined.includes(k)) score += 3; });

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
            submitSelector: null,
        };
    }

    return null;
}

module.exports = locateEmailForm;
