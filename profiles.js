'use strict';

/**
 * Coherent fingerprint profile generator.
 *
 * A convincing fingerprint is not a bag of random values — every attribute
 * has to agree with the others (a "Windows" UA with an Apple GPU renderer
 * is an instant flag). `generateProfile` produces a full set of attributes
 * describing one plausible machine, chosen deterministically from a seed.
 */

const mulberry32 = (seed) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const CHROME_MAJOR_VERSIONS = ['124', '125', '126', '127', '128', '129', '130', '131'];

const OS_PROFILES = {
    windows: {
        platform: 'Win32',
        uaPlatform: 'Windows NT 10.0; Win64; x64',
        userAgentDataPlatform: 'Windows',
        userAgentDataPlatformVersion: '15.0.0',
        webglRenderers: [
            'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
            'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
            'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
            'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
            'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        ],
        deviceMemory: [4, 8],
        hardwareConcurrency: [4, 8, 12, 16],
        screens: [
            { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
            { width: 1366, height: 768, availWidth: 1366, availHeight: 728 },
            { width: 1536, height: 864, availWidth: 1536, availHeight: 824 },
            { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400 },
        ],
    },
    mac: {
        platform: 'MacIntel',
        uaPlatform: 'Macintosh; Intel Mac OS X 10_15_7',
        userAgentDataPlatform: 'macOS',
        userAgentDataPlatformVersion: '14.5.0',
        webglRenderers: [
            'ANGLE (Apple, Apple M1, OpenGL 4.1)',
            'ANGLE (Apple, Apple M2, OpenGL 4.1)',
            'ANGLE (Apple, Apple M3, OpenGL 4.1)',
            'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 645, OpenGL 4.1)',
            'ANGLE (AMD, AMD Radeon Pro 5500M OpenGL Engine, OpenGL 4.1)',
        ],
        deviceMemory: [8],
        hardwareConcurrency: [8, 10, 12],
        screens: [
            { width: 1440, height: 900, availWidth: 1440, availHeight: 875 },
            { width: 1680, height: 1050, availWidth: 1680, availHeight: 1025 },
            { width: 1920, height: 1080, availWidth: 1920, availHeight: 1055 },
            { width: 2560, height: 1600, availWidth: 2560, availHeight: 1575 },
        ],
    },
    linux: {
        platform: 'Linux x86_64',
        uaPlatform: 'X11; Linux x86_64',
        userAgentDataPlatform: 'Linux',
        userAgentDataPlatformVersion: '',
        webglRenderers: [
            'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
            'ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)',
            'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti/PCIe/SSE2, OpenGL 4.6)',
        ],
        deviceMemory: [4, 8],
        hardwareConcurrency: [4, 8, 16],
        screens: [
            { width: 1920, height: 1080, availWidth: 1920, availHeight: 1053 },
            { width: 1366, height: 768, availWidth: 1366, availHeight: 741 },
            { width: 2560, height: 1440, availWidth: 2560, availHeight: 1413 },
        ],
    },
};

/**
 * Generates a coherent fingerprint profile.
 *
 * @param {object} [options]
 * @param {'windows' | 'mac' | 'linux'} [options.os] OS family. Default: random.
 * @param {number} [options.seed] Seed for deterministic selection.
 * @param {string} [options.locale] Primary locale. Default: 'en-US'.
 * @returns {object} A plain, JSON-serializable profile.
 */
const generateProfile = (options = {}) => {
    if (options.seed !== undefined && !Number.isInteger(options.seed)) {
        throw new TypeError('playwright-afp: `seed` must be an integer.');
    }
    const random = mulberry32(Number.isInteger(options.seed) ? options.seed : Math.floor(Math.random() * 0x7fffffff));
    const pick = (arr) => arr[Math.floor(random() * arr.length)];

    const os = options.os || pick(Object.keys(OS_PROFILES));
    const base = OS_PROFILES[os];
    if (!base) {
        throw new TypeError(`playwright-afp: unknown os "${os}" — expected one of: ${Object.keys(OS_PROFILES).join(', ')}.`);
    }

    const major = pick(CHROME_MAJOR_VERSIONS);
    const fullVersion = `${major}.0.0.0`;
    const locale = options.locale || 'en-US';
    const screen = { ...pick(base.screens), colorDepth: 24, pixelDepth: 24 };

    return {
        os,
        userAgent:
            `Mozilla/5.0 (${base.uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
            `Chrome/${fullVersion} Safari/537.36`,
        platform: base.platform,
        vendor: 'Google Inc.',
        languages: [locale, locale.split('-')[0]],
        userAgentData: {
            brands: [
                { brand: 'Not/A)Brand', version: '8' },
                { brand: 'Chromium', version: major },
                { brand: 'Google Chrome', version: major },
            ],
            mobile: false,
            platform: base.userAgentDataPlatform,
            platformVersion: base.userAgentDataPlatformVersion,
            fullVersion,
        },
        screen,
        deviceMemory: pick(base.deviceMemory),
        hardwareConcurrency: pick(base.hardwareConcurrency),
        webgl: {
            vendor: 'Google Inc.',
            renderer: pick(base.webglRenderers),
        },
    };
};

module.exports = { generateProfile, OS_PROFILES };
