'use strict';

/**
 * @file loadIdentity.js
 *
 * Loads a fake identity from a JSON file and validates its required fields.
 *
 * ─── How to switch identity ───────────────────────────────────────────────────────────
 *
 *   Edit the single line in  emailHelpers/emailFill.config.json:
 *
 *     { "identity": "identity.james.json" }
 *
 *   The value is a filename inside the identities/ folder. That's it.
 *
 *   Override for a single run via env var (optional, rarely needed):
 *     IDENTITY_FILE=/absolute/path/to/any.json node crawler.js
 *
 * ─── Identity JSON schema ────────────────────────────────────────────────────────────
 *   Required:  email
 *   Optional:  firstName, lastName, fullName, phone, zip, dob,
 *              gender, country, state, freeText
 *
 *   Missing optional fields default to empty string.
 *
 * ─── Resolution order (first wins) ───────────────────────────────────────────────────
 *   1. IDENTITY_FILE environment variable (absolute path)
 *   2. emailFill.config.json  →  identity field  (filename inside identities/)
 *   3. identity.laura.json    (built-in fallback)
 */

const fs   = require('fs');
const path = require('path');

const IDENTITIES_DIR = path.join(__dirname, 'identities');
const CONFIG_FILE    = path.join(IDENTITIES_DIR, 'emailFill.config.json');
const FALLBACK_FILE  = path.join(IDENTITIES_DIR, 'identity.laura.json');

/**
 * @type {string[]}
 */
const REQUIRED_FIELDS = ['email'];

/**
 * @type {{ firstName: string, lastName: string, fullName: string, phone: string,
 *          zip: string, dob: string, gender: string, country: string,
 *          state: string, freeText: string }}
 */
const FIELD_DEFAULTS = {
    firstName : '',
    lastName  : '',
    fullName  : '',
    phone     : '',
    zip       : '',
    dob       : '',
    gender    : '',
    country   : '',
    state     : '',
    freeText  : ''
};

/**
 * Resolve the identity file path from the config, env var, or fallback.
 * Never throws — always returns a path string.
 * @returns {string} Absolute path to the identity JSON file
 */
function resolveIdentityPath() {
    // Priority 1: env var (absolute path, escape hatch for CI / one-off runs)
    if (process.env.IDENTITY_FILE) {
        return process.env.IDENTITY_FILE;
    }

    // Priority 2: emailFill.config.json → identity field (just the filename)
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (config.identity && typeof config.identity === 'string') {
            return path.join(IDENTITIES_DIR, config.identity);
        }
    } catch (_) {
        // Config missing or unreadable — fall through to default
    }

    // Priority 3: built-in fallback
    return FALLBACK_FILE;
}

/**
 * Load and validate an identity JSON file.
 *
 * @returns {{ email: string, firstName: string, lastName: string, fullName: string,
 *             phone: string, zip: string, dob: string, gender: string,
 *             country: string, state: string, freeText: string }}
 * @throws {Error} If the file cannot be read, is not valid JSON, or is missing
 *                 the required 'email' field.
 */
function loadIdentity() {
    const absolute = resolveIdentityPath();

    let raw;
    try {
        raw = fs.readFileSync(absolute, 'utf8');
    } catch (err) {
        throw new Error(
            `[loadIdentity] Cannot read identity file "${absolute}": ${err.message}`
        );
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        throw new Error(
            `[loadIdentity] Identity file "${absolute}" is not valid JSON: ${err.message}`
        );
    }

    for (const field of REQUIRED_FIELDS) {
        if (!data[field] || typeof data[field] !== 'string' || data[field].trim() === '') {
            throw new Error(
                `[loadIdentity] Identity file "${absolute}" is missing required field: "${field}"`
            );
        }
    }

    const identity = {
        email     : String(data.email),
        firstName : data.firstName  !== undefined ? String(data.firstName)  : FIELD_DEFAULTS.firstName,
        lastName  : data.lastName   !== undefined ? String(data.lastName)   : FIELD_DEFAULTS.lastName,
        fullName  : data.fullName   !== undefined ? String(data.fullName)   : FIELD_DEFAULTS.fullName,
        phone     : data.phone      !== undefined ? String(data.phone)      : FIELD_DEFAULTS.phone,
        zip       : data.zip        !== undefined ? String(data.zip)        : FIELD_DEFAULTS.zip,
        dob       : data.dob        !== undefined ? String(data.dob)        : FIELD_DEFAULTS.dob,
        gender    : data.gender     !== undefined ? String(data.gender)     : FIELD_DEFAULTS.gender,
        country   : data.country    !== undefined ? String(data.country)    : FIELD_DEFAULTS.country,
        state     : data.state      !== undefined ? String(data.state)      : FIELD_DEFAULTS.state,
        freeText  : data.freeText   !== undefined ? String(data.freeText)   : FIELD_DEFAULTS.freeText
    };

    return identity;
}

module.exports = loadIdentity;
