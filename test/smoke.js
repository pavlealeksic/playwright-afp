'use strict';

/**
 * Smoke test: launches a real Chromium and verifies that the protections
 * work and are deterministic for a given seed.
 *
 * Requires: npm install && npx playwright install chromium
 */

const assert = require('assert');
const { chromium } = require('playwright');
const protectIt = require('../index.js');

const SEED = 42;

const collectFingerprint = () => {
    const out = {};
    out.webdriver = navigator.webdriver;
    out.deviceMemory = navigator.deviceMemory;
    out.hardwareConcurrency = navigator.hardwareConcurrency;
    out.userAgent = navigator.userAgent;
    out.appVersion = navigator.appVersion;
    out.platform = navigator.platform;
    out.vendor = navigator.vendor;
    out.languages = Array.from(navigator.languages || []);
    out.uaData = navigator.userAgentData
        ? { platform: navigator.userAgentData.platform, mobile: navigator.userAgentData.mobile }
        : null;
    out.screen = {
        width: screen.width,
        height: screen.height,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
    };
    out.outerWidth = window.outerWidth;
    out.pluginsLength = navigator.plugins.length;
    out.pluginsFirst = navigator.plugins[0] ? navigator.plugins[0].name : null;
    out.mimeTypesLength = navigator.mimeTypes.length;
    out.rtcPeerConnection = typeof RTCPeerConnection;
    out.getUserMedia = navigator.mediaDevices ? typeof navigator.mediaDevices.getUserMedia : 'n/a';
    out.toDataURLToString = HTMLCanvasElement.prototype.toDataURL.toString();

    const render = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 50;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#f60';
        ctx.fillRect(0, 0, 100, 50);
        ctx.fillStyle = '#069';
        ctx.font = '16px Arial';
        ctx.fillText('fingerprint', 2, 20);
        return canvas.toDataURL();
    };
    out.canvasA = render();
    out.canvasB = render();

    // OffscreenCanvas
    try {
        const off = new OffscreenCanvas(64, 32);
        const octx = off.getContext('2d');
        octx.fillStyle = '#069';
        octx.fillRect(0, 0, 64, 32);
        out.offscreen = octx.getImageData(0, 0, 64, 32).data.slice(0, 8).join(',');
    } catch (e) {
        out.offscreen = 'unavailable';
    }

    const el = document.createElement('div');
    el.style.cssText = 'width:100px;height:100px;position:absolute;';
    document.body.appendChild(el);
    out.offsetWidth = el.offsetWidth;

    const ctx2d = document.createElement('canvas').getContext('2d');
    out.measureTextWidth = ctx2d.measureText('fingerprint').width;

    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
        out.glVendor = gl.getParameter(37445);
        out.glRenderer = gl.getParameter(37446);
        out.glVersion = gl.getParameter(7938);
        out.glMaxTexture = gl.getParameter(3379);
        out.glGetParameterToString = gl.getParameter.toString();
    }
    return out;
};

const fingerprintInContext = async (browser, options, contextOptions = {}) => {
    const context = await browser.newContext(contextOptions);
    const seed = await protectIt(context, options);
    const page = await context.newPage();
    await page.goto('data:text/html,<html><body></body></html>');
    const fp = await page.evaluate(collectFingerprint);
    if (fp.uaData) {
        fp.uaHighEntropy = await page.evaluate(() =>
            navigator.userAgentData.getHighEntropyValues(['platform', 'uaFullVersion']).then((v) => ({
                platform: v.platform,
                uaFullVersion: v.uaFullVersion,
            }))
        );
    }
    fp.notificationState = await page.evaluate(() =>
        navigator.permissions.query({ name: 'notifications' }).then((r) => r.state)
    );
    await context.close();
    return { seed, fp };
};

