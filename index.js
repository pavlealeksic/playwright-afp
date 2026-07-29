'use strict';

/**
 * playwright-afp — anti-fingerprint protection for Playwright pages and
 * browser contexts.
 *
 * Injects an init script that neutralizes the most common fingerprinting
 * and headless-detection vectors: canvas (incl. OffscreenCanvas), WebGL,
 * AudioContext, font measurement, WebRTC, navigator identity, screen
 * geometry, plugins, permissions and `navigator.webdriver`.
 *
 * All noise is derived from a seeded PRNG, so a fingerprint stays stable
 * for the whole session and can be reproduced later by reusing the seed.
 *
 * Usage:
 *   const protectIt = require('playwright-afp');
 *   const profile = protectIt.generateProfile({ os: 'windows', seed: 123 });
 *   const context = await browser.newContext({ userAgent: profile.userAgent });
 *   const seed = await protectIt(context, { profile, seed: 123 });
 */

const { generateProfile } = require('./profiles');

const randomSeed = () => Math.floor(Math.random() * 0x7fffffff);

const assertType = (condition, message) => {
    if (!condition) throw new TypeError(`playwright-afp: ${message}`);
};

/**
 * Normalizes user options into the serializable config passed into the
 * page. Accepts the <= 0.0.3 option names for backward compatibility.
 */
const normalizeOptions = (options = {}) => {
    assertType(options && typeof options === 'object', '`options` must be an object.');
    const opts = { ...options };

    // Backward compatibility with <= 0.0.3 option names.
    if (opts.canvasRgba !== undefined && opts.canvas === undefined) opts.canvas = { rgba: opts.canvasRgba };
    if (opts.webglData !== undefined && opts.webgl === undefined) opts.webgl = { data: opts.webglData };
    if (opts.fontFingerprint !== undefined && opts.fonts === undefined) opts.fonts = opts.fontFingerprint;
    if (opts.audioFingerprint !== undefined && opts.audio === undefined) opts.audio = true;
    if (opts.webRTCProtect !== undefined && opts.webRTC === undefined) opts.webRTC = opts.webRTCProtect;

    assertType(opts.seed === undefined || Number.isInteger(opts.seed), '`seed` must be an integer.');
    const seed = Number.isInteger(opts.seed) ? opts.seed : randomSeed();

    // A profile supplies coherent defaults; explicit options win.
    let profile = null;
    if (opts.profile !== undefined && opts.profile !== null) {
        profile = typeof opts.profile === 'string' ? generateProfile({ os: opts.profile, seed }) : opts.profile;
        assertType(profile && typeof profile === 'object', '`profile` must be a profile object or an OS name.');
    }

    // WebGL: merge the profile's vendor/renderer into the data map.
    let webgl = opts.webgl === undefined ? true : opts.webgl;
    if (webgl && profile && profile.webgl) {
        const data = { ...(webgl.data || {}) };
        if (data[37445] === undefined) data[37445] = profile.webgl.vendor;
        if (data[37446] === undefined) data[37446] = profile.webgl.renderer;
        webgl = { ...(typeof webgl === 'object' ? webgl : {}), data };
    }

    return {
        seed,
        canvas: opts.canvas === undefined ? true : opts.canvas,
        webgl,
        audio: opts.audio === undefined ? true : opts.audio,
        fonts: opts.fonts === undefined ? true : opts.fonts,
        webRTC: opts.webRTC === undefined ? false : opts.webRTC,
        webdriver: opts.webdriver === undefined ? true : opts.webdriver,
        navigator:
            opts.navigator !== undefined
                ? opts.navigator
                : profile
                  ? {
                        userAgent: profile.userAgent,
                        platform: profile.platform,
                        vendor: profile.vendor,
                        languages: profile.languages,
                        userAgentData: profile.userAgentData,
                    }
                  : false,
        screen: opts.screen !== undefined ? opts.screen : profile ? profile.screen : false,
        plugins: opts.plugins === undefined ? false : opts.plugins,
        permissions: opts.permissions === undefined ? true : opts.permissions,
        deviceMemory:
            opts.deviceMemory === undefined ? (profile ? profile.deviceMemory : false) : opts.deviceMemory,
        hardwareConcurrency:
            opts.hardwareConcurrency === undefined
                ? profile
                    ? profile.hardwareConcurrency
                    : false
                : opts.hardwareConcurrency,
    };
};

/**
 * This function is serialized and executed inside the browser. It must be
 * fully self-contained: everything it needs has to come through `config`.
 */
