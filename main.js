'use strict';
const { app, BrowserWindow, ipcMain, session, dialog, net } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Command line flags (before app.ready) ────────────────────
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
app.commandLine.appendSwitch('enable-features',  'ExtensionsToolbarMenu');

// ── Chrome 120 User Agent ────────────────────────────────────
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Paths ────────────────────────────────────────────────────
const DATA_FILE = path.join(app.getPath('userData'), 'safarinao-data.json');
const EXTS_DIR  = path.join(app.getPath('userData'), 'extensions');

// ── Data helpers ─────────────────────────────────────────────
function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return {
    history: [], bookmarks: [], savedPages: [], passwords: [],
    account: { name: '', email: '', avatar: '' },
    settings: { adblock: true, searchEngine: 'google', zoom: 1, bmBar: true, language: 'it' }
  };
}

function writeData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

// ── AdBlock engine ───────────────────────────────────────────
const adblock = require('./adblock');

// ── Static fallback domains (used before EasyList loads) ─────
const STATIC_BLOCK = new Set([
  'doubleclick.net','googlesyndication.com','adservice.google.com',
  'adservice.google.it','adservice.google.co.uk','googletagmanager.com',
  'adnxs.com','advertising.com','rubiconproject.com','openx.net',
  'pubmatic.com','taboola.com','outbrain.com','criteo.com',
  'scorecardresearch.com','quantserve.com','amazon-adsystem.com',
  'moatads.com','adsrvr.org','bidswitch.net','mediamath.com',
  'spotxchange.com','adform.net','revcontent.com','mgid.com',
  'appnexus.com','pagefair.com','adroll.com','exelator.com',
  'yieldmanager.com','casalemedia.com','conversantmedia.com',
  'lijit.com','zedo.com','brightmountainmedia.com','adtech.de','adblade.com',
]);

function isStaticBlocked(url) {
  try {
    let d = new URL(url).hostname.toLowerCase();
    while (d) {
      if (STATIC_BLOCK.has(d)) return true;
      const dot = d.indexOf('.');
      if (dot === -1) break;
      d = d.slice(dot + 1);
    }
  } catch (e) {}
  return false;
}

