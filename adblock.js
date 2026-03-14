'use strict';
/**
 * adblock.js — SafariNAO AdBlock Engine v4
 *
 * STRATEGIA:
 *  - YouTube: SOLO approccio cosmetico (CSS + JS skip) — ZERO blocchi di rete
 *    su domini youtube/google. I blocchi di rete su YouTube rompono i video.
 *  - Altri siti: blocco di rete via EasyList + EasyPrivacy + uBlock + AdGuard
 *  - Whitelist per-sito persistente
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── Domini da NON bloccare mai a livello di rete ─────────────
// Bloccarli causa caricamenti lenti / video rotti
const NETWORK_SAFE_DOMAINS = new Set([
  'youtube.com','youtu.be','ytimg.com','yt3.ggpht.com',
  'googlevideo.com','youtube-nocookie.com','ggpht.com',
  'googleapis.com','gstatic.com','google.com','accounts.google.com',
  'ssl.gstatic.com','fonts.gstatic.com','fonts.googleapis.com',
  'play.google.com','googleusercontent.com',
  // CDN e player comuni che non devono essere bloccati
  'twitch.tv','twitchsvc.net','jtvnw.net',
  'netflix.com','nflxvideo.net','nflximg.net',
  'spotify.com','scdn.co','spotifycdn.com',
  'facebook.com','fbcdn.net','instagram.com',
  'twitter.com','x.com','t.co','twimg.com',
  'reddit.com','redd.it','redditmedia.com','redditstatic.com',
  'amazon.com','amazonaws.com','cloudfront.net',
  'cloudflare.com','cdnjs.cloudflare.com',
  'jsdelivr.net','unpkg.com',
  'github.com','githubusercontent.com','githubassets.com',
  'wikipedia.org','wikimedia.org',
]);

function isSafeDomain(url) {
  try {
    let host = new URL(url).hostname.toLowerCase();
    // controlla host e tutti i sottodomini
    while (host) {
      if (NETWORK_SAFE_DOMAINS.has(host)) return true;
      const dot = host.indexOf('.');
      if (dot === -1) break;
      host = host.slice(dot + 1);
    }
  } catch (e) {}
  return false;
}

// ── Filter lists ─────────────────────────────────────────────
const FILTER_LISTS = [
  {
    name: 'EasyList',
    url:  'https://easylist.to/easylist/easylist.txt',
    fb:   'https://cdn.jsdelivr.net/gh/easylist/easylist@master/easylist/easylist.txt',
  },
  {
    name: 'EasyPrivacy',
    url:  'https://easylist.to/easylist/easyprivacy.txt',
    fb:   'https://cdn.jsdelivr.net/gh/easylist/easylist@master/easylist/easyprivacy.txt',
  },
  {
    name: 'uBlock Filters',
    url:  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    fb:   'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/filters.txt',
  },
  {
    name: 'uBlock Unbreak',
    url:  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
    fb:   'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/unbreak.txt',
  },
  {
    name: 'AdGuard Base',
    url:  'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_2_Base/filter.txt',
    fb:   'https://cdn.jsdelivr.net/gh/AdguardTeam/FiltersRegistry@master/filters/filter_2_Base/filter.txt',
  },
  {
    name: 'Peter Lowe',
    url:  'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    fb:   null,
  },
];

// ── State ─────────────────────────────────────────────────────
let CACHE_DIR      = null;
let initialized    = false;
let initializing   = false;

const domainMap        = new Map();
const exceptionDomains = new Set();
const keywordBuckets   = new Map();
const slowRules        = [];
const userWhitelist    = new Set();

// ── Cache ──────────────────────────────────────────────────────
function setCacheDir(dir) {
  CACHE_DIR = dir;
  fs.mkdirSync(dir, { recursive: true });
  try {
    const wl = path.join(dir, 'whitelist.json');
    if (fs.existsSync(wl)) JSON.parse(fs.readFileSync(wl,'utf8')).forEach(d => userWhitelist.add(d));
  } catch(e) {}
}

function saveWhitelist() {
  try {
    if (CACHE_DIR) fs.writeFileSync(path.join(CACHE_DIR,'whitelist.json'), JSON.stringify([...userWhitelist]),'utf8');
  } catch(e) {}
}

function fetchUrl(url, timeout=20000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout, headers:{'User-Agent':'SafariNAO/4.0 AdBlock'} }, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location)
        return fetchUrl(res.headers.location, timeout).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const c=[];
      res.on('data', d=>c.push(d));
      res.on('end',  ()=>resolve(Buffer.concat(c).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', ()=>{ req.destroy(); reject(new Error('Timeout')); });
  });
}

async function downloadList(list) {
  const cp = CACHE_DIR ? path.join(CACHE_DIR, list.name.replace(/\s+/g,'_')+'.txt') : null;
  if (cp && fs.existsSync(cp)) {
    if (Date.now() - fs.statSync(cp).mtimeMs < 24*3600*1000)
      return fs.readFileSync(cp,'utf8');
  }
  let text = null;
  try { text = await fetchUrl(list.url); }
  catch(e) { if (list.fb) try { text = await fetchUrl(list.fb); } catch(e2){} }
  if (!text && cp && fs.existsSync(cp)) return fs.readFileSync(cp,'utf8');
  if (!text) { console.log(`[AdBlock] Failed: ${list.name}`); return ''; }
  if (cp) fs.writeFileSync(cp, text, 'utf8');
  console.log(`[AdBlock] OK: ${list.name} (${Math.round(text.length/1024)}KB)`);
  return text;
}

// ── Parser ────────────────────────────────────────────────────
function extractKeyword(pat) {
  const words = pat.replace(/\|\||\^|\*|\?|=/g,' ').split(/[^a-z0-9_\-.]/i).filter(w=>w.length>=5);
  return words.sort((a,b)=>b.length-a.length)[0]?.toLowerCase() || null;
}

function patternToRegex(pat) {
  const re = pat
    .replace(/[.+?{}[\]\\]/g,'\\$&')
    .replace(/\|\|/g,'(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*')
    .replace(/\^/g,'(?:[/?#&]|$)')
    .replace(/\*/g,'.*')
    .replace(/^\|/,'^')
    .replace(/\|$/,'$');
  try { return new RegExp(re,'i'); } catch(e) { return null; }
}

