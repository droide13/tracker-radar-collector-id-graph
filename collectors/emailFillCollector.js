const BaseCollector = require('./BaseCollector');

/**
 * Keywords used to discover potential newsletter/signup links.
 * @type {string[]}
 */
const KEYWORDS = ['newsletter', 'subscribe', 'signup', 'join', 'updates'];

/**
 * Maximum number of candidate links to visit.
 * @type {number}
 */
const MAX_LINKS_TO_VISIT = 5;

/**
 * Collector that detects and attempts to submit newsletter/email forms.
 *
 * Responsibilities:
 *  - Detect email input fields
 *  - Avoid login forms (skip password fields)
 *  - Simulate human typing
 *  - Detect captcha presence
 *  - Navigate to likely newsletter pages if needed
 *
 * Uses Chrome DevTools Protocol (CDP) Runtime.evaluate
 * to execute logic inside the page context.
 *
 * Public lifecycle (called by crawler framework):
 *  - id()
 *  - init(options)
 *  - addTarget(session, targetInfo)
 *  - postLoad()
 *  - getData()
 */
class EmailFillCollector extends BaseCollector {

    /**
     * Extra delay after page load (ms).
     * Helps with JS-heavy pages.
     */
    collectorExtraTimeMs = 5000;

    /**
     * Returns unique collector identifier.
     * @returns {string}
     */
    id() {
        return 'emailFill';
    }

    /**
     * Initializes collector.
     * IMPORTANT: Must match BaseCollector.init signature.
     *
     * @param {Object} options
     * @param {*} options.browserConnection
     * @param {URL} options.url - URL object (not string)
     * @param {Function} options.log
     * @param {Object} [options.collectorFlags]
     */
    init(options) {
        const { browserConnection, url, log, collectorFlags } = options;

        this._browserConnection = browserConnection;

        // url is a URL object
        this._url = url;

        this._log = log;
        this._email = collectorFlags?.emailAddress || 'test@example.com';

        this._mainSession = null;

        /**
         * Final result returned by getData()
         */
        this._result = {
            visitedLinks: [],
            filled: false,
            captchaPresent: false
        };
    }

    /**
     * Called when a new CDP target is attached.
     * Stores the first page session.
     *
     * @param {*} session
     * @param {Object} targetInfo
     */
    async addTarget(session, targetInfo) {
        if (targetInfo.type === 'page' && !this._mainSession) {
            this._mainSession = session;
        }
    }

    /**
     * Executed after main page load.
     *
     * Strategy:
     *  1. Try to submit form on current page
     *  2. If not found, navigate to candidate newsletter links
     */
    async postLoad() {
        if (!this._mainSession) return;

        let success = await this._attemptFill();

        if (!success) {
            const links = await this._findCandidateLinks();

            for (const link of links) {
                this._result.visitedLinks.push(link);

                await this._mainSession.send('Page.navigate', { url: link });
                await this._sleep(4000);

                success = await this._attemptFill();
                if (success) break;
            }
        }

        if (success) {
            this._result.filled = true;
        }
    }

    /**
     * Returns collector result.
     * @returns {Promise<Object>}
     */
    async getData() {
        return this._result;
    }

    // ===================== PRIVATE METHODS =====================

    /**
     * Searches page for potential newsletter links.
     * @private
     * @returns {Promise<string[]>}
     */
    async _findCandidateLinks() {
        return await this._evaluate(`
            (function(){
                const keywords = ${JSON.stringify(KEYWORDS)};
                return Array.from(document.querySelectorAll('a'))
                    .map(a => a.href)
                    .filter(href => href &&
                        keywords.some(k => href.toLowerCase().includes(k))
                    )
                    .slice(0, ${MAX_LINKS_TO_VISIT});
            })();
        `);
    }

    /**
     * Attempts to detect and submit an email form.
     *
     * - Skips forms containing password fields (login forms)
     * - Fills required selects & checkboxes
     * - Detects captcha presence
     *
     * @private
     * @returns {Promise<boolean>} Whether submission was attempted
     */
    async _attemptFill() {
        const email = this._email;

        const result = await this._evaluate(
            `(async function(){ /* your existing DOM logic here */ })();`,
            true
        );

        if (!result) return false;

        if (result.captchaDetected) {
            this._result.captchaPresent = true;
            this._log('Captcha detected.');
        }

        if (result.success) {
            this._log('Email form submitted.');
            return true;
        }

        return false;
    }

    /**
     * Executes JavaScript inside page context using CDP.
     *
     * @private
     * @param {string} expression
     * @param {boolean} [awaitPromise=false]
     * @returns {Promise<any>}
     */
    async _evaluate(expression, awaitPromise = false) {
        const res = await this._mainSession.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true
        });

        return res && res.result ? res.result.value : undefined;
    }

    /**
     * Async sleep helper.
     * @private
     * @param {number} ms
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = EmailFillCollector;