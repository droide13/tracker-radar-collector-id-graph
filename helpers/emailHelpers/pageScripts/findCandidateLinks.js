'use strict';

/**
 * @file pageScripts/findCandidateLinks.js
 *
 * Browser-context script.
 * Scans the live DOM for anchor links whose combined signals (href, text, title,
 * aria-label) suggest a newsletter or subscription destination.
 *
 * Serialised and injected by FormDetector.findCandidateLinks() via CDP Runtime.evaluate.
 *
 * @param {string[]} keywords   - NEWSLETTER_KEYWORDS from emailConstants
 * @param {number}   maxLinks   - MAX_CANDIDATE_LINKS from emailConstants
 * @returns {string[]} Absolute URLs of candidate links, in DOM order
 */
function findCandidateLinks(keywords, maxLinks) {
    const seen    = new Set();
    const results = [];

    for (const el of document.querySelectorAll('a[href]')) {
        const href     = el.href || '';
        const text     = (el.textContent || '').toLowerCase();
        const title    = (el.title || '').toLowerCase();
        const ariaL    = (el.getAttribute('aria-label') || '').toLowerCase();
        const combined = href.toLowerCase() + ' ' + text + ' ' + title + ' ' + ariaL;

        if (keywords.some(k => combined.includes(k)) && !seen.has(href)) {
            seen.add(href);
            results.push(href);
            if (results.length >= maxLinks) break;
        }
    }

    return results;
}

module.exports = findCandidateLinks;