(async () => {
    // Profile generator: pure node-side checks.
    {
        const p1 = protectIt.generateProfile({ os: 'windows', seed: 7 });
        const p2 = protectIt.generateProfile({ os: 'windows', seed: 7 });
        assert.deepStrictEqual(p1, p2, 'same seed must produce the same profile');
        assert.ok(p1.userAgent.includes('Windows NT 10.0'), 'windows UA');
        assert.strictEqual(p1.platform, 'Win32');
        assert.ok(p1.userAgentData.brands.some((b) => b.brand === 'Google Chrome'));
        assert.ok(p1.webgl.renderer.startsWith('ANGLE ('), 'modern ANGLE renderer string');
        assert.throws(() => protectIt.generateProfile({ os: 'beos' }), TypeError);
        assert.throws(() => protectIt.generateProfile({ seed: 'x' }), TypeError);
    }

    const browser = await chromium.launch();

    // Baseline vs protected.
    {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto('data:text/html,<html><body></body></html>');
        const plain = await page.evaluate(collectFingerprint);
        await context.close();

        const { seed, fp } = await fingerprintInContext(browser, {
            seed: SEED,
            webRTC: true,
            deviceMemory: 8,
            hardwareConcurrency: 8,
            plugins: true,
        });

        assert.strictEqual(seed, SEED, 'protectIt resolves with the seed in use');
        assert.strictEqual(fp.webdriver, undefined, 'navigator.webdriver must be hidden');
        assert.strictEqual(fp.deviceMemory, 8, 'deviceMemory spoofed');
        assert.strictEqual(fp.hardwareConcurrency, 8, 'hardwareConcurrency spoofed');
        assert.strictEqual(fp.rtcPeerConnection, 'undefined', 'RTCPeerConnection must be removed');
        assert.notStrictEqual(fp.getUserMedia, 'function', 'getUserMedia must be removed or absent');
        assert.ok(
            fp.toDataURLToString.includes('[native code]'),
            `patched toDataURL must look native, got: ${fp.toDataURLToString}`
        );
        assert.notStrictEqual(fp.canvasA, plain.canvasA, 'canvas fingerprint must differ from unprotected');
        assert.strictEqual(fp.canvasA, fp.canvasB, 'canvas fingerprint must be stable within a session');
        assert.strictEqual(fp.pluginsLength, 5, 'five PDF plugins faked');
        assert.strictEqual(fp.pluginsFirst, 'PDF Viewer');
        assert.strictEqual(fp.mimeTypesLength, 2, 'mimeTypes faked');
        assert.ok(['default', 'prompt', 'denied'].includes(fp.notificationState), 'permissions.query resolves');

        if (fp.glVendor) {
            assert.strictEqual(fp.glVendor, 'Google Inc.', 'WebGL vendor spoofed');
            assert.ok(fp.glRenderer.startsWith('ANGLE ('), `modern ANGLE renderer, got: ${fp.glRenderer}`);
            assert.strictEqual(fp.glVersion, 'WebGL 1.0 (OpenGL ES 2.0 Chromium)', 'modern WebGL version string');
            assert.ok(fp.glGetParameterToString.includes('[native code]'), 'patched getParameter must look native');
        }
    }

    // Profile: navigator + screen coherence.
    {
        const profile = protectIt.generateProfile({ os: 'windows', seed: SEED });
        const { fp } = await fingerprintInContext(
            browser,
            { profile, seed: SEED },
            { userAgent: profile.userAgent }
        );
        assert.strictEqual(fp.userAgent, profile.userAgent, 'navigator.userAgent matches the profile');
        assert.strictEqual(fp.platform, 'Win32', 'platform matches the profile');
        assert.strictEqual(fp.vendor, 'Google Inc.');
        assert.deepStrictEqual(fp.languages, profile.languages);
        assert.ok(fp.uaData, 'userAgentData present');
        assert.strictEqual(fp.uaData.platform, 'Windows', 'client hints platform matches');
        assert.strictEqual(fp.uaHighEntropy.platform, 'Windows', 'high-entropy platform matches');
        assert.ok(fp.uaHighEntropy.uaFullVersion.startsWith(profile.userAgentData.fullVersion.slice(0, 3)));
        assert.strictEqual(fp.screen.width, profile.screen.width, 'screen matches the profile');
        assert.strictEqual(fp.screen.availHeight, profile.screen.availHeight);
        assert.strictEqual(fp.screen.colorDepth, 24);
        assert.ok(fp.outerWidth > 0, 'outerWidth must not be 0');
        assert.strictEqual(fp.deviceMemory, profile.deviceMemory);
        assert.strictEqual(fp.hardwareConcurrency, profile.hardwareConcurrency);
        if (fp.glRenderer) {
            assert.strictEqual(fp.glRenderer, profile.webgl.renderer, 'WebGL renderer matches the profile');
        }
        // appVersion must not contain the headless marker
        assert.ok(!fp.appVersion.includes('Headless'), 'appVersion must not contain Headless');
    }

    // navigator: true strips the headless marker from the real UA.
    {
        const { fp } = await fingerprintInContext(browser, { navigator: true });
        assert.ok(!fp.userAgent.includes('HeadlessChrome'), 'headless marker stripped from UA');
    }

    // Determinism: same seed in a fresh context → identical fingerprint.
    {
        const first = await fingerprintInContext(browser, { seed: SEED });
        const second = await fingerprintInContext(browser, { seed: SEED });
        assert.strictEqual(first.fp.canvasA, second.fp.canvasA, 'same seed must reproduce the canvas fingerprint');
        if (first.fp.glMaxTexture) {
            assert.strictEqual(first.fp.glMaxTexture, second.fp.glMaxTexture, 'same seed must reproduce WebGL params');
        }

        const other = await fingerprintInContext(browser, { seed: SEED + 1 });
        assert.notStrictEqual(first.fp.canvasA, other.fp.canvasA, 'different seed must change the fingerprint');
    }

    // Legacy 0.0.x option names still work.
    {
        const { fp } = await fingerprintInContext(browser, {
            canvasRgba: [1, 1, 1, 0],
            webglData: { 3379: 16384 },
            webRTCProtect: true,
        });
        if (fp.glMaxTexture) {
            assert.strictEqual(fp.glMaxTexture, 16384, 'legacy webglData override must apply');
        }
        assert.strictEqual(fp.rtcPeerConnection, 'undefined', 'legacy webRTCProtect must apply');
    }

    // Bad input throws helpful errors.
    await assert.rejects(() => protectIt(null), TypeError);
    await assert.rejects(() => protectIt({}), TypeError);
    assert.throws(() => protectIt.generateProfile({ seed: 1.5 }), TypeError);

    await browser.close();
    console.log('All smoke tests passed.');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
