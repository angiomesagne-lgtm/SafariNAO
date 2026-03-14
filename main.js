const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Flags necessarie PRIMA di app.ready ──────────────────────
// Permettono il caricamento di estensioni e disabilitano restrizioni Chromium
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
app.commandLine.appendSwitch('enable-features',  'ExtensionsToolbarMenu');
app.commandLine.appendSwitch('load-extension',   '');

// ── User Agent: Chrome 120 puro su Windows ───────────────────
// Electron 28 = Chromium 120. Usiamo UA identico a Chrome reale
// così il Chrome Web Store non blocca il browser.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DATA_FILE = path.join(app.getPath('userData'), 'safarinao-data.json');
const EXTS_DIR  = path.join(app.getPath('userData'), 'extensions');

function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return {
    history: [], bookmarks: [], savedPages: [], passwords: [],
    account: { name: '', email: '', avatar: '' },
    settings: { adblock: true, searchEngine: 'google', zoom: 1, bmBar: true }
  };
}
function writeData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
}

const AD_PATTERNS = [
  '*://*.doubleclick.net/*','*://*.googlesyndication.com/*',
  '*://*.adservice.google.com/*','*://*.adservice.google.it/*',
  '*://*.adservice.google.co.uk/*','*://*.googletagmanager.com/*',
  '*://*.adnxs.com/*','*://*.advertising.com/*',
  '*://*.rubiconproject.com/*','*://*.openx.net/*',
  '*://*.pubmatic.com/*','*://*.taboola.com/*',
  '*://*.outbrain.com/*','*://*.criteo.com/*',
  '*://*.scorecardresearch.com/*','*://*.quantserve.com/*',
  '*://*.amazon-adsystem.com/*','*://*.moatads.com/*',
  '*://*.adsrvr.org/*','*://*.bidswitch.net/*',
  '*://*.mediamath.com/*','*://*.spotxchange.com/*',
  '*://*.adform.net/*','*://*.revcontent.com/*',
  '*://*.mgid.com/*','*://*.appnexus.com/*',
];

// ── Estensioni persistenti: carica quelle salvate ────────────
async function loadPersistedExtensions(sess) {
  if (!fs.existsSync(EXTS_DIR)) return [];
  const loaded = [];
  const dirs = fs.readdirSync(EXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(EXTS_DIR, d.name));
  for (const dir of dirs) {
    try {
      const ext = await sess.loadExtension(dir, { allowFileAccess: true });
      loaded.push({ name: ext.manifest.name || path.basename(dir), id: ext.id, path: dir });
    } catch(e) { console.log('Skip ext:', dir, e.message); }
  }
  return loaded;
}

