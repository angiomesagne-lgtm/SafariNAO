// preload-webview.js
// Iniettato in ogni webview PRIMA che la pagina carichi.
// Sovrascrive navigator.userAgent, navigator.userAgentData e tutti
// gli altri campi che il Chrome Web Store controlla per verificare
// se il browser è Chrome autentico.

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CHROME_VERSION = '120.0.0.0';
const CHROME_MAJOR   = '120';

// ── 1. navigator.userAgent ────────────────────────────────────
try {
  Object.defineProperty(navigator, 'userAgent', {
    get: () => CHROME_UA,
    configurable: true
  });
} catch(e) {}

// ── 2. navigator.appVersion ──────────────────────────────────
try {
  Object.defineProperty(navigator, 'appVersion', {
    get: () => '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    configurable: true
  });
} catch(e) {}

// ── 3. navigator.vendor ──────────────────────────────────────
try {
  Object.defineProperty(navigator, 'vendor', {
    get: () => 'Google Inc.',
    configurable: true
  });
} catch(e) {}

// ── 4. navigator.userAgentData (Client Hints API) ─────────────
// Questo è il check più importante per il Web Store moderno.
// Sovrascriviamo l'intera API NavigatorUAData.
try {
  const uaData = {
    brands: [
      { brand: 'Not_A Brand',       version: '8'   },
      { brand: 'Chromium',          version: CHROME_MAJOR },
      { brand: 'Google Chrome',     version: CHROME_MAJOR },
    ],
    mobile:    false,
    platform:  'Windows',

    getHighEntropyValues(hints) {
      const values = {
        architecture:        'x86',
        bitness:             '64',
        brands:              this.brands,
        fullVersionList: [
          { brand: 'Not_A Brand',   version: '8.0.0.0' },
          { brand: 'Chromium',      version: CHROME_VERSION },
          { brand: 'Google Chrome', version: CHROME_VERSION },
        ],
        mobile:              false,
        model:               '',
        platform:            'Windows',
        platformVersion:     '15.0.0',
        uaFullVersion:       CHROME_VERSION,
        wow64:               false,
      };
      const result = {};
      for (const hint of hints) {
        if (hint in values) result[hint] = values[hint];
      }
      return Promise.resolve(result);
    },

    toJSON() {
      return { brands: this.brands, mobile: this.mobile, platform: this.platform };
    }
  };

  Object.defineProperty(navigator, 'userAgentData', {
    get: () => uaData,
    configurable: true
  });
} catch(e) {}

// ── 5. Nascondi tracce Electron ───────────────────────────────
// Non cancelliamo window.process/require (serve a Electron),
// ma li rendiamo invisibili al codice delle pagine web.
try {
  // Il Web Store controlla window.process.type per rilevare Electron
  if (window.process && window.process.type) {
    const origProcess = window.process;
    Object.defineProperty(window, 'process', {
      get: () => undefined,
      configurable: true
    });
  }
} catch(e) {}

// ── 6. window.chrome — il Web Store lo controlla esplicitamente ─
// Chrome reale espone window.chrome con runtime, loadTimes, ecc.
try {
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      id:                  undefined,
      connect:             () => {},
      sendMessage:         () => {},
      onMessage:           { addListener: () => {}, removeListener: () => {} },
      onConnect:           { addListener: () => {}, removeListener: () => {} },
      getManifest:         () => ({}),
      getURL:              (path) => `chrome-extension://unknown/${path}`,
      PlatformOs:          { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
      PlatformArch:        { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
      RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
    };
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function() {
      return {
        requestTime:        performance.timing.navigationStart / 1000,
        startLoadTime:      performance.timing.navigationStart / 1000,
        commitLoadTime:     performance.timing.responseStart   / 1000,
        finishDocumentLoadTime: performance.timing.domContentLoadedEventEnd / 1000,
        finishLoadTime:     performance.timing.loadEventEnd   / 1000,
        firstPaintTime:     performance.timing.domLoading     / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType:     'Other',
        wasFetchedViaSpdy:  true,
        wasNpnNegotiated:   true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo:     'h2',
      };
    };
  }
  if (!window.chrome.csi) {
    window.chrome.csi = function() {
      return {
        startE:   performance.timing.navigationStart,
        onloadT:  performance.timing.loadEventEnd,
        pageT:    performance.now(),
        tran:     15,
      };
    };
  }
  if (!window.chrome.app) {
    window.chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails:    () => null,
      getIsInstalled: () => false,
      installState:  (cb) => cb && cb('not_installed'),
      runningState:  () => 'cannot_run',
    };
  }
} catch(e) {}

// ── 7. Plugins — Chrome ha sempre i plugin PDF ───────────────
try {
  const fakePlugin = (name, filename, desc) => ({
    name, filename, description: desc,
    length: 1,
    item: (i) => i === 0 ? { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: {} } : undefined,
    namedItem: () => undefined,
  });
  const pluginArray = [
    fakePlugin('PDF Viewer',          'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'Portable Document Format'),
    fakePlugin('Chrome PDF Viewer',   'internal-pdf-viewer',              'Portable Document Format'),
    fakePlugin('Chromium PDF Viewer', 'internal-pdf-viewer',              'Portable Document Format'),
    fakePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer',        'Portable Document Format'),
    fakePlugin('WebKit built-in PDF', 'internal-pdf-viewer',              'Portable Document Format'),
  ];
  pluginArray.length = pluginArray.length;
  pluginArray.item        = (i) => pluginArray[i];
  pluginArray.namedItem   = (name) => pluginArray.find(p => p.name === name) || null;
  pluginArray.refresh     = () => {};
  pluginArray[Symbol.iterator] = function*() { yield* Object.values(this).filter(v => typeof v === 'object' && v?.name); };

  Object.defineProperty(navigator, 'plugins', {
    get: () => pluginArray,
    configurable: true
  });
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => ({ length: 2, item: (i) => null, namedItem: () => null }),
    configurable: true
  });
} catch(e) {}

// ── 8. webdriver — deve essere false ────────────────────────
try {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true
  });
} catch(e) {}

// ── 9. languages / language ──────────────────────────────────
try {
  Object.defineProperty(navigator, 'language',  { get: () => 'it-IT', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US', 'en'], configurable: true });
} catch(e) {}

// ── 10. platform ─────────────────────────────────────────────
try {
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
} catch(e) {}