function parseOptions(optStr) {
  const opts={};
  for (const part of optStr.split(',')) {
    const neg=part.startsWith('~'), name=neg?part.slice(1):part;
    if (name==='third-party'||name==='3p') { opts.thirdParty=!neg; continue; }
    if (name==='first-party'||name==='1p') { opts.firstParty=!neg; continue; }
    if (['script','image','stylesheet','xmlhttprequest','media','font','websocket','object','ping','other'].includes(name)) {
      if (!opts.types) opts.types={};
      opts.types[name]=!neg;
    }
  }
  const dm=optStr.match(/domain=([^,]+)/);
  if (dm) opts.domains=dm[1].split('|').map(d=>({d:d.replace(/^~/,''),allow:d.startsWith('~')}));
  return opts;
}

function addRule(pattern, isException, options) {
  // Dominio semplice
  const dom=pattern.match(/^\|\|([a-z0-9._-]+)\^$/i);
  if (dom) {
    const d=dom[1].toLowerCase();
    if (isSafeDomain('https://'+d+'/')) return; // non aggiungere domini sicuri
    if (isException) exceptionDomains.add(d);
    else domainMap.set(d, options||{});
    return;
  }
  const rule={pattern,isException,options:options||{},regex:null};
  const kw=extractKeyword(pattern);
  if (kw) {
    if (!keywordBuckets.has(kw)) keywordBuckets.set(kw,[]);
    keywordBuckets.get(kw).push(rule);
  } else {
    rule.regex=patternToRegex(pattern);
    if (rule.regex) slowRules.push(rule);
  }
}

function parseLine(line) {
  line=line.trim();
  if (!line||line.startsWith('!')||line.startsWith('[')||
      line.includes('##')||line.includes('#@#')||line.includes('#?#')||line.includes('#$#')) return;
  const isException=line.startsWith('@@');
  if (isException) line=line.slice(2);
  let options={};
  const di=line.lastIndexOf('$');
  if (di>0) {
    const optStr=line.slice(di+1);
    if (!/[/\\]/.test(optStr)&&!optStr.startsWith('http')) {
      if (optStr.includes('redirect=')||optStr.includes('redirect-rule=')) return;
      try { options=parseOptions(optStr); } catch(e){}
      line=line.slice(0,di);
    }
  }
  if (!line) return;
  addRule(line,isException,options);
}

function parseText(text) {
  for (const line of text.split('\n')) { try { parseLine(line); } catch(e){} }
}

