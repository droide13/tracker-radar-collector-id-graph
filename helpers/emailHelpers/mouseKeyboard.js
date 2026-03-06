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
 */

const { MOUSE_MOVE_STEPS } = require('./constants');

class MouseKeyboard {

    /**
     * @param {{ session: object, sleep: Function, jitter: Function }} deps
     *   session — CDPSession
     *   sleep   — (ms: number) => Promise<void>
     *   jitter  — (min: number, max: number) => number
     */
    constructor({ session, sleep, jitter }) {
        this._session = session;
        this._sleep   = sleep;
        this._jitter  = jitter;
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // MOUSE MOVEMENT
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Simulate a natural multi-step mouse movement from a jittered origin to (x, y).
     *
     * @param {number} x - Target X coordinate in viewport pixels
     * @param {number} y - Target Y coordinate in viewport pixels
     */
    async _cdpMouseMove(x, y) {
        let curX = x + this._jitter(-80, 80);
        let curY = y + this._jitter(-60, 60);

        for (let i = 0; i < MOUSE_MOVE_STEPS; i++) {
            const t  = (i + 1) / MOUSE_MOVE_STEPS;
            const nx = curX + (x - curX) * t + this._jitter(-3, 3);
            const ny = curY + (y - curY) * t + this._jitter(-3, 3);

            await this._session.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved', x: nx, y: ny, buttons: 0
            });
            await this._sleep(this._jitter(8, 25));
        }
    }

    /**
     * Dispatch a realistic mouse click at (x, y): mousePressed → delay → mouseReleased.
     *
     * @param {number} x
     * @param {number} y
     */
    async _cdpClick(x, y) {
        await this._session.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1
        });
        await this._sleep(this._jitter(40, 120));
        await this._session.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0
        });
    }

    /**
     * Move the mouse to several random positions before form interaction begins.
     * Prevents the first Input event on the page being the form click — a detectable pattern.
     */
    async _randomMouseWander() {
        const points = Array.from({ length: 3 }, () => ({
            x: 200 + Math.random() * 800,
            y: 100 + Math.random() * 400
        }));

        for (const p of points) {
            await this._session.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved', x: p.x, y: p.y, buttons: 0
            });
            await this._sleep(this._jitter(60, 180));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // KEYBOARD INPUT
    // ═══════════════════════════════════════════════════════════════════════════════════

    /**
     * Type a single character using CDP Input events: keyDown → insertText → keyUp.
     *
     * This sequence reproduces what Chrome's renderer emits for a real keystroke:
     *   keydown → beforeinput → input → keyup
     *
     * @param {string} char - A single character to type
     */
    async _cdpTypeChar(char) {
        const code = char.charCodeAt(0);

        await this._session.send('Input.dispatchKeyEvent', {
            type              : 'keyDown',
            key               : char,
            text              : char,
            unmodifiedText    : char,
            windowsVirtualKeyCode: code,
            nativeVirtualKeyCode : code
        });
        await this._session.send('Input.insertText', { text: char });
        await this._session.send('Input.dispatchKeyEvent', {
            type              : 'keyUp',
            key               : char,
            windowsVirtualKeyCode: code,
            nativeVirtualKeyCode : code
        });
    }
}

module.exports = MouseKeyboard;
