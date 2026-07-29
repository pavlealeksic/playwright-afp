# playwright-afp

Stop websites from fingerprinting your Playwright browser instances.

Covers: **Canvas** (incl. OffscreenCanvas), **WebGL**, **AudioContext**,
**font measurement**, **navigator identity**, **screen geometry**,
**plugins/mimeTypes**, **permissions**, **WebRTC** and
**`navigator.webdriver`**.

## What's new in 1.0.0

- **Coherent fingerprint profiles** — `generateProfile()` builds a full set
  of attributes (UA, platform, Client Hints, screen, WebGL renderer,
  memory, cores) that all describe the same plausible machine. Mismatched
  attributes are the easiest way to get flagged.
- **Deterministic fingerprints** — all noise is derived from a seeded PRNG.
  A fingerprint stays stable for the whole session and can be reproduced
  later by reusing the seed.
- **New coverage** — navigator identity (`userAgent`, `platform`, `vendor`,
  `languages`, `userAgentData`), `screen.*` + `outerWidth/outerHeight`,
  PDF `plugins`/`mimeTypes`, `permissions.query` notifications fix,
  `OffscreenCanvas`, `measureText`, modern `ANGLE (...)` WebGL renderer
  strings, and `Function.prototype.toString` spoofing so the injected
  proxies can't be detected.
- **Bug fixes** — user-supplied WebGL overrides now actually apply, audio
  noise applies to every buffer (not just the first), analyser proxies no
  longer stack, repeated canvas reads stay consistent, and `offsetHeight`
  no longer returns `undefined`.
- Backward compatible with the `0.0.x` option names.

## Installation

```bash
npm install playwright-afp
# - or -
yarn add playwright-afp
```

## Usage

### Recommended: coherent profile

```js
const { chromium } = require('playwright');
const protectIt = require('playwright-afp');

const profile = protectIt.generateProfile({ os: 'windows', seed: 123456 });

const browser = await chromium.launch();
// Pass the profile's UA and screen to the context so HTTP headers,
// viewport and JS-reported values all agree.
const context = await browser.newContext({
  userAgent: profile.userAgent,
  viewport: { width: profile.screen.width, height: profile.screen.height },
  locale: profile.languages[0],
});

const seed = await protectIt(context, { profile, seed: 123456, webRTC: true });
// store `seed` (and `profile`) to reproduce this exact fingerprint later

const page = await context.newPage();
```

### Simple

```js
await protectIt(page); // random seed, default protections
await protectIt(context, { profile: 'mac' }); // generate a mac profile internally
```

## Options

All options are optional; defaults are shown below.

```js
await protectIt(context, {
  // Integer seed for the deterministic noise generator. Default: random.
  seed: 123456,

  // Profile object from generateProfile(), or an OS name ('windows' |
  // 'mac' | 'linux'). Provides coherent defaults for navigator, screen,
  // deviceMemory, hardwareConcurrency and the WebGL vendor/renderer.
  // Explicit options below override the profile. Default: none.
  profile: 'windows',

  // Canvas fingerprinting (incl. OffscreenCanvas). Shifts every pixel by a
  // fixed RGBA offset (components -5..5). Default: true.
  canvas: true, // or { rgba: [0, 0, 0, 0] }

  // WebGL fingerprinting. Spoofs vendor/renderer strings and hardware
  // limits, adds noise to buffer data. Default: true.
  webgl: true, // or { data: { 3379: 32768, 37446: 'ANGLE (...)' } }

  // AudioContext fingerprinting. Default: true.
  audio: true,

  // Font fingerprinting: skews offsetHeight/offsetWidth and measureText.
  // Default: true.
  fonts: true, // or { noise: 1, sign: +1 }

  // Remove RTCPeerConnection & getUserMedia so the real IP cannot leak.
  // Default: false.
  webRTC: true,

  // Hide navigator.webdriver. Default: true.
  webdriver: true,

  // Navigator identity. true = only strip the headless marker from the
  // real UA. Object form spoofs userAgent/platform/vendor/languages/
  // userAgentData. Default: false (profile provides it when given).
  navigator: true,

  // Screen geometry + window.outerWidth/outerHeight. Default: false
  // (profile provides it when given).
  screen: { width: 1920, height: 1080, availHeight: 1040 },

  // Fake the five standard PDF plugins and their mimeTypes. Default: false.
  plugins: true,

  // Keep permissions.query('notifications') consistent with
  // Notification.permission. Default: true.
  permissions: true,

  // Spoof navigator.deviceMemory / hardwareConcurrency. A number for a
  // fixed value, true for a seeded random one. Default: profile value,
  // otherwise untouched.
  deviceMemory: 8,
  hardwareConcurrency: 8,
});
```

### Pinning WebGL parameters

`webgl.data` maps GL parameter constants to fixed values. Array-valued
parameters accept a `{ 0: x, 1: y }` shorthand:

```js
webgl: {
  data: {
    3379: 32768,                     // MAX_TEXTURE_SIZE: 16384 or 32768
    3386: { 0: 32768, 1: 32768 },    // MAX_VIEWPORT_DIMS
    34024: 32768,                    // MAX_RENDERBUFFER_SIZE
    36347: 4096,                     // MAX_VERTEX_UNIFORM_VECTORS
    36349: 8192,                     // MAX_FRAGMENT_UNIFORM_VECTORS
    33901: { 0: 1, 1: 1024 },        // ALIASED_POINT_SIZE_RANGE
    33902: { 0: 1, 1: 4096 },        // ALIASED_LINE_WIDTH_RANGE
    7938: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)', // VERSION
    35724: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    37445: 'Google Inc.',            // UNMASKED_VENDOR_WEBGL
    37446: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
}
```

### Tips

- Set the same `userAgent` in `browser.newContext()` and in the profile —
  otherwise the HTTP `User-Agent` header and `navigator.userAgent` differ,
  which is itself detectable.
- Use Playwright's native `locale` and `timezoneId` context options to
  match your profile's languages and your proxy's location.
- Reuse a `seed` + `profile` pair per account/session to keep the
  fingerprint stable over time; rotate it to look like a new machine.

## Verifying

Point the protected browser at <https://webbrowsertools.com> or a similar
fingerprinting test page and check that the reported canvas/WebGL/audio
fingerprints differ from your real ones (and stay stable across reloads
when a `seed` is set).

## Migrating from 0.0.x

Old option names still work — `canvasRgba`, `webglData`, `fontFingerprint`,
`audioFingerprint` and `webRTCProtect` are mapped onto the new options.
Behavioral changes to be aware of:

- `deviceMemory` is no longer randomized by default; set it explicitly (or
  use a profile) if you want it spoofed.
- All noise is deterministic per seed instead of re-randomized on every call.

## Creator

**Pavle Aleksic**

- <https://twitter.com/aleksicpaja>

## License

This project is licensed under the terms of the MIT license.
