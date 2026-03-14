'use strict';
/**
 * adblock.js — Motore AdBlock per SafariNAO
 *
 * Scarica EasyList + EasyPrivacy + uBlock filters da jsDelivr/GitHub,
 * li parsa in strutture ottimizzate e fornisce shouldBlock(url, type, sourceUrl).
 *
 * Supporta:
 *  - Regole di dominio  (||ads.example.com^)
 *  - Regole di path     (/ads/*, /banner*)
 *  - Eccezioni          (@@||...)
 *  - Opzioni            ($script, $image, $third-party, $domain=..., ecc.)
 *  - Wildcard           (* nei pattern)
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── Liste da scaricare ────────────────────────────────────────
const FILTER_LISTS = [
  {
    name: 'EasyList',
    url:  'https://easylist.to/easylist/easylist.txt',
    fallback: 'https://cdn.jsdelivr.net/gh/nicktacular/easylist@master/easylist.txt',
  },
  {
    name: 'EasyPrivacy',
    url:  'https://easylist.to/easylist/easyprivacy.txt',
    fallback: 'https://cdn.jsdelivr.net/gh/nicktacular/easylist@master/easyprivacy.txt',
  },
  {
    name: 'uBlock Filters',
    url:  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    fallback: 'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/filters.txt',
  },
  {
    name: 'uBlock Annoyances',
    url:  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt',
    fallback: 'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/annoyances.txt',
  },
  {
    name: 'Peter Lowe Hosts',
    url:  'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    fallback: null,
  },
];

// Cache locale
let CACHE_DIR = null;

function setCacheDir(dir) {
  CACHE_DIR = dir;
  fs.mkdirSync(dir, { recursive: true });
}

function cachePath(name) {
  return path.join(CACHE_DIR, name.replace(/\s+/g, '_') + '.txt');
}

// ── Download con fallback ─────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: 15000, headers: { 'User-Agent': 'SafariNAO/2.0 AdBlock' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function downloadList(list) {
  const cp = CACHE_DIR ? cachePath(list.name) : null;

  // Usa cache se recente (< 24h)
  if (cp && fs.existsSync(cp)) {
    const age = Date.now() - fs.statSync(cp).mtimeMs;
    if (age < 24 * 60 * 60 * 1000) {
      console.log(`[AdBlock] Cache hit: ${list.name}`);
      return fs.readFileSync(cp, 'utf8');
    }
  }

  // Scarica
  let text = null;
  try {
    console.log(`[AdBlock] Downloading ${list.name}...`);
    text = await fetchUrl(list.url);
  } catch(e) {
    if (list.fallback) {
      try { text = await fetchUrl(list.fallback); } catch(e2) {}
    }
  }

  if (!text) {
    // Usa cache vecchia se disponibile
    if (cp && fs.existsSync(cp)) {
      console.log(`[AdBlock] Using stale cache for ${list.name}`);
      return fs.readFileSync(cp, 'utf8');
    }
    console.log(`[AdBlock] Failed to download ${list.name}`);
    return '';
  }

  if (cp) fs.writeFileSync(cp, text, 'utf8');
  console.log(`[AdBlock] Loaded ${list.name}: ${text.split('\n').length} lines`);
  return text;
}

// ── Parser regole ─────────────────────────────────────────────
// Strutture ottimizzate:
//   domainMap:   Map<domain, [{isException, options}]>  — O(1) lookup
//   keywordMap:  Map<keyword, [Rule]>                   — lookup per parola chiave
//   slowRules:   Rule[]                                  — regex generiche (poche)

const domainMap  = new Map();  // blocco/eccezione per dominio esatto
const keywordMap = new Map();  // indice per keyword
const slowRules  = [];         // regex compiled
let   exceptionDomains = new Set(); // @@||domain^ semplici

function extractKeyword(pattern) {
  // Prende la parola più lunga dal pattern per l'indice
  const words = pattern.split(/[^a-z0-9_\-]/i).filter(w => w.length >= 4);
  return words.sort((a,b) => b.length - a.length)[0] || null;
}

function parseOptions(optStr) {
  if (!optStr) return {};
  const opts = {};
  for (const part of optStr.split(',')) {
    const neg  = part.startsWith('~');
    const name = neg ? part.slice(1) : part;
    if (name === 'third-party' || name === '3p') opts.thirdParty = !neg;
    else if (name === 'first-party' || name === '1p') opts.firstParty = !neg;
    else if (name === 'domain') {} // gestito separatamente
    else if (['script','image','stylesheet','object','xmlhttprequest','ping','media','font','websocket','other'].includes(name)) {
      if (!opts.types) opts.types = {};
      opts.types[name] = !neg;
    }
  }
  // $domain=x.com|~y.com
  const domMatch = optStr.match(/domain=([^,]+)/);
  if (domMatch) {
    opts.domains = domMatch[1].split('|').map(d => ({ domain: d.replace(/^~/,''), allow: d.startsWith('~') }));
  }
  return opts;
}

function patternToRegex(pattern) {
  // Converti sintassi ABP in RegExp
  let re = pattern
    .replace(/\|\|/g, '(?:https?://)?(?:[a-z0-9-]+\\.)*')  // ||
    .replace(/\|/g,   '')                                    // | all'inizio/fine
    .replace(/\^/g,   '(?:[/?#]|$)')                         // ^
    .replace(/\*/g,   '.*')                                   // *
    .replace(/\./g,   '\\.')                                  // .
    .replace(/\?/g,   '\\?');                                 // ?

  try {
    return new RegExp(re, 'i');
  } catch(e) {
    return null;
  }
}