// ── Load persisted extensions ────────────────────────────────
async function loadPersistedExtensions(sess) {
  if (!fs.existsSync(EXTS_DIR)) return [];
  const loaded = [];
  for (const entry of fs.readdirSync(EXTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(EXTS_DIR, entry.name);
    try {
      const ext = await sess.loadExtension(dir, { allowFileAccess: true });
      loaded.push({ name: ext.manifest.name || entry.name, id: ext.id, path: dir });
    } catch (e) { console.log('[Ext] Skip:', dir, e.message); }
  }
  return loaded;
}

// ── Extract .crx file ────────────────────────────────────────
async function extractCrx(crxPath, destDir) {
  const buf = fs.readFileSync(crxPath);
  if (buf.slice(0, 4).toString() !== 'Cr24') throw new Error('Not a valid CRX file');
  const version = buf.readUInt32LE(4);
  let zipStart;
  if (version === 3) {
    zipStart = 12 + buf.readUInt32LE(8);
  } else if (version === 2) {
    zipStart = 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  } else {
    throw new Error('Unsupported CRX version: ' + version);
  }
  const zipBuf = buf.slice(zipStart);
  const tmpZip = crxPath + '.zip';
  fs.writeFileSync(tmpZip, zipBuf);
  try {
    const AdmZip = require('adm-zip');
    new AdmZip(zipBuf).extractAllTo(destDir, true);
  } catch (e) {
    const { execSync } = require('child_process');
    execSync(`unzip -o "${tmpZip}" -d "${destDir}"`);
  }
  try { fs.unlinkSync(tmpZip); } catch (e) {}
}

// ── Copy directory recursively ───────────────────────────────
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, item.name);
    const d = path.join(dest, item.name);
    if (item.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ── Main window ──────────────────────────────────────────────
async function createWindow() {
  const { default: contextMenu } = await import('electron-context-menu');

  let adblockEnabled = readData().settings?.adblock !== false;
  let winRef = null;

  // ── Session setup ─────────────────────────────────────────
  const mainSess = session.fromPartition('persist:main');
  mainSess.setUserAgent(CHROME_UA);
  session.defaultSession.setUserAgent(CHROME_UA);

  // Block native popups from webviews (fixes Spotify loop and similar)
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (contents.getType() === 'webview') {
        try { winRef && winRef.webContents.send('open-in-tab', url); } catch (e) {}
      }
      return { action: 'deny' };
    });
  });

  // ── User-Agent spoofing on all requests ──────────────────
  mainSess.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_UA;
    if (details.url.includes('chromewebstore.google.com') || details.url.includes('chrome.google.com')) {
      details.requestHeaders['X-Browser-Channel']  = 'stable';
      details.requestHeaders['X-Browser-Year']     = '2024';
      details.requestHeaders['Sec-CH-UA']          = '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"';
      details.requestHeaders['Sec-CH-UA-Mobile']   = '?0';
      details.requestHeaders['Sec-CH-UA-Platform'] = '"Windows"';
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_UA;
    callback({ requestHeaders: details.requestHeaders });
  });

  // ── AdBlock ──────────────────────────────────────────────
  const ADBLOCK_CACHE = path.join(app.getPath('userData'), 'adblock-cache');
  adblock.init(ADBLOCK_CACHE).then(() => {
    const c = adblock.getRuleCount();
    console.log(`[AdBlock] Ready — domains:${c.domains} keywords:${c.keywords} slow:${c.slow}`);
    try { winRef && winRef.webContents.send('adblock-ready', adblock.getRuleCount()); } catch (e) {}
  }).catch(e => console.error('[AdBlock] Init error:', e));

  mainSess.webRequest.onBeforeRequest((details, callback) => {
    if (!adblockEnabled) return callback({ cancel: false });
    const block = adblock.isReady()
      ? adblock.shouldBlock(details.url, details.resourceType, details.referrer || '')
      : isStaticBlocked(details.url);
    callback({ cancel: block });
  });

  // ── Load persisted extensions ─────────────────────────────
  let loadedExtensions = await loadPersistedExtensions(mainSess);

  // ── Preload script for Chrome UA spoofing ────────────────
  const preloadPath = path.join(__dirname, 'preload-webview.js');
  if (fs.existsSync(preloadPath)) mainSess.setPreloads([preloadPath]);

  // ── Intercept .crx downloads from Web Store ──────────────
  mainSess.on('will-download', (_event, item) => {
    const url      = item.getURL();
    const filename = item.getFilename() || '';
    if (!filename.endsWith('.crx') && !url.includes('/crx/') && !url.includes('extension_id')) return;
    const tmpPath = path.join(os.tmpdir(), filename || 'extension.crx');
    item.setSavePath(tmpPath);
    item.once('done', async (_e, state) => {
      if (state !== 'completed') return;
      try {
        const extName = filename.replace('.crx', '') || 'ext_' + Date.now();
        const destDir = path.join(EXTS_DIR, extName);
        fs.mkdirSync(destDir, { recursive: true });
        await extractCrx(tmpPath, destDir);
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        const ext  = await mainSess.loadExtension(destDir, { allowFileAccess: true });
        const name = ext.manifest.name || extName;
        loadedExtensions.push({ name, id: ext.id, path: destDir });
        try { winRef && winRef.webContents.send('extension-installed', { name }); } catch (e) {}
      } catch (err) {
        console.error('[CRX]', err);
        try { winRef && winRef.webContents.send('extension-install-error', err.message); } catch (e) {}
      }
    });
  });

  // ── BrowserWindow ─────────────────────────────────────────
  const win = new BrowserWindow({
    width: 1300, height: 860,
    minWidth: 800, minHeight: 600,
    frame: false, movable: true, resizable: true,
    backgroundColor: '#1c1c1e',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      additionalArguments: [`--user-agent=${CHROME_UA}`]
    }
  });

  winRef = win;
  contextMenu({ window: win, showInspectElement: true });
  win.loadFile('index.html');

  // ── Window drag ───────────────────────────────────────────
  let dragOffsetX = 0, dragOffsetY = 0, isDragging = false;

  ipcMain.on('drag-start', (_e, { mouseX, mouseY }) => {
    if (win.isMaximized()) return;
    isDragging = true;
    const [wx, wy] = win.getPosition();
    dragOffsetX = mouseX - wx;
    dragOffsetY = mouseY - wy;
  });
  ipcMain.on('drag-move', (_e, { mouseX, mouseY }) => {
    if (!isDragging) return;
    win.setPosition(Math.round(mouseX - dragOffsetX), Math.round(mouseY - dragOffsetY));
  });
  ipcMain.on('drag-end', () => { isDragging = false; });

  // ── Window controls ───────────────────────────────────────
  ipcMain.on('window-ctrl', (_e, cmd) => {
    if      (cmd === 'close') win.close();
    else if (cmd === 'min')   win.minimize();
    else if (cmd === 'max')   win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.handle('is-maximized', () => win.isMaximized());
  win.on('maximize',          () => win.webContents.send('window-state', 'maximized'));
  win.on('unmaximize',        () => win.webContents.send('window-state', 'normal'));
  win.on('enter-full-screen', () => win.webContents.send('window-state', 'fullscreen'));
  win.on('leave-full-screen', () => win.webContents.send('window-state', 'normal'));

  // ── Data IPC ──────────────────────────────────────────────
  ipcMain.handle('get-data', () => readData());

  ipcMain.handle('save-account', (_e, account) => {
    const data = readData();
    data.account = { ...data.account, ...account };
    writeData(data); return { ok: true };
  });

  ipcMain.handle('save-settings', (_e, settings) => {
    const data = readData();
    data.settings = { ...data.settings, ...settings };
    adblockEnabled = data.settings.adblock !== false;
    writeData(data); return { ok: true };
  });

  ipcMain.handle('add-history', (_e, item) => {
    const data = readData();
    const recent = data.history.slice(0, 5).map(h => h.url);
    if (!recent.includes(item.url)) {
      data.history.unshift({ ...item, timestamp: Date.now() });
      if (data.history.length > 2000) data.history = data.history.slice(0, 2000);
      writeData(data);
    }
    return { ok: true };
  });

  ipcMain.handle('delete-history-item', (_e, index) => {
    const data = readData();
    data.history.splice(index, 1);
    writeData(data); return { ok: true };
  });

  ipcMain.handle('clear-history', () => {
    const data = readData();
    data.history = [];
    writeData(data); return { ok: true };
  });

  // ── Bookmarks ─────────────────────────────────────────────
  ipcMain.handle('get-bookmarks', () => readData().bookmarks || []);

  ipcMain.handle('add-bookmark', (_e, bookmark) => {
    const data = readData();
    if (!data.bookmarks) data.bookmarks = [];
    if (!data.bookmarks.find(b => b.url === bookmark.url)) {
      data.bookmarks.unshift({ ...bookmark, id: Date.now() });
    }
    writeData(data); return { ok: true };
  });

  ipcMain.handle('remove-bookmark', (_e, url) => {
    const data = readData();
    data.bookmarks = (data.bookmarks || []).filter(b => b.url !== url);
    writeData(data); return { ok: true };
  });

  ipcMain.handle('is-bookmarked', (_e, url) => {
    return !!(readData().bookmarks || []).find(b => b.url === url);
  });

  ipcMain.handle('clear-all', () => {
    writeData({
      history: [], bookmarks: [], savedPages: [], passwords: [],
      account: { name: '', email: '', avatar: '' },
      settings: { adblock: true, searchEngine: 'google', zoom: 1, bmBar: true, language: 'it' }
    });
    return { ok: true };
  });

  // ── Saved pages ───────────────────────────────────────────
  ipcMain.handle('get-saved-pages', () => readData().savedPages || []);

  ipcMain.handle('save-page', (_e, page) => {
    const data = readData();
    if (!data.savedPages) data.savedPages = [];
    data.savedPages.unshift({ ...page, savedAt: Date.now() });
    writeData(data); return { ok: true };
  });

  ipcMain.handle('delete-saved-page', (_e, index) => {
    const data = readData();
    if (data.savedPages) data.savedPages.splice(index, 1);
    writeData(data); return { ok: true };
  });

  // ── Passwords ─────────────────────────────────────────────
  ipcMain.handle('save-password', (_e, entry) => {
    const data = readData();
    if (!data.passwords) data.passwords = [];
    data.passwords.unshift(entry);
    writeData(data); return { ok: true };
  });

  ipcMain.handle('delete-password', (_e, index) => {
    const data = readData();
    if (data.passwords) data.passwords.splice(index, 1);
    writeData(data); return { ok: true };
  });

  // ── AdBlock Whitelist per-sito ────────────────────────────
  ipcMain.handle('adblock-whitelist-add',    (_e, domain) => { adblock.whitelistAdd(domain);    return { ok: true }; });
  ipcMain.handle('adblock-whitelist-remove', (_e, domain) => { adblock.whitelistRemove(domain); return { ok: true }; });
  ipcMain.handle('adblock-whitelist-get',    ()           => adblock.getWhitelist());
  ipcMain.handle('adblock-is-whitelisted',   (_e, domain) => adblock.isWhitelisted(domain));

  // ── Extensions ────────────────────────────────────────────
  ipcMain.handle('get-extensions', () => loadedExtensions);

  ipcMain.handle('webstore-install', async (_e, { url, extId }) => {
    try {
      win.webContents.send('ext-installing', true);
      let crxUrl = url;
      if (extId && !url.includes('clients2.google.com')) {
        crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx3&x=id%3D${extId}%26installsource%3Dondemand%26uc`;
      }
      const crxBuf = await new Promise((resolve, reject) => {
        const req = net.request({ url: crxUrl, session: mainSess });
        req.setHeader('User-Agent', CHROME_UA);
        const chunks = [];
        req.on('response', (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const redir = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
            const r2 = net.request({ url: redir, session: mainSess });
            r2.setHeader('User-Agent', CHROME_UA);
            const rc = [];
            r2.on('response', rs => { rs.on('data', c => rc.push(c)); rs.on('end', () => resolve(Buffer.concat(rc))); rs.on('error', reject); });
            r2.on('error', reject); r2.end(); return;
          }
          res.on('data', c => chunks.push(c));
          res.on('end',  () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
        req.on('error', reject); req.end();
      });
      if (!crxBuf || crxBuf.length < 100) throw new Error('Download empty or failed');
      const extName = extId || ('ext_' + Date.now());
      const tmpCrx  = path.join(os.tmpdir(), extName + '.crx');
      const destDir = path.join(EXTS_DIR, extName);
      fs.writeFileSync(tmpCrx, crxBuf);
      fs.mkdirSync(destDir, { recursive: true });
      await extractCrx(tmpCrx, destDir);
      try { fs.unlinkSync(tmpCrx); } catch (e) {}
      const ext  = await mainSess.loadExtension(destDir, { allowFileAccess: true });
      const name = ext.manifest.name || extName;
      loadedExtensions.push({ name, id: ext.id, path: destDir });
      win.webContents.send('ext-installing', false);
      win.webContents.send('extension-installed', { name });
      return { ok: true, name };
    } catch (err) {
      win.webContents.send('ext-installing', false);
      win.webContents.send('extension-install-error', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('load-extension', async () => {
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Select Chrome extension folder (unpacked)',
        properties: ['openDirectory']
      });
      if (result.canceled || !result.filePaths.length) return { ok: false, error: 'Cancelled' };
      const srcPath = result.filePaths[0];
      const extName = path.basename(srcPath);
      const destDir = path.join(EXTS_DIR, extName);
      fs.mkdirSync(destDir, { recursive: true });
      copyDirSync(srcPath, destDir);
      const ext  = await mainSess.loadExtension(destDir, { allowFileAccess: true });
      const name = ext.manifest.name || extName;
      loadedExtensions.push({ name, id: ext.id, path: destDir });
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('remove-extension', async (_e, id) => {
    try {
      await mainSess.removeExtension(id);
      const ext = loadedExtensions.find(e => e.id === id);
      if (ext && ext.path && ext.path.startsWith(EXTS_DIR)) {
        fs.rmSync(ext.path, { recursive: true, force: true });
      }
      loadedExtensions = loadedExtensions.filter(e => e.id !== id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