async function createWindow() {
  const { default: contextMenu } = await import('electron-context-menu');

  let adblockEnabled = readData().settings?.adblock !== false;

  // ── Sessione principale (webview) ────────────────────────────
  const mainSess = session.fromPartition('persist:main');

  // Sovrascrive UA a livello di sessione — il metodo più affidabile
  mainSess.setUserAgent(CHROME_UA);
  session.defaultSession.setUserAgent(CHROME_UA);

  // Header HTTP
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

  // AdBlock sulla sessione webview
  mainSess.webRequest.onBeforeRequest({ urls: AD_PATTERNS }, (details, callback) => {
    callback({ cancel: adblockEnabled });
  });

  // ── Sessione default (BrowserWindow stesso) ──────────────────
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_UA;
    callback({ requestHeaders: details.requestHeaders });
  });

  // ── Carica estensioni persistenti ───────────────────────────
  let loadedExtensions = await loadPersistedExtensions(mainSess);

  // ── Preload JS iniettato in ogni webview ─────────────────────
  // Sovrascrive navigator.userAgent, userAgentData, window.chrome ecc.
  // a livello JS PRIMA che la pagina esegua — l'unico modo affidabile
  // per ingannare il Chrome Web Store che controlla questi valori via JS.
  const preloadPath = path.join(__dirname, 'preload-webview.js');
  if (fs.existsSync(preloadPath)) {
    mainSess.setPreloads([preloadPath]);
  }

  // ── Intercetta download .crx dal Web Store ───────────────────
  // Quando l'utente clicca "Aggiungi a Chrome" sul Web Store,
  // Chromium scarica un .crx. Noi lo intercettiamo, lo estraiamo
  // e lo carichiamo come estensione unpacked.
  mainSess.on('will-download', (event, item) => {
    const url      = item.getURL();
    const filename = item.getFilename();

    if (filename.endsWith('.crx') || url.includes('/crx/') || url.includes('extension_id')) {
      // Salva il .crx in una cartella temporanea
      const tmpPath = path.join(os.tmpdir(), filename || 'extension.crx');
      item.setSavePath(tmpPath);

      item.once('done', async (e, state) => {
        if (state !== 'completed') return;
        try {
          // Estrai il .crx (formato ZIP con header personalizzato)
          const extName = filename.replace('.crx','') || 'ext_' + Date.now();
          const destDir = path.join(EXTS_DIR, extName);
          fs.mkdirSync(destDir, { recursive: true });

          await extractCrx(tmpPath, destDir);

          const ext = await mainSess.loadExtension(destDir, { allowFileAccess: true });
          const name = ext.manifest.name || extName;
          loadedExtensions.push({ name, id: ext.id, path: destDir });

          // Notifica il renderer
          win.webContents.send('extension-installed', { name });
          fs.unlinkSync(tmpPath);
        } catch(err) {
          console.error('CRX install error:', err);
          win.webContents.send('extension-install-error', err.message);
        }
      });
    }
  });

  const win = new BrowserWindow({
    width: 1300, height: 860,
    minWidth: 800, minHeight: 600,
    frame: false,
    movable: true,
    resizable: true,
    backgroundColor: '#1c1c1e',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      // UA anche per il renderer stesso
      additionalArguments: [`--user-agent=${CHROME_UA}`]
    }
  });

  contextMenu({ window: win, showInspectElement: true });
  win.loadFile('index.html');

  // ── Drag manuale ─────────────────────────────────────────────
  let dragOffsetX = 0, dragOffsetY = 0, isDragging = false;

  ipcMain.on('drag-start', (e, { mouseX, mouseY }) => {
    if (win.isMaximized()) return;
    isDragging = true;
    const [winX, winY] = win.getPosition();
    dragOffsetX = mouseX - winX;
    dragOffsetY = mouseY - winY;
  });
  ipcMain.on('drag-move', (e, { mouseX, mouseY }) => {
    if (!isDragging) return;
    win.setPosition(Math.round(mouseX - dragOffsetX), Math.round(mouseY - dragOffsetY));
  });
  ipcMain.on('drag-end', () => { isDragging = false; });

  // ── Window controls ──────────────────────────────────────────
  ipcMain.on('window-ctrl', (e, cmd) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if      (cmd === 'close') w.close();
    else if (cmd === 'min')   w.minimize();
    else if (cmd === 'max')   w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.handle('is-maximized', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender); return w ? w.isMaximized() : false;
  });
  win.on('maximize',          () => win.webContents.send('window-state', 'maximized'));
  win.on('unmaximize',        () => win.webContents.send('window-state', 'normal'));
  win.on('enter-full-screen', () => win.webContents.send('window-state', 'fullscreen'));
  win.on('leave-full-screen', () => win.webContents.send('window-state', 'normal'));

  // ── Data ─────────────────────────────────────────────────────
  ipcMain.handle('get-data', () => readData());
  ipcMain.handle('save-account', (e, account) => {
    const data = readData(); data.account = { ...data.account, ...account }; writeData(data); return { ok: true };
  });
  ipcMain.handle('save-settings', (e, settings) => {
    const data = readData(); data.settings = { ...data.settings, ...settings };
    adblockEnabled = data.settings.adblock !== false;
    writeData(data); return { ok: true };
  });
  ipcMain.handle('add-history', (e, item) => {
    const data = readData();
    const recent = data.history.slice(0, 5).map(h => h.url);
    if (!recent.includes(item.url)) {
      data.history.unshift({ ...item, timestamp: Date.now() });
      if (data.history.length > 2000) data.history = data.history.slice(0, 2000);
      writeData(data);
    }
    return { ok: true };
  });
  ipcMain.handle('delete-history-item', (e, index) => {
    const data = readData(); data.history.splice(index, 1); writeData(data); return { ok: true };
  });
  ipcMain.handle('clear-history', () => {
    const data = readData(); data.history = []; writeData(data); return { ok: true };
  });

  // ── Bookmarks ────────────────────────────────────────────────
  ipcMain.handle('get-bookmarks', () => readData().bookmarks || []);
  ipcMain.handle('add-bookmark', (e, bookmark) => {
    const data = readData();
    if (!data.bookmarks) data.bookmarks = [];
    const exists = data.bookmarks.find(b => b.url === bookmark.url);
    if (!exists) data.bookmarks.unshift({ ...bookmark, id: Date.now() });
    writeData(data); return { ok: true, exists: !!exists };
  });
  ipcMain.handle('remove-bookmark', (e, url) => {
    const data = readData();
    if (!data.bookmarks) data.bookmarks = [];
    data.bookmarks = data.bookmarks.filter(b => b.url !== url);
    writeData(data); return { ok: true };
  });
  ipcMain.handle('is-bookmarked', (e, url) => {
    const data = readData();
    return !!(data.bookmarks || []).find(b => b.url === url);
  });
  ipcMain.handle('clear-all', () => {
    writeData({ history:[], bookmarks:[], savedPages:[], passwords:[], account:{name:'',email:'',avatar:''}, settings:{adblock:true,searchEngine:'google',zoom:1,bmBar:true} });
    return { ok: true };
  });

  // ── Saved pages ──────────────────────────────────────────────
  ipcMain.handle('get-saved-pages', () => readData().savedPages || []);
  ipcMain.handle('save-page', (e, page) => {
    const data = readData();
    if (!data.savedPages) data.savedPages = [];
    data.savedPages.unshift({ ...page, savedAt: Date.now() });
    writeData(data); return { ok: true };
  });
  ipcMain.handle('delete-saved-page', (e, index) => {
    const data = readData();
    if (data.savedPages) data.savedPages.splice(index, 1);
    writeData(data); return { ok: true };
  });

  // ── Passwords ────────────────────────────────────────────────
  ipcMain.handle('save-password', (e, entry) => {
    const data = readData();
    if (!data.passwords) data.passwords = [];
    data.passwords.unshift(entry);
    writeData(data); return { ok: true };
  });
  ipcMain.handle('delete-password', (e, index) => {
    const data = readData();
    if (data.passwords) data.passwords.splice(index, 1);
    writeData(data); return { ok: true };
  });

  // ── Extensions ───────────────────────────────────────────────
  ipcMain.handle('get-extensions', () => loadedExtensions);

  // Carica cartella unpacked manualmente
  ipcMain.handle('load-extension', async () => {
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Seleziona cartella estensione Chrome (unpacked)',
        properties: ['openDirectory']
      });
      if (result.canceled || !result.filePaths.length) return { ok: false, error: 'Annullato' };

      const srcPath = result.filePaths[0];
      const extName = path.basename(srcPath);
      const destDir = path.join(EXTS_DIR, extName);

      // Copia nella cartella persistente
      fs.mkdirSync(destDir, { recursive: true });
      copyDirSync(srcPath, destDir);

      const ext  = await mainSess.loadExtension(destDir, { allowFileAccess: true });
      const name = ext.manifest.name || extName;
      loadedExtensions.push({ name, id: ext.id, path: destDir });
      return { ok: true, name };
    } catch(err) {
      return { ok: false, error: err.message };
    }
  });

  // Rimuovi estensione
  ipcMain.handle('remove-extension', async (e, id) => {
    try {
      await mainSess.removeExtension(id);
      const ext = loadedExtensions.find(e => e.id === id);
      if (ext?.path && ext.path.startsWith(EXTS_DIR)) {
        fs.rmSync(ext.path, { recursive: true, force: true });
      }
      loadedExtensions = loadedExtensions.filter(e => e.id !== id);
      return { ok: true };
    } catch(err) {
      return { ok: false, error: err.message };
    }
  });
}

