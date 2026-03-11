'use strict';

/**
 * @file mouseKeyboard.js
 *
 * MouseKeyboard — human-like mouse movement and keyboard input simulation over CDP.
 *
 * Receives { session, sleep, jitter } from the collector. No base class.
 *
 * ─── CDP vs Puppeteer page.type() ───────────────────────────────────────────────────
 *   page.type() uses Input.insertText internally, injecting characters without
 *   generating keyDown/keyUp events. This is a detectable fingerprinting signal.
 *
 *   This class dispatches keyDown → insertText → keyUp for each character, which
 *   matches the event sequence Chrome's renderer produces from a real keyboard:
 *     keydown → beforeinput → input → keyup
 *
 *   windowsVirtualKeyCode is included even on non-Windows platforms because Chrome
 *   uses it as a cross-platform key identifier for many internal input handlers.
 *
 * ─── Mouse path realism ──────────────────────────────────────────────────────────────
 *   Current: linear interpolation with per-step noise.
 *   TODO: replace with a cubic Bezier curve (two offset control points) and an
 *   ease-in-out speed profile for more realistic deceleration near the target.
 *
 * ─── Renderer crash guard ────────────────────────────────────────────────────────────
 *   On Windows, Chrome's renderer can die with STATUS_ACCESS_VIOLATION when CDP
 *   Input events are dispatched into elements backed by partially GC'd ad/tracking
 *   iframes. All methods return false on crash rather than throwing, so the caller
 *   can handle gracefully. No logging here — only emailFillCollector logs.
 */

const { MOUSE_MOVE_STEPS } = require('./emailConstants');

// Error message fragments that indicate a renderer crash or detached session.
const CRASH_SIGNALS = [
    'STATUS_ACCESS_VIOLATION',
    'Target closed',
    'Session closed',
    'No session with given id',
    'Target.detachedFromTarget',
    'Protocol error',
    'Connection closed',
    'ProtocolError',
];

class MouseKeyboard {

    /**
     * @param {{ session: object, sleep: Function, jitter: Function }} deps
     */
    constructor({ session, sleep, jitter }) {
        this._session = session;
        this._sleep   = sleep;
        this._jitter  = jitter;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // SESSION LIVENESS
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Probe the session with a cheap no-op evaluate.
     * Returns false if the renderer has crashed or the session is detached.
     * Called before any multi-step input sequence to avoid firing CDP events
     * into a dead renderer, which triggers STATUS_ACCESS_VIOLATION on Windows.
     *
     * @returns {Promise<boolean>}
     */
    async _isSessionAlive() {
        try {
            await this._session.send('Runtime.evaluate', {
                expression   : '1',
                returnByValue: true,
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @param {Error} err
     * @returns {boolean}
     */
    _isCrashError(err) {
        const msg = err?.message || err?.toString() || '';
        return CRASH_SIGNALS.some(s => msg.includes(s));
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // MOUSE MOVEMENT
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Simulate a natural multi-step mouse movement to (x, y).
     *
     * @param {number} x
     * @param {number} y
     * @returns {Promise<boolean>} false on renderer crash
     */
    async _cdpMouseMove(x, y) {
        if (!await this._isSessionAlive()) return false;

        const curX = x + this._jitter(-80, 80);
        const curY = y + this._jitter(-60, 60);

        for (let i = 0; i < MOUSE_MOVE_STEPS; i++) {
            const t  = (i + 1) / MOUSE_MOVE_STEPS;
            const nx = curX + (x - curX) * t + this._jitter(-3, 3);
            const ny = curY + (y - curY) * t + this._jitter(-3, 3);

            try {
                await this._session.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved', x: nx, y: ny, buttons: 0,
                });
            } catch (err) {
                if (this._isCrashError(err)) return false;
                throw err;
            }
            await this._sleep(this._jitter(8, 25));
        }

        return true;
    }

    /**
     * Dispatch a realistic mouse click at (x, y): mousePressed → delay → mouseReleased.
     *
     * @param {number} x
     * @param {number} y
     * @returns {Promise<boolean>} false on renderer crash
     */
    async _cdpClick(x, y) {
        if (!await this._isSessionAlive()) return false;

        try {
            await this._session.send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
            });
            await this._sleep(this._jitter(40, 120));
            await this._session.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0,
            });
            return true;
        } catch (err) {
            if (this._isCrashError(err)) return false;
            throw err;
        }
    }

    /**
     * Move the mouse to several random positions before form interaction begins.
     * Prevents the first Input event on the page being the form click.
     *
     * @returns {Promise<boolean>} false on renderer crash
     */
    async _randomMouseWander() {
        if (!await this._isSessionAlive()) return false;

        const points = Array.from({ length: 3 }, () => ({
            x: 200 + Math.random() * 800,
            y: 100 + Math.random() * 400,
        }));

        for (const p of points) {
            try {
                await this._session.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved', x: p.x, y: p.y, buttons: 0,
                });
            } catch (err) {
                if (this._isCrashError(err)) return false;
                throw err;
            }
            await this._sleep(this._jitter(60, 180));
        }

        return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // KEYBOARD INPUT
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Type a single character using CDP Input events: keyDown → insertText → keyUp.
     *
     * @param {string} char
     * @returns {Promise<boolean>} false on renderer crash
     */
    async _cdpTypeChar(char) {
        const code = char.charCodeAt(0);

        try {
            await this._session.send('Input.dispatchKeyEvent', {
                type                 : 'keyDown',
                key                  : char,
                text                 : char,
                unmodifiedText       : char,
                windowsVirtualKeyCode: code,
                nativeVirtualKeyCode : code,
            });
            await this._session.send('Input.insertText', { text: char });
            await this._session.send('Input.dispatchKeyEvent', {
                type                 : 'keyUp',
                key                  : char,
                windowsVirtualKeyCode: code,
                nativeVirtualKeyCode : code,
            });
            return true;
        } catch (err) {
            if (this._isCrashError(err)) return false;
            throw err;
        }
    }
}

module.exports = MouseKeyboard;