// ── Matcher ───────────────────────────────────────────────────
function extractDomain(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch(e) { const m=url.match(/^https?:\/\/([^/?#:]+)/i); return m?m[1].toLowerCase():''; }
}

function isExceptionDomain(host) {
  let d=host;
  while (d) {
    if (exceptionDomains.has(d)) return true;
    const dot=d.indexOf('.'); if (dot===-1) break; d=d.slice(dot+1);
  }
  return false;
}

function matchDomainMap(host) {
  let d=host;
  while (d) {
    if (domainMap.has(d)) return domainMap.get(d);
    const dot=d.indexOf('.'); if (dot===-1) break; d=d.slice(dot+1);
  }
  return null;
}

function matchOptions(opts,url,type,src) {
  if (!opts||!Object.keys(opts).length) return true;
  if (opts.types&&type) {
    const pos=Object.entries(opts.types).filter(([,v])=>v).map(([k])=>k);
    const neg=Object.entries(opts.types).filter(([,v])=>!v).map(([k])=>k);
    if (pos.length>0&&!pos.includes(type)) return false;
    if (neg.includes(type)) return false;
  }
  if ((opts.thirdParty!==undefined||opts.firstParty!==undefined)&&src) {
    const rd=extractDomain(url),sd=extractDomain(src);
    const isThird=rd!==sd&&!rd.endsWith('.'+sd)&&!sd.endsWith('.'+rd);
    if (opts.thirdParty&&!isThird) return false;
    if (opts.firstParty&&isThird) return false;
  }
  if (opts.domains&&src) {
    const sd=extractDomain(src);
    let matched=null;
    for (const {d,allow} of opts.domains) {
      if (sd===d||sd.endsWith('.'+d)) { matched=allow; break; }
    }
    if (matched===null&&opts.domains.some(({allow})=>!allow)) return false;
    if (matched===true) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════
//  YOUTUBE — COSMETIC ONLY (no blocchi di rete)
// ═══════════════════════════════════════════════════════════════

const YOUTUBE_CSS = `
.ytp-ad-overlay-container,.ytp-ad-text-overlay,.ytp-ad-timed-pie-countdown-container,
.ytp-ad-skip-button-container,.ytp-ad-image-overlay,.ytp-ad-module,
.ytp-ad-player-overlay,.ytp-ad-player-overlay-layout,.ytp-ad-simple-ad-badge,
.ytp-ad-badge,.ytp-suggested-action,.ytp-suggested-action-badge,
.ytp-ad-preview-container,.ytp-ad-preview-text,.ytp-ad-progress-list,
.ytp-ad-player-overlay-instream-info,.ytp-ad-action-interstitial,
#masthead-ad,#player-ads,.ytd-display-ad-renderer,ytd-display-ad-renderer,
ytd-promoted-sparkles-web-renderer,ytd-promoted-video-renderer,
ytd-search-pyv-renderer,ytd-compact-promoted-video-renderer,
ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer,ytd-banner-promo-renderer,
ytd-statement-banner-renderer,ytd-mealbar-promo-renderer,ytd-primetime-promo-renderer,
ytd-premium-yoodle-renderer,ytd-action-companion-ad-renderer,
ytd-player-legacy-desktop-watch-ads-renderer,
ytd-item-section-renderer:has(ytd-ad-slot-renderer),
ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
tp-yt-paper-dialog:has(ytd-mealbar-promo-renderer),
#abp,.ad-showing .ytp-pause-overlay,.ytp-ad-persistent-progress-bar-container
{ display:none!important; visibility:hidden!important; pointer-events:none!important; }
`.replace(/\n/g,' ');

const YOUTUBE_SKIP_SCRIPT = `
(function(){
  if(window._snaoYT) return; window._snaoYT=true;
  let lastSkip=0;
  function run(){
    // Skip button
    const btn=document.querySelector(
      '.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern button'
    );
    if(btn&&Date.now()-lastSkip>1000){ btn.click(); lastSkip=Date.now(); return; }
    // Porta il video alla fine se ad in play
    const v=document.querySelector('video');
    if(!v||!v.duration||!isFinite(v.duration)) return;
    const adEl=document.querySelector('.ad-showing,.ytp-ad-player-overlay,.ytp-ad-module');
    if(adEl){
      if(!v._snaoVol){ v._snaoVol=v.volume||1; }
      v.muted=true;
      try{ v.currentTime=v.duration-0.1; }catch(e){}
    } else if(v._snaoVol){
      v.muted=false; v.volume=v._snaoVol; delete v._snaoVol;
    }
  }
  setInterval(run,300);

  // Observer per SPA navigation
  const mo=new MutationObserver(()=>run());
  const observe=()=>{ const b=document.body; if(b) mo.observe(b,{childList:true,subtree:true}); };
  if(document.body) observe(); else document.addEventListener('DOMContentLoaded',observe);

  // Blocca beacon/tracking fetch (NON i video)
  const _f=window.fetch;
  window.fetch=function(input,init){
    const u=typeof input==='string'?input:(input&&input.url)||'';
    if(/\\/pagead\\/|\\/api\\/stats\\/ads|\\/ptracking|doubleclick\\.net/.test(u))
      return Promise.resolve(new Response('',{status:204}));
    return _f.apply(this,arguments);
  };
  const _o=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    if(typeof u==='string'&&/\\/pagead\\/|doubleclick\\.net/.test(u)) u='about:blank';
    return _o.apply(this,arguments);
  };
  console.log('[SafariNAO] YouTube AdBlock v4 attivo');
})();
`;

// ═══════════════════════════════════════════════════════════════
//  API PUBBLICA
// ═══════════════════════════════════════════════════════════════

function shouldBlock(url, type, sourceUrl) {
  if (!url||!url.startsWith('http')) return false;

  // MAI bloccare domini sicuri a livello di rete
  if (isSafeDomain(url)) return false;

  const host = extractDomain(url);
  const src  = sourceUrl ? extractDomain(sourceUrl) : '';

  // Whitelist utente
  if (src && userWhitelist.has(src)) return false;
  if (host && userWhitelist.has(host)) return false;

  // Eccezioni filtri
  if (isExceptionDomain(host)) return false;

  // Domain map O(1)
  const domOpts = matchDomainMap(host);
  if (domOpts !== null && matchOptions(domOpts, url, type, sourceUrl)) return true;

  // Keyword index
  const lower = url.toLowerCase();
  const words = lower.match(/[a-z0-9_\-.]{5,}/g) || [];
  for (const word of words) {
    const rules = keywordBuckets.get(word);
    if (!rules) continue;
    for (const rule of rules) {
      if (!matchOptions(rule.options, url, type, sourceUrl)) continue;
      if (!rule.regex) rule.regex = patternToRegex(rule.pattern);
      if (rule.regex && rule.regex.test(lower)) {
        if (rule.isException) return false;
        return true;
      }
    }
  }

  // Slow rules
  for (const rule of slowRules) {
    if (!matchOptions(rule.options, url, type, sourceUrl)) continue;
    if (rule.regex && rule.regex.test(lower)) {
      if (rule.isException) return false;
      return true;
    }
  }

  return false;
}

function whitelistAdd(domain)    { domain=domain.toLowerCase().replace(/^www\./,''); userWhitelist.add(domain);    saveWhitelist(); }
function whitelistRemove(domain) { domain=domain.toLowerCase().replace(/^www\./,''); userWhitelist.delete(domain); saveWhitelist(); }
function isWhitelisted(domain)   { return userWhitelist.has(domain.toLowerCase().replace(/^www\./,'')); }
function getWhitelist()          { return [...userWhitelist]; }
function getYoutubeCosmeticCSS() { return YOUTUBE_CSS; }
function getYoutubeSkipScript()  { return YOUTUBE_SKIP_SCRIPT; }

async function init(cacheDir) {
  if (initialized||initializing) return;
  initializing=true;
  if (cacheDir) setCacheDir(cacheDir);
  console.log('[AdBlock] Avvio download liste filtro...');
  const texts = await Promise.all(FILTER_LISTS.map(l => downloadList(l).catch(()=>'')));
  for (const t of texts) if (t) parseText(t);
  initialized=true; initializing=false;
  const c=getRuleCount();
  console.log(`[AdBlock] Pronto — domini:${c.domains} keyword:${c.keywords} slow:${c.slow}`);
}

function isReady()     { return initialized; }
function getRuleCount(){ return { domains:domainMap.size, keywords:keywordBuckets.size, slow:slowRules.length, exceptions:exceptionDomains.size, whitelist:userWhitelist.size }; }

module.exports = { init, shouldBlock, isReady, getRuleCount, whitelistAdd, whitelistRemove, isWhitelisted, getWhitelist, getYoutubeCosmeticCSS, getYoutubeSkipScript };
