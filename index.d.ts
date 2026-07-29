/**
 * playwright-afp — anti-fingerprint protection for Playwright.
 */

declare namespace protectIt {
    type Page = import('playwright').Page;
    type BrowserContext = import('playwright').BrowserContext;

    type OSName = 'windows' | 'mac' | 'linux';

    interface CanvasOptions {
        /** Fixed RGBA pixel offset, each component from -5 to 5. */
        rgba?: [number, number, number, number];
    }

    interface WebGLOptions {
        /**
         * Pin specific GL parameter values, keyed by GL constant
         * (e.g. `3379` for MAX_TEXTURE_SIZE). Array-valued parameters
         * accept a `{ 0: x, 1: y }` object or a typed array.
         */
        data?: Record<number, unknown>;
    }

    interface FontOptions {
        /** Noise magnitude, e.g. -1, 0, 1, 2. */
        noise?: number;
        /** Direction of the noise: -1 or +1. */
        sign?: number;
    }

    interface UserAgentDataBrand {
        brand: string;
        version: string;
    }

    interface UserAgentDataOptions {
        brands: UserAgentDataBrand[];
        mobile: boolean;
        platform: string;
        platformVersion?: string;
        fullVersion: string;
    }

    interface NavigatorOptions {
        /** Full UA string. Default: real UA with the headless marker stripped. */
        userAgent?: string;
        platform?: string;
        vendor?: string;
        languages?: string[];
        userAgentData?: UserAgentDataOptions;
    }

    interface ScreenOptions {
        width: number;
        height: number;
        availWidth?: number;
        availHeight?: number;
        colorDepth?: number;
        pixelDepth?: number;
    }

    /** A coherent fingerprint profile produced by `generateProfile`. */
    interface Profile {
        os: OSName;
        userAgent: string;
        platform: string;
        vendor: string;
        languages: string[];
        userAgentData: UserAgentDataOptions;
        screen: Required<ScreenOptions>;
        deviceMemory: number;
        hardwareConcurrency: number;
        webgl: { vendor: string; renderer: string };
    }

    interface GenerateProfileOptions {
        /** OS family. Default: random. */
        os?: OSName;
        /** Seed for deterministic selection. */
        seed?: number;
        /** Primary locale. Default: 'en-US'. */
        locale?: string;
    }

    interface AfpOptions {
        /**
         * Seed for the deterministic noise PRNG. Pass any integer to get a
         * stable, reproducible fingerprint. Default: random per call.
         */
        seed?: number;
        /**
         * Coherent profile from `generateProfile()`, or an OS name to
         * generate one automatically. Explicit options override the profile.
         */
        profile?: Profile | OSName;
        /** Canvas (incl. OffscreenCanvas) protection. Default: `true`. */
        canvas?: boolean | CanvasOptions;
        /** WebGL protection. Default: `true`. */
        webgl?: boolean | WebGLOptions;
        /** AudioContext protection. Default: `true`. */
        audio?: boolean;
        /** Font measurement protection (offset sizes + measureText). Default: `true`. */
        fonts?: boolean | FontOptions;
        /** Remove WebRTC APIs that leak the real IP. Default: `false`. */
        webRTC?: boolean;
        /** Hide `navigator.webdriver`. Default: `true`. */
        webdriver?: boolean;
        /**
         * Spoof navigator identity. `true` only strips the headless marker
         * from the real UA. Default: `false` (unless a profile is given).
         */
        navigator?: boolean | NavigatorOptions;
        /**
         * Spoof screen geometry and window.outerWidth/outerHeight.
         * Default: `false` (unless a profile is given).
         */
        screen?: boolean | ScreenOptions;
        /** Fake the five standard PDF plugins and their mimeTypes. Default: `false`. */
        plugins?: boolean;
        /** Fix the notifications permission tell. Default: `true`. */
        permissions?: boolean;
        /** Spoof `navigator.deviceMemory`. Default: profile value, else untouched. */
        deviceMemory?: boolean | number;
        /** Spoof `navigator.hardwareConcurrency`. Default: profile value, else untouched. */
        hardwareConcurrency?: boolean | number;

        // ---- Legacy <= 0.0.3 option names (deprecated) ----
        /** @deprecated Use `canvas: { rgba }`. */
        canvasRgba?: [number, number, number, number];
        /** @deprecated Use `webgl: { data }`. */
        webglData?: Record<number, unknown>;
        /** @deprecated Use `fonts: { noise, sign }`. */
        fontFingerprint?: FontOptions;
        /** @deprecated Use `audio: true`. */
        audioFingerprint?: Record<string, number>;
        /** @deprecated Use `webRTC`. */
        webRTCProtect?: boolean;
    }
}

/**
 * Installs the anti-fingerprint init script on a Playwright Page or
 * BrowserContext. Resolves with the seed in use, so it can be stored and
 * reused to reproduce the same fingerprint later.
 */
declare function protectIt(
    pageOrContext: protectIt.Page | protectIt.BrowserContext,
    options?: protectIt.AfpOptions
): Promise<number>;

declare namespace protectIt {
    /**
     * Generates a coherent fingerprint profile: UA, platform, Client Hints,
     * screen, WebGL renderer, memory and cores that all describe the same
     * plausible machine.
     */
    function generateProfile(options?: GenerateProfileOptions): Profile;
}

export = protectIt;
