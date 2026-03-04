'use strict';

const BaseCollector = require('./BaseCollector');
const { Buffer } = require('buffer');

/**
 * @import {Protocol} from 'devtools-protocol';
 * @import {CDPSession} from 'puppeteer-core';
 */

/**
 * Eventos CDP necesarios para generar HAR
 */
const PAGE_EVENTS = [
    'Page.loadEventFired',
    'Page.domContentEventFired',
];

const NETWORK_EVENTS = [
    'Network.requestWillBeSent',
    'Network.responseReceived',
    'Network.loadingFinished',
    'Network.loadingFailed',
];

/**
 * @typedef {object} HarEntry
 * @property {Protocol.Network.RequestId} id
 * @property {string} url
 * @property {string} method
 * @property {Protocol.Network.ResourceType} type
 * @property {Protocol.Runtime.Timestamp=} startTime
 * @property {Protocol.Runtime.Timestamp=} endTime
 * @property {number=} status
 * @property {Object<string,string>=} requestHeaders
 * @property {Object<string,string>=} responseHeaders
 * @property {string=} responseBody
 * @property {boolean=} failed
 */

/**
 * Collector that builds a HAR (HTTP Archive) structure
 * directly from Chrome DevTools Protocol events.
 *
 * This implementation mirrors the behavior of chrome-har,
 * but is built internally to respect the Crawler → Collector → Reporter architecture.
 *
 * It does NOT depend on Puppeteer Page objects,
 * only on CDPSession like other collectors.
 *
 * @extends BaseCollector
 */
class HarCollector extends BaseCollector {

    /**
     * @param {{ saveResponseBodies?: boolean }} options
     */
    constructor(options = {}) {
        super();

        /**
         * Whether response bodies should be embedded in HAR.
         * @type {boolean}
         * @private
         */
        this._saveResponseBodies = options.saveResponseBodies === true;
    }

    /**
     * Unique collector ID
     * @returns {string}
     */
    id() {
        return 'harCollector';
    }

    /**
     * Initializes collector state.
     *
     * @param {import('./BaseCollector').CollectorInitOptions} options
     */
    init({ log }) {
        /**
         * @type {HarEntry[]}
         * @private
         */
        this._entries = [];

        /**
         * @type {Map<Protocol.Network.RequestId, HarEntry>}
         * @private
         */
        this._requests = new Map();

        /**
         * Logger from crawler
         * @private
         */
        this._log = log;

        /**
         * @type {CDPSession}
         * @private
         */
        this._cdp = null;
    }

    /**
     * Attaches to a page target and subscribes to CDP events.
     *
     * @param {CDPSession} session
     * @param {Protocol.Target.TargetInfo} targetInfo
     */
    async addTarget(session, targetInfo) {
        if (targetInfo.type !== 'page') {
            return;
        }

        this._cdp = session;

        await session.send('Page.enable');
        await session.send('Network.enable');

        for (const event of NETWORK_EVENTS) {
            session.on(event, (data) => this._handleNetworkEvent(event, data));
        }

        for (const event of PAGE_EVENTS) {
            session.on(event, () => {
                // Page-level timing events could be added here if needed
            });
        }
    }

    /**
     * Routes network events.
     *
     * @param {string} event
     * @param {any} data
     * @private
     */
    async _handleNetworkEvent(event, data) {
        switch (event) {
            case 'Network.requestWillBeSent':
                return this._handleRequest(data);

            case 'Network.responseReceived':
                return this._handleResponse(data);

            case 'Network.loadingFinished':
                return this._handleFinished(data);

            case 'Network.loadingFailed':
                return this._handleFailed(data);
        }
    }

    /**
     * Handles request start.
     *
     * @param {Protocol.Network.RequestWillBeSentEvent} data
     * @private
     */
    _handleRequest(data) {
        const entry = {
            id: data.requestId,
            url: data.request.url,
            method: data.request.method,
            type: data.type,
            startTime: data.timestamp,
            requestHeaders: data.request.headers,
        };

        this._requests.set(data.requestId, entry);
        this._entries.push(entry);
    }

    /**
     * Handles response metadata.
     *
     * @param {Protocol.Network.ResponseReceivedEvent} data
     * @private
     */
    _handleResponse(data) {
        const entry = this._requests.get(data.requestId);
        if (!entry) return;

        entry.status = data.response.status;
        entry.responseHeaders = data.response.headers;
    }

    /**
     * Handles successful request completion.
     *
     * @param {Protocol.Network.LoadingFinishedEvent} data
     * @private
     */
    async _handleFinished(data) {
        const entry = this._requests.get(data.requestId);
        if (!entry) return;

        entry.endTime = data.timestamp;

        if (this._saveResponseBodies) {
            try {
                // @ts-ignore oversimplified signature
                const { body, base64Encoded } = await this._cdp.send(
                    'Network.getResponseBody',
                    { requestId: data.requestId }
                );

                entry.responseBody = base64Encoded
                    ? Buffer.from(body, 'base64').toString('utf-8')
                    : body;
            } catch {
                // Bodies may not be retrievable after navigation commit
            }
        }
    }

    /**
     * Handles failed requests.
     *
     * @param {Protocol.Network.LoadingFailedEvent} data
     * @private
     */
    _handleFailed(data) {
        const entry = this._requests.get(data.requestId);
        if (!entry) return;

        entry.endTime = data.timestamp;
        entry.failed = true;
    }

    /**
     * Returns full HAR object.
     *
     * @returns {{ log: { version: string, creator: object, entries: object[] } }}
     */
    getData() {
        const entries = this._entries.map((e) => ({
            startedDateTime: e.startTime ? new Date(e.startTime * 1000).toISOString() : undefined,
            time: e.startTime && e.endTime ? (e.endTime - e.startTime) * 1000 : undefined,
            request: {
                method: e.method,
                url: e.url,
                headers: this._headersToHarArray(e.requestHeaders),
            },
            response: {
                status: e.status,
                headers: this._headersToHarArray(e.responseHeaders),
                content: {
                    text: e.responseBody,
                },
            },
        }));

        return {
            log: {
                version: '1.2',
                creator: {
                    name: 'Custom HarCollector',
                    version: '1.0.0',
                },
                entries,
            },
        };
    }

    /**
     * Converts header object into HAR array format.
     *
     * @param {Object<string,string>} headers
     * @returns {{name:string,value:string}[]}
     * @private
     */
    _headersToHarArray(headers = {}) {
        return Object.entries(headers).map(([name, value]) => ({
            name,
            value: String(value),
        }));
    }
}

module.exports = HarCollector;