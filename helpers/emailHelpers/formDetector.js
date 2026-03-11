'use strict';

/**
 * @file formDetector.js
 *
 * FormDetector — discovers newsletter signup forms on a loaded page.
 *
 * Receives { evaluate } from the collector. No base class.
 * All DOM logic lives in ./pageScripts/.
 *
 * ─── Pending TODOs ───────────────────────────────────────────────────────────────────
 *   • Shadow DOM traversal (_querySelectorAllDeep)
 *   • Cross-origin iframe detection via Page.getFrameTree
 *   • _triggerDynamicForms (scroll, exit-intent, button reveals)
 *   • _advanceMultiStep for two-step forms
 */

const findCandidateLinks = require('./pageScripts/findCandidateLinks');
const locateEmailForm    = require('./pageScripts/locateEmailForm');

const {
    NEWSLETTER_KEYWORDS,
    SUBMIT_TEXT_PATTERNS,
    MAX_CANDIDATE_LINKS,
} = require('./emailConstants');

class FormDetector {

    /**
     * @param {{ evaluate: Function }} deps
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
        return this._evaluate(
            `(${findCandidateLinks.toString()})(${JSON.stringify(NEWSLETTER_KEYWORDS)}, ${MAX_CANDIDATE_LINKS})`
        );
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
     * @returns {Promise<{ formIndex: number, fieldIndex: number, submitSelector: string|null } | null>}
     */
    async locateEmailForm() {
        const submitPatternSources = SUBMIT_TEXT_PATTERNS.map(r => r.source);
        return this._evaluate(
            `(${locateEmailForm.toString()})(${JSON.stringify(NEWSLETTER_KEYWORDS)}, ${JSON.stringify(submitPatternSources)})`
        );
    }
}

module.exports = FormDetector;