function addRule(pattern, isException, options) {
  // Dominio semplice: ||ads.example.com^
  const domainOnly = pattern.match(/^\|\|([a-z0-9.\-_]+)\^$/i);
  if (domainOnly) {
    const d = domainOnly[1].toLowerCase();
    if (isException) {
      exceptionDomains.add(d);
    } else {
      if (!domainMap.has(d)) domainMap.set(d, []);
      domainMap.get(d).push({ isException, options });
    }
    return;
  }

  // Usa keyword index per regole con pattern
  const kw = extractKeyword(pattern.replace(/\||\^|\*/g, ''));
  const rule = { pattern, isException, options, regex: null };

  if (kw && kw.length >= 4) {
    const k = kw.toLowerCase();
    if (!keywordMap.has(k)) keywordMap.set(k, []);
    keywordMap.get(k).push(rule);
  } else {
    // Fallback: compila regex (lento, poche regole)
    rule.regex = patternToRegex(pattern);
    if (rule.regex) slowRules.push(rule);
  }
}

function parseLine(line) {
  line = line.trim();

  // Salta commenti, intestazioni, regole CSS (##), regole vuote
  if (!line || line.startsWith('!') || line.startsWith('[') ||
      line.includes('##') || line.includes('#@#') || line.includes('#?#')) return;

  const isException = line.startsWith('@@');
  if (isException) line = line.slice(2);

  // Separa opzioni ($...)
  const dollarIdx = line.lastIndexOf('$');
  let options = {};
  if (dollarIdx > 0) {
    const optStr = line.slice(dollarIdx + 1);
    // Non interpretare come opzioni se sembra un percorso
    if (!optStr.includes('/') && !optStr.includes('=http')) {
      options = parseOptions(optStr);
      line    = line.slice(0, dollarIdx);
    }
  }

  if (!line) return;
  addRule(line, isException, options);
}

function parseFilterText(text) {
  let count = 0;
  for (const line of text.split('\n')) {
    parseLine(line);
    count++;
  }
  return count;
}

