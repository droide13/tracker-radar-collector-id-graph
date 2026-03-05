const BaseCollector = require('./BaseCollector');
const chromeHar = require('chrome-har');

// Every CDP event chrome-har needs to reconstruct a complete HAR
const OBSERVED_EVENTS = [
    // Page lifecycle
    'Page.loadEventFired',
    'Page.domContentEventFired',
    'Page.frameStartedLoading',
    'Page.frameRequestedNavigation',
    'Page.frameAttached',
    'Page.frameNavigated',
    'Page.frameDetached',

    // Core network
    'Network.requestWillBeSent',
    'Network.requestServedFromCache',
    'Network.dataReceived',
    'Network.responseReceived',
    'Network.resourceChangedPriority',
    'Network.loadingFinished',
    'Network.loadingFailed',

    // ExtraInfo events — carry actual Cookie / Set-Cookie headers
    'Network.requestWillBeSentExtraInfo',
    'Network.responseReceivedExtraInfo',

    // WebSockets
    'Network.webSocketCreated',
    'Network.webSocketFrameSent',
    'Network.webSocketFrameReceived',
    'Network.webSocketClosed',
];

class HarCollector extends BaseCollector {
    id() {
        return 'har';
    }

    /**
     * Initialise state before any target is added.
     */
    init() {
        /** @type {Array<{method: string, params: object}>} */
        this._events = [];

        /**
         * Map of requestId -> response body fetched after loadingFinished.
         * @type {Map<string, {body: string, base64Encoded: boolean}>}
         */
        this._responseBodies = new Map();
    }

    /**
     * @param {import('puppeteer-core').CDPSession} session
     * @param {import('devtools-protocol/types/protocol').Protocol.Target.TargetInfo} targetInfo
     */
    addTarget(session, targetInfo) {
        if (targetInfo.type !== 'page') {
            return;
        }

        this._cdpClient = session;

        // Record every observed event into the event log
        for (const method of OBSERVED_EVENTS) {
            session.on(method, (params) => {
                this._events.push({ method, params });
            });
        }

        // When a request finishes loading, immediately fetch its response body
        // while Chrome still has it buffered. We store it keyed by requestId
        // so we can stitch it back into the HAR entries later.
        session.on('Network.loadingFinished', async ({ requestId }) => {
            try {
                const result = await session.send('Network.getResponseBody', { requestId });
                if (result && result.body) {
                    this._responseBodies.set(requestId, {
                        body: result.body,
                        base64Encoded: result.base64Encoded || false,
                    });
                }
            } catch {
                // Body unavailable (e.g. cached, redirected, no-body responses) — safe to ignore
            }
        });
    }

    /**
     * Enable CDP domains with generous buffer sizes so Chrome retains
     * response bodies long enough for us to fetch them.
     *
     * @returns {Promise<void>}
     */
    async addSessionEvents() {
        if (!this._cdpClient) {
            return;
        }
        await Promise.all([
            this._cdpClient.send('Page.enable'),
            this._cdpClient.send('Network.enable', {
                // Allow up to 100 MB total / 10 MB per resource in Chrome's buffer
                maxTotalBufferSize: 100_000_000,
                maxResourceBufferSize: 10_000_000,
            }),
        ]);
    }

    /**
     * Build and return the complete HAR object.
     *
     * @returns {Promise<HARData|null>}
     */
    async getData() {
        if (!this._cdpClient) {
            return null;
        }

        // Disable network to flush any in-flight events before we build the HAR
        await this._cdpClient.send('Network.disable');

        const har = chromeHar.harFromMessages(this._events, {
            includeTextFromResponseBody: true,
            includeResourcesFromDiskCache: true,
        });

        // Stitch response bodies into each HAR entry
        // chrome-har exposes _requestId as a non-standard field on each entry
        for (const entry of har.log.entries) {
            const requestId = entry._requestId;
            if (!requestId) {
                continue;
            }

            const stored = this._responseBodies.get(requestId);
            if (!stored) {
                continue;
            }

            const { body, base64Encoded } = stored;

            // Ensure the response.content object exists
            if (!entry.response.content) {
                entry.response.content = {};
            }

            if (base64Encoded) {
                entry.response.content.encoding = 'base64';
                entry.response.content.text = body;
            } else {
                entry.response.content.text = body;
            }

            entry.response.content.size = entry.response.content.size ||
                Buffer.byteLength(body, base64Encoded ? 'base64' : 'utf8');
        }

        return har;
    }
}

module.exports = HarCollector;

/**
 * @typedef {object} HARData
 * @property {{ version: string, creator: object, pages: HARPage[], entries: HAREntry[] }} log
 */

/**
 * @typedef {object} HARPage
 * @property {string} startedDateTime
 * @property {string} id
 * @property {string} title
 * @property {{ send: number, receive: number, wait: number, onContentLoad: number, onLoad: number, _transferSize: number }} pageTimings
 */

/**
 * @typedef {object} HAREntry
 * @property {string} startedDateTime
 * @property {number} time
 * @property {object} request
 * @property {object} response
 * @property {object} cache
 * @property {object} timings
 * @property {string=} serverIPAddress
 * @property {string=} connection
 * @property {string=} pageref
 * @property {string=} _requestId
 */