const afpInitScript = (config) => {
    'use strict';

    // ---------------------------------------------------------------------
    // Seeded PRNG (mulberry32) — makes every spoofed value deterministic.
    // ---------------------------------------------------------------------
    let state = config.seed >>> 0;
    const random = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const randomInt = (min, max) => min + Math.floor(random() * (max - min + 1));
    const pick = (arr) => arr[Math.floor(random() * arr.length)];
    const pow2 = (exponents) => Math.pow(2, pick(exponents));

    // ---------------------------------------------------------------------
    // Helpers: property definition and proxy wrapping that survives
    // Function.prototype.toString inspection.
    // ---------------------------------------------------------------------
    const spoofedFns = new WeakMap();

    Function.prototype.toString = new Proxy(Function.prototype.toString, {
        apply(target, self, args) {
            const original = spoofedFns.get(self);
            return original
                ? 'function ' + (original.name || '') + '() { [native code] }'
                : Reflect.apply(target, self, args);
        },
    });

    const wrap = (original, applyTrap) => {
        const proxy = new Proxy(original, { apply: applyTrap });
        spoofedFns.set(proxy, original);
        return proxy;
    };
    spoofedFns.set(Function.prototype.toString, Function.prototype.toString);

    const define = (obj, prop, value) => {
        try {
            Object.defineProperty(obj, prop, { configurable: true, writable: true, value });
        } catch (e) {
            /* non-configurable property — leave it alone */
        }
    };

    const defineGetter = (obj, prop, get) => {
        try {
            Object.defineProperty(obj, prop, { configurable: true, get });
        } catch (e) {
            /* non-configurable property — leave it alone */
        }
    };

    // ---------------------------------------------------------------------
    // Canvas: shift every pixel by a fixed per-session RGBA offset.
    // Applied at most once per canvas so repeated reads stay consistent.
    // Covers both HTMLCanvasElement and OffscreenCanvas.
    // ---------------------------------------------------------------------
    if (config.canvas) {
        const rgba = config.canvas.rgba;
        const shift = {
            r: rgba ? rgba[0] | 0 : randomInt(-5, 5),
            g: rgba ? rgba[1] | 0 : randomInt(-5, 5),
            b: rgba ? rgba[2] | 0 : randomInt(-5, 5),
            a: rgba ? rgba[3] | 0 : randomInt(-5, 5),
        };

        const makeNoisifier = (originalGetImageData) => {
            const noisified = new WeakSet();
            return (canvas, ctx) => {
                if (!ctx || noisified.has(canvas)) return;
                const { width, height } = canvas;
                if (!width || !height) return;
                noisified.add(canvas);

                const imageData = Reflect.apply(originalGetImageData, ctx, [0, 0, width, height]);
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    data[i] += shift.r;
                    data[i + 1] += shift.g;
                    data[i + 2] += shift.b;
                    data[i + 3] += shift.a;
                }
                ctx.putImageData(imageData, 0, 0);
            };
        };

        const getImageData2d = CanvasRenderingContext2D.prototype.getImageData;
        const noisify2d = makeNoisifier(getImageData2d);

        HTMLCanvasElement.prototype.toBlob = wrap(HTMLCanvasElement.prototype.toBlob, (target, self, args) => {
            noisify2d(self, self.getContext('2d'));
            return Reflect.apply(target, self, args);
        });

        HTMLCanvasElement.prototype.toDataURL = wrap(HTMLCanvasElement.prototype.toDataURL, (target, self, args) => {
            noisify2d(self, self.getContext('2d'));
            return Reflect.apply(target, self, args);
        });

        CanvasRenderingContext2D.prototype.getImageData = wrap(getImageData2d, (target, self, args) => {
            noisify2d(self.canvas, self);
            return Reflect.apply(target, self, args);
        });

        if (typeof OffscreenCanvas !== 'undefined' && typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
            const offscreenGetImageData = OffscreenCanvasRenderingContext2D.prototype.getImageData;
            const noisifyOffscreen = makeNoisifier(offscreenGetImageData);

            OffscreenCanvas.prototype.convertToBlob = wrap(OffscreenCanvas.prototype.convertToBlob, (t, self, a) => {
                noisifyOffscreen(self, self.getContext('2d'));
                return Reflect.apply(t, self, a);
            });

            OffscreenCanvasRenderingContext2D.prototype.getImageData = wrap(offscreenGetImageData, (t, self, a) => {
                noisifyOffscreen(self.canvas, self);
                return Reflect.apply(t, self, a);
            });
        }
    }

    // ---------------------------------------------------------------------
    // WebGL: spoof identifying parameters and add noise to buffer data.
    // ---------------------------------------------------------------------
    if (config.webgl && typeof WebGLRenderingContext !== 'undefined') {
        const customData = config.webgl.data || null;

        const coerceCustom = (pname, value) => {
            // Allow { 0: x, 1: y } shorthand for array-valued parameters.
            if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Array.isArray(value)) {
                if (pname === 3386) return new Int32Array([value[0], value[1]]);
                if (pname === 33901 || pname === 33902) return new Float32Array([value[0], value[1]]);
            }
            return value;
        };

        const defaultValue = (pname) => {
            switch (pname) {
                case 3415: return 0;
                case 3414: return 24; // STENCIL_BITS
                case 36348: return 30; // MAX_VARYING_VECTORS (masked)
                case 7936: return 'WebKit'; // VENDOR
                case 7937: return 'WebKit WebGL'; // RENDERER
                case 37445: return 'Google Inc.'; // UNMASKED_VENDOR_WEBGL
                case 3379: return pow2([14, 15]); // MAX_TEXTURE_SIZE
                case 36347: return pow2([12, 13]); // MAX_VERTEX_UNIFORM_VECTORS
                case 34076: return pow2([14, 15]); // MAX_CUBE_MAP_TEXTURE_SIZE
                case 34024: return pow2([14, 15]); // MAX_RENDERBUFFER_SIZE
                case 3386: { const n = pow2([13, 14, 15]); return new Int32Array([n, n]); } // MAX_VIEWPORT_DIMS
                case 3410: // RED_BITS
                case 3411: // GREEN_BITS
                case 3412: // BLUE_BITS
                case 3413: // ALPHA_BITS
                case 34047: // MAX_VERTEX_ATTRIBS (masked)
                case 34930: // MAX_TEXTURE_IMAGE_UNITS
                case 34921: // MAX_VERTEX_TEXTURE_IMAGE_UNITS
                case 35660: return pow2([1, 2, 3, 4]);
                case 35661: return pow2([4, 5, 6, 7, 8]);
                case 36349: return pow2([10, 11, 12, 13]); // MAX_FRAGMENT_UNIFORM_VECTORS
                case 33901: return new Float32Array([1, pow2([10, 11, 12, 13])]); // ALIASED_POINT_SIZE_RANGE
                case 33902: return new Float32Array([1, pow2([10, 11, 12, 13])]); // ALIASED_LINE_WIDTH_RANGE
                case 37446: // UNMASKED_RENDERER_WEBGL
                    return pick([
                        'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
                        'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
                        'ANGLE (Apple, Apple M1, OpenGL 4.1)',
                    ]);
                case 7938: return 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'; // VERSION
                case 35724: return 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)'; // SHADING_LANGUAGE_VERSION
                default: return undefined;
            }
        };

        // Values are computed once and cached so every query in the session
        // returns the same result.
        const valueCache = new Map();
        const spoofedValue = (pname) => {
            if (!valueCache.has(pname)) {
                const value =
                    customData && customData[pname] !== undefined
                        ? coerceCustom(pname, customData[pname])
                        : defaultValue(pname);
                valueCache.set(pname, value);
            }
            return valueCache.get(pname);
        };

        const patchContext = (ctor) => {
            if (!ctor) return;
            const proto = ctor.prototype;

            proto.getParameter = wrap(proto.getParameter, (target, self, args) => {
                const value = spoofedValue(args[0]);
                return value !== undefined ? value : Reflect.apply(target, self, args);
            });

            proto.bufferData = wrap(proto.bufferData, (target, self, args) => {
                const data = args[1];
                if (ArrayBuffer.isView(data) && data.length > 0) {
                    const index = Math.floor(random() * data.length);
                    if (typeof data[index] === 'number') data[index] += 0.1 * random() * data[index];
                }
                return Reflect.apply(target, self, args);
            });
        };

        patchContext(WebGLRenderingContext);
        if (typeof WebGL2RenderingContext !== 'undefined') patchContext(WebGL2RenderingContext);
    }

    // ---------------------------------------------------------------------
    // Fonts: skew offsetHeight/offsetWidth and measureText by a fixed
    // per-session amount.
    // ---------------------------------------------------------------------
    if (config.fonts) {
        const noise = config.fonts.noise !== undefined ? config.fonts.noise : randomInt(-1, 1);
        const sign = config.fonts.sign !== undefined ? config.fonts.sign : pick([-1, 1]);
        const offset = noise * sign;

        const patchDimension = (prop) => {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
            if (!descriptor || typeof descriptor.get !== 'function') return;
            Object.defineProperty(HTMLElement.prototype, prop, {
                configurable: true,
                get: wrap(descriptor.get, (target, self, args) => {
                    let value;
                    try {
                        value = Reflect.apply(target, self, args);
                    } catch (e) {
                        return 0;
                    }
                    return value ? value + offset : value;
                }),
            });
        };

        patchDimension('offsetHeight');
        patchDimension('offsetWidth');

        const textNoise = offset * 0.1;
        if (textNoise !== 0 && typeof CanvasRenderingContext2D !== 'undefined') {
            const measureText = CanvasRenderingContext2D.prototype.measureText;
            CanvasRenderingContext2D.prototype.measureText = wrap(measureText, (target, self, args) => {
                const metrics = Reflect.apply(target, self, args);
                return new Proxy(metrics, {
                    get: (obj, prop) => (prop === 'width' ? Reflect.get(obj, prop) + textNoise : Reflect.get(obj, prop)),
                });
            });
        }
    }

    // ---------------------------------------------------------------------
    // Audio: add tiny deterministic noise to buffers and analyser output.
    // ---------------------------------------------------------------------
    if (config.audio && typeof AudioBuffer !== 'undefined') {
        const noisifiedBuffers = new WeakSet();

        AudioBuffer.prototype.getChannelData = wrap(AudioBuffer.prototype.getChannelData, (target, self, args) => {
            const channelData = Reflect.apply(target, self, args);
            if (!noisifiedBuffers.has(channelData)) {
                noisifiedBuffers.add(channelData);
                for (let i = 100; i < channelData.length; i += 100) {
                    channelData[i] += random() * 0.0000001;
                }
            }
            return channelData;
        });

        const patchCreateAnalyser = (ctor) => {
            if (!ctor) return;
            ctor.prototype.createAnalyser = wrap(ctor.prototype.createAnalyser, (target, self, args) => {
                const analyser = Reflect.apply(target, self, args);
                if (!analyser.__afpPatched) {
                    define(analyser, '__afpPatched', true);
                    analyser.getFloatFrequencyData = wrap(analyser.getFloatFrequencyData, (t, s, a) => {
                        const result = Reflect.apply(t, s, a);
                        const data = a[0];
                        if (data && data.length) {
                            for (let i = 100; i < data.length; i += 100) {
                                data[i] += random() * 0.1;
                            }
                        }
                        return result;
                    });
                    analyser.getByteFrequencyData = wrap(analyser.getByteFrequencyData, (t, s, a) => {
                        const result = Reflect.apply(t, s, a);
                        const data = a[0];
                        if (data && data.length) {
                            for (let i = 100; i < data.length; i += 100) {
                                data[i] = Math.max(0, Math.min(255, data[i] + randomInt(-2, 2)));
                            }
                        }
                        return result;
                    });
                }
                return analyser;
            });
        };

        if (typeof AudioContext !== 'undefined') patchCreateAnalyser(AudioContext);
        if (typeof OfflineAudioContext !== 'undefined') patchCreateAnalyser(OfflineAudioContext);
    }

    // ---------------------------------------------------------------------
    // WebRTC: remove the APIs that leak the real local/public IP.
    // ---------------------------------------------------------------------
    if (config.webRTC) {
        for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'MediaStreamTrack']) {
            define(window, name, undefined);
        }
        if (navigator.mediaDevices) define(navigator.mediaDevices, 'getUserMedia', undefined);
        for (const name of ['getUserMedia', 'webkitGetUserMedia', 'mozGetUserMedia']) {
            define(navigator, name, undefined);
        }
    }

    // ---------------------------------------------------------------------
    // Navigator identity. With no explicit userAgent, only the headless
    // marker is stripped from the real UA.
    // ---------------------------------------------------------------------
    if (config.webdriver) {
        defineGetter(Navigator.prototype, 'webdriver', () => undefined);
    }

    if (config.deviceMemory) {
        const memory = typeof config.deviceMemory === 'number' ? config.deviceMemory : pick([4, 8]);
        defineGetter(Navigator.prototype, 'deviceMemory', () => memory);
    }

    if (config.hardwareConcurrency) {
        const cores =
            typeof config.hardwareConcurrency === 'number' ? config.hardwareConcurrency : pick([4, 8, 12, 16]);
        defineGetter(Navigator.prototype, 'hardwareConcurrency', () => cores);
    }

    if (config.navigator) {
        const nav = config.navigator;
        const realUA = window.navigator.userAgent;
        const userAgent = nav.userAgent || realUA.replace(/HeadlessChrome/g, 'Chrome');

        defineGetter(Navigator.prototype, 'userAgent', () => userAgent);
        defineGetter(Navigator.prototype, 'appVersion', () => userAgent.replace(/^Mozilla\//, ''));

        if (nav.platform) defineGetter(Navigator.prototype, 'platform', () => nav.platform);
        if (nav.vendor) defineGetter(Navigator.prototype, 'vendor', () => nav.vendor);
        if (nav.languages && nav.languages.length) {
            const languages = nav.languages.slice();
            defineGetter(Navigator.prototype, 'languages', () => languages.slice());
            defineGetter(Navigator.prototype, 'language', () => languages[0]);
        }
        if (nav.userAgentData && typeof NavigatorUAData !== 'undefined') {
            const data = nav.userAgentData;
            const cloneBrands = () => data.brands.map((b) => ({ brand: b.brand, version: b.version }));
            const uaData = {
                get brands() {
                    return cloneBrands();
                },
                mobile: !!data.mobile,
                platform: data.platform,
                getHighEntropyValues: () =>
                    Promise.resolve({
                        architecture: 'x86',
                        bitness: '64',
                        brands: cloneBrands(),
                        fullVersionList: cloneBrands().map((b) => ({
                            brand: b.brand,
                            version: b.version === '8' ? '8.0.0.0' : data.fullVersion,
                        })),
                        mobile: !!data.mobile,
                        model: '',
                        platform: data.platform,
                        platformVersion: data.platformVersion || '',
                        uaFullVersion: data.fullVersion,
                        wow64: false,
                    }),
                toJSON: () => ({ brands: cloneBrands(), mobile: !!data.mobile, platform: data.platform }),
            };
            Object.setPrototypeOf(uaData, NavigatorUAData.prototype);
            defineGetter(Navigator.prototype, 'userAgentData', () => uaData);
        }
    }

    // ---------------------------------------------------------------------
    // Screen geometry and window outer dimensions (0 in some headless
    // setups — a classic tell).
    // ---------------------------------------------------------------------
    if (config.screen) {
        const s = config.screen;
        const availWidth = s.availWidth === undefined ? s.width : s.availWidth;
        const availHeight = s.availHeight === undefined ? s.height : s.availHeight;
        const values = {
            width: s.width,
            height: s.height,
            availWidth,
            availHeight,
            colorDepth: s.colorDepth === undefined ? 24 : s.colorDepth,
            pixelDepth: s.pixelDepth === undefined ? 24 : s.pixelDepth,
        };
        for (const prop of Object.keys(values)) {
            defineGetter(Screen.prototype, prop, () => values[prop]);
        }
        defineGetter(window, 'outerWidth', () => availWidth);
        defineGetter(window, 'outerHeight', () => availHeight);
    }

    // ---------------------------------------------------------------------
    // Plugins & mimeTypes: headless builds used to report empty lists.
    // Rebuilds the standard five PDF plugins of desktop Chrome.
    // ---------------------------------------------------------------------
    if (config.plugins && typeof PluginArray !== 'undefined') {
        try {
            const mimeTypesData = [
                { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
                { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
            ];
            const pluginNames = [
                'PDF Viewer',
                'Chrome PDF Viewer',
                'Chromium PDF Viewer',
                'Microsoft Edge PDF Viewer',
                'WebKit built-in PDF',
            ];

            // NOTE: never read inherited accessors (mt.type, mt.enabledPlugin,
            // ...) on these fake objects — the native getters on the prototype
            // throw "Illegal invocation" for non-platform objects.
            const mimeTypes = mimeTypesData.map((m) => {
                const mt = Object.create(MimeType.prototype);
                define(mt, 'type', m.type);
                define(mt, 'suffixes', m.suffixes);
                define(mt, 'description', m.description);
                return mt;
            });

            const plugins = pluginNames.map((name) => {
                const plugin = Object.create(Plugin.prototype);
                define(plugin, 'name', name);
                define(plugin, 'filename', 'internal-pdf-viewer');
                define(plugin, 'description', 'Portable Document Format');
                define(plugin, 'length', mimeTypes.length);
                mimeTypes.forEach((mt, i) => {
                    plugin[i] = mt;
                });
                define(plugin, 'item', (i) => plugin[i] || null);
                define(plugin, 'namedItem', (n) => {
                    for (let i = 0; i < mimeTypes.length; i++) if (mimeTypesData[i].type === n) return plugin[i];
                    return null;
                });
                return plugin;
            });
            for (const mt of mimeTypes) define(mt, 'enabledPlugin', plugins[0]);

            const pluginArray = Object.create(PluginArray.prototype);
            plugins.forEach((p, i) => {
                pluginArray[i] = p;
                pluginArray[p.name] = p;
            });
            define(pluginArray, 'length', plugins.length);
            define(pluginArray, 'item', (i) => pluginArray[i] || null);
            define(pluginArray, 'namedItem', (n) => pluginArray[n] || null);
            define(pluginArray, 'refresh', () => undefined);

            const mimeTypeArray = Object.create(MimeTypeArray.prototype);
            mimeTypes.forEach((mt, i) => {
                mimeTypeArray[i] = mt;
                mimeTypeArray[mt.type] = mt;
            });
            define(mimeTypeArray, 'length', mimeTypes.length);
            define(mimeTypeArray, 'item', (i) => mimeTypeArray[i] || null);
            define(mimeTypeArray, 'namedItem', (n) => mimeTypeArray[n] || null);

            defineGetter(Navigator.prototype, 'plugins', () => pluginArray);
            defineGetter(Navigator.prototype, 'mimeTypes', () => mimeTypeArray);
        } catch (e) {
            /* plugin spoofing is best-effort */
        }
    }

    // ---------------------------------------------------------------------
    // Permissions: headless used to report "denied" for notifications while
    // Notification.permission said "default". Keep the two consistent.
    // ---------------------------------------------------------------------
    if (config.permissions && typeof Permissions !== 'undefined' && typeof Notification !== 'undefined') {
        Permissions.prototype.query = wrap(Permissions.prototype.query, (target, self, args) => {
            if (args[0] && args[0].name === 'notifications') {
                return Promise.resolve({ state: Notification.permission, onchange: null });
            }
            return Reflect.apply(target, self, args);
        });
    }

    if (window.chrome === undefined) define(window, 'chrome', { runtime: {} });
};

/**
 * Installs the anti-fingerprint init script on a Playwright Page or
 * BrowserContext. Resolves with the seed in use, so it can be stored and
 * reused to reproduce the same fingerprint later.
 *
 * @param {import('playwright').Page | import('playwright').BrowserContext} pageOrContext
 * @param {object} [options]
 * @param {number} [options.seed] Seed for the deterministic noise PRNG.
 * @param {object | 'windows' | 'mac' | 'linux'} [options.profile] Coherent
 *   profile from `generateProfile()` (or an OS name to generate one).
 * @param {boolean | { rgba?: [number, number, number, number] }} [options.canvas=true]
 * @param {boolean | { data?: Record<number, unknown> }} [options.webgl=true]
 * @param {boolean} [options.audio=true]
 * @param {boolean | { noise?: number, sign?: number }} [options.fonts=true]
 * @param {boolean} [options.webRTC=false] Disable WebRTC APIs that leak the real IP.
 * @param {boolean} [options.webdriver=true] Hide navigator.webdriver.
 * @param {boolean | object} [options.navigator=false] Spoof navigator identity
 *   (userAgent, platform, vendor, languages, userAgentData). `true` strips
 *   the headless marker from the real UA only.
 * @param {boolean | object} [options.screen=false] Spoof screen geometry and
 *   window.outerWidth/outerHeight.
 * @param {boolean} [options.plugins=false] Fake the five standard PDF plugins.
 * @param {boolean} [options.permissions=true] Fix the notifications permission tell.
 * @param {boolean | number} [options.deviceMemory] Spoof navigator.deviceMemory.
 * @param {boolean | number} [options.hardwareConcurrency] Spoof navigator.hardwareConcurrency.
 * @returns {Promise<number>} The seed used for this fingerprint.
 */
const protectIt = async (pageOrContext, options) => {
    if (!pageOrContext || typeof pageOrContext.addInitScript !== 'function') {
        throw new TypeError('playwright-afp: expected a Playwright Page or BrowserContext as the first argument.');
    }
    const config = normalizeOptions(options);
    await pageOrContext.addInitScript(afpInitScript, config);
    return config.seed;
};

module.exports = protectIt;
module.exports.protectIt = protectIt;
module.exports.default = protectIt;
module.exports.generateProfile = generateProfile;