// ── Matcher ───────────────────────────────────────────────────
function extractDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch(e) {
    const m = url.match(/^https?:\/\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
}

function matchDomainMap(domain) {
  // Controlla dominio esatto e tutti i sottodomini
  let d = domain;
  while (d) {
    if (domainMap.has(d)) return true;
    const dot = d.indexOf('.');
    if (dot === -1) break;
    d = d.slice(dot + 1);
  }
  return false;
}

function isExceptionDomain(domain) {
  let d = domain;
  while (d) {
    if (exceptionDomains.has(d)) return true;
    const dot = d.indexOf('.');
    if (dot === -1) break;
    d = d.slice(dot + 1);
  }
  return false;
}

function matchOptions(options, url, type, sourceUrl) {
  if (!options || Object.keys(options).length === 0) return true;

  // Tipo risorsa
  if (options.types) {
    const hasPositive = Object.values(options.types).some(v => v);
    if (hasPositive && type && !options.types[type]) return false;
    if (!hasPositive && type && options.types[type] === false) return false;
  }

  // Third-party
  if (options.thirdParty !== undefined && sourceUrl) {
    const reqDomain = extractDomain(url);
    const srcDomain = extractDomain(sourceUrl);
    const isThird = reqDomain !== srcDomain && !reqDomain.endsWith('.' + srcDomain) && !srcDomain.endsWith('.' + reqDomain);
    if (options.thirdParty && !isThird) return false;
    if (options.firstParty && isThird) return false;
  }

  // Domain restrictions
  if (options.domains && sourceUrl) {
    const srcDomain = extractDomain(sourceUrl);
    let allowed = null;
    for (const d of options.domains) {
      if (srcDomain === d.domain || srcDomain.endsWith('.' + d.domain)) {
        allowed = !d.allow;
        break;
      }
    }
    if (allowed === false) return false;
    if (allowed === null) {
      const hasPositive = options.domains.some(d => !d.allow);
      if (hasPositive) return false; // dominio non nella whitelist
    }
  }

  return true;
}

function ruleMatches(rule, url, lowerUrl) {
  if (!rule.regex) {
    // Compila on-demand
    rule.regex = patternToRegex(rule.pattern);
  }
  return rule.regex && rule.regex.test(lowerUrl);
}

function shouldBlock(url, type, sourceUrl) {
  if (!url || !url.startsWith('http')) return false;

  const domain   = extractDomain(url);
  const lowerUrl = url.toLowerCase();

  // 1. Eccezioni per dominio
  if (isExceptionDomain(domain)) return false;

  // 2. Match veloce per dominio
  if (matchDomainMap(domain)) return true;

  // 3. Keyword index
  const words = lowerUrl.match(/[a-z0-9_\-]{4,}/g) || [];
  for (const word of words) {
    const rules = keywordMap.get(word);
    if (!rules) continue;
    for (const rule of rules) {
      if (!matchOptions(rule.options, url, type, sourceUrl)) continue;
      if (ruleMatches(rule, url, lowerUrl)) {
        if (rule.isException) return false;
        return true;
      }
    }
  }

  // 4. Slow rules (poche)
  for (const rule of slowRules) {
    if (!matchOptions(rule.options, url, type, sourceUrl)) continue;
    if (rule.regex && rule.regex.test(lowerUrl)) {
      if (rule.isException) return false;
      return true;
    }
  }

  return false;
}

// ── Inizializzazione ──────────────────────────────────────────
let initialized    = false;
let initializing   = false;
let totalRules     = 0;

async function init(cacheDir) {
  if (initialized || initializing) return;
  initializing = true;
  if (cacheDir) setCacheDir(cacheDir);

  const texts = await Promise.all(FILTER_LISTS.map(l => downloadList(l).catch(() => '')));

  for (const text of texts) {
    if (text) totalRules += parseFilterText(text);
  }

  initialized  = true;
  initializing = false;
  console.log(`[AdBlock] Ready — domainMap: ${domainMap.size}, keywordMap: ${keywordMap.size}, slowRules: ${slowRules.length}, exceptions: ${exceptionDomains.size}`);
}

function isReady()    { return initialized; }
function getRuleCount() { return { domains: domainMap.size, keywords: keywordMap.size, slow: slowRules.length, exceptions: exceptionDomains.size }; }

module.exports = { init, shouldBlock, isReady, getRuleCount };