// ── Estrai .crx (ZIP con header proprietario di Chrome) ──────
async function extractCrx(crxPath, destDir) {
  const AdmZip = (() => { try { return require('adm-zip'); } catch(e) { return null; } })();

  const buf = fs.readFileSync(crxPath);

  // CRX3 format: magic 4 bytes + version 4 + header_size 4 + proto header + ZIP data
  // CRX2 format: magic 4 + version 4 + pub_key_len 4 + sig_len 4 + pub_key + sig + ZIP
  const magic = buf.slice(0, 4).toString();
  if (magic !== 'Cr24') throw new Error('File non è un CRX valido');

  const version = buf.readUInt32LE(4);
  let zipStart;

  if (version === 3) {
    const headerSize = buf.readUInt32LE(8);
    zipStart = 12 + headerSize;
  } else if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen    = buf.readUInt32LE(12);
    zipStart = 16 + pubKeyLen + sigLen;
  } else {
    throw new Error('Versione CRX non supportata: ' + version);
  }

  const zipBuf = buf.slice(zipStart);

  if (AdmZip) {
    // usa adm-zip se disponibile
    const zip = new AdmZip(zipBuf);
    zip.extractAllTo(destDir, true);
  } else {
    // fallback: scrivi lo zip e usa unzip di sistema (solo macOS/Linux)
    const tmpZip = crxPath + '.zip';
    fs.writeFileSync(tmpZip, zipBuf);
    const { execSync } = require('child_process');
    execSync(`unzip -o "${tmpZip}" -d "${destDir}"`);
    fs.unlinkSync(tmpZip);
  }
}

// ── Copia directory ricorsiva ────────────────────────────────
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, item.name);
    const d = path.join(dest, item.name);
    if (item.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });