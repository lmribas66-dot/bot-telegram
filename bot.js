// Bot Telegram -> fournée automatique sur l'éditeur (site local index.html, données factices de test)
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEBUG_ALLOWED = process.env.DEBUG_ALLOWED === '1';
const WEBHOOK = !!process.env.WEBHOOK_MODE;
const SITE_FILE = [path.resolve(__dirname, 'index.html'), path.resolve(__dirname, '..', 'index.html')].find(fs.existsSync);
const SITE = process.env.SITE_URL || pathToFileURL(SITE_FILE).href;
const MAX_PER_BATCH = 200;
const API = 'https://api.telegram.org/bot' + TOKEN;

let browser = null;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] };
    if (process.env.BROWSER_CHANNEL) opts.channel = process.env.BROWSER_CHANNEL;
    browser = await chromium.launch(opts);
  }
  return browser;
}

function parseNumbers(text) {
  const seen = new Set();
  const out = [];
  for (const t of String(text).split(/[\s,;]+/)) {
    if (/^[A-Za-z0-9]{6,30}$/.test(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}
function parseTracking(text) {
  const seen = new Set();
  const out = [];
  for (const t of String(text).split(/[^A-Za-z0-9]+/)) {
    if (/^[A-Za-z0-9]{8,30}$/.test(t) && /[0-9]/.test(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// Lignes "Suivi: 6Y..." : ne garde que le numéro indiqué après "Suivi:"
function parseSuiviLines(text) {
  const seen = new Set();
  const out = [];
  const clean = String(text).replace(/[​-‍⁠﻿­]/g, '');
  for (const m of clean.matchAll(/Suivi[^A-Za-z0-9:：]{0,5}[:：][^A-Za-z0-9]{0,5}([A-Za-z0-9]{6,30})/gi)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

// Récupère l'article et la date limite de retour du message (lignes "Article : ..." et "Retour ... avant ...")
function parseInfo(text) {
  const clean = String(text).replace(/[​-‍⁠﻿­]/g, '');
  const pick = re => {
    const m = clean.match(re);
    return m ? m[1].trim().slice(0, 100) : '';
  };
  return {
    article: pick(/Article[ \t]*[:：][ \t]*([^\n]+)/i),
    retour: pick(/Retour[^\n]*?avant[ \t]+(?:le[ \t]+)?([^\n]+)/i),
  };
}

// Retourne { name, buffer } : un PNG si 1 numéro, sinon un ZIP
async function runBatch(numbers) {
  const b = await getBrowser();
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(SITE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.S && S.img && S.bcZ.length && document.getElementById('batchStart'), null, { timeout: 30000 });
    await page.waitForTimeout(1500);

    const single = numbers.length === 1;
    const timeout = 30000 + numbers.length * 4000;
    const dl = page.waitForEvent('download', { timeout });
    await page.evaluate(({ nums, zip }) => {
      document.getElementById('batchText').value = nums.join('\n');
      document.getElementById('batchZip').checked = zip;
      document.getElementById('batchStart').click();
    }, { nums: numbers, zip: !single });
    const d = await dl;
    const tmp = await d.path();
    return { name: d.suggestedFilename(), buffer: fs.readFileSync(tmp) };
  } finally {
    await ctx.close();
  }
}

async function tg(method, body) {
  const r = await fetch(API + '/' + method, body instanceof FormData
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(method + ': ' + j.description);
  return j.result;
}
const say = (chat_id, text) => tg('sendMessage', { chat_id, text }).catch(e => console.error(e.message));

async function sendFile(chat_id, f, caption) {
  const fd = new FormData();
  fd.append('chat_id', String(chat_id));
  fd.append('caption', caption);
  fd.append('document', new Blob([f.buffer]), f.name);
  await tg('sendDocument', fd);
}

let chain = Promise.resolve();
function enqueue(job) { chain = chain.then(job).catch(e => console.error(e)); }

async function handle(msg) {
  const chat = msg.chat.id;
  const uid = String(msg.from && msg.from.id);
  // En mode webhook (public), une liste vide refuse tout le monde au lieu d'autoriser tout le monde
  if (WEBHOOK && !ALLOWED.length) {
    return say(chat, 'Bot non configuré : TELEGRAM_ALLOWED_IDS est vide. Votre identifiant Telegram : ' + uid);
  }
  if (ALLOWED.length && !ALLOWED.includes(uid)) {
    return say(chat, 'Accès refusé. Votre identifiant Telegram : ' + uid);
  }
  if (DEBUG_ALLOWED && msg.text === '/debug') {
    return say(
      chat,
      'DEBUG\n' +
      'Ton ID : ' + uid + '\n' +
      'IDs autorisés : ' + (ALLOWED.length ? ALLOWED.join(', ') : '(aucun)') + '\n' +
      'Ton ID est autorisé : ' + (ALLOWED.includes(uid) ? 'OUI' : 'NON')
    );
  }
  const text = msg.text || msg.caption || '';
  if (/^\/(start|aide|help)/.test(text)) {
    return say(chat, 'Envoyez-moi des numéros de suivi (un par ligne, ou séparés par des espaces), ou un fichier .txt. Je lance la fournée et je vous renvoie les étiquettes (PNG pour un numéro, ZIP pour plusieurs). Maximum ' + MAX_PER_BATCH + ' par envoi.');
  }

  let raw = text;
  if (msg.document) {
    if (msg.document.file_size > 1024 * 1024) return say(chat, 'Fichier trop gros.');
    try {
      const f = await tg('getFile', { file_id: msg.document.file_id });
      raw = await (await fetch('https://api.telegram.org/file/bot' + TOKEN + '/' + f.file_path)).text();
    } catch (e) { return say(chat, 'Lecture du fichier impossible : ' + e.message); }
  }

  let nums = parseSuiviLines(raw);
  if (!nums.length && !/Suivi/i.test(raw)) nums = msg.forwarded ? parseTracking(raw) : parseNumbers(raw);
  if (!nums.length) {
    const i = raw.search(/Suivi/i);
    const diag = i < 0
      ? 'mot Suivi absent, texte de ' + raw.length + ' car., champs : ' + Object.keys(msg).join(',')
      : Array.from(raw.slice(i, i + 24)).map(c => c.charCodeAt(0) > 126 || c.charCodeAt(0) < 32 ? '\\u' + c.charCodeAt(0).toString(16) : c).join('');
    return say(chat, 'Aucun numéro de suivi détecté (6 à 30 caractères alphanumériques). [v4 diag : ' + diag + ']');
  }
  let note = '';
  if (nums.length > MAX_PER_BATCH) { nums = nums.slice(0, MAX_PER_BATCH); note = ' (limité à ' + MAX_PER_BATCH + ')'; }

  let caption = nums.length + ' étiquette(s) TEST';
  if (nums.length === 1) {
    const info = parseInfo(raw);
    if (info.article) caption += '\nArticle : ' + info.article;
    if (info.retour) caption += '\nRetour avant : ' + info.retour;
  }

  await say(chat, 'Fournée de ' + nums.length + ' numéro(s) en cours' + note + ' [v3 : ' + nums.slice(0, 3).join(', ') + ']...');
  enqueue(async () => {
    try {
      const f = await runBatch(nums);
      await sendFile(chat, f, caption);
    } catch (e) {
      console.error(e);
      await say(chat, 'Échec de la fournée : ' + e.message);
    }
  });
}

async function poll() {
  let offset = 0;
  console.log('Bot démarré. Site : ' + SITE + (ALLOWED.length ? ' | autorisés : ' + ALLOWED.join(',') : ' | AUCUNE restriction d\'utilisateur'));
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const u of ups) {
        offset = u.update_id + 1;
        if (u.message) handle(u.message).catch(e => console.error(e));
      }
    } catch (e) {
      console.error('Poll:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

if (process.argv[2] === '--test') {
  const nums = process.argv.slice(3);
  runBatch(nums).then(async f => {
    fs.writeFileSync(path.join(__dirname, f.name), f.buffer);
    console.log('OK', f.name, f.buffer.length, 'octets');
    if (browser) await browser.close();
  }).catch(e => { console.error('ERREUR', e); process.exit(1); });
} else if (!TOKEN) {
  console.error('Variable TELEGRAM_BOT_TOKEN manquante.');
  process.exit(1);
} else {
  if (process.env.WEBHOOK_MODE) {
    const seen = new Set();
    require('http').createServer((q, r) => {
      if (q.method !== 'POST' || q.url !== '/update') { r.end('ok'); return; }
      let body = '';
      q.on('data', c => { body += c; });
      q.on('end', () => {
        r.statusCode = 202; r.end('accepted');
        try {
          const u = JSON.parse(body);
          if (seen.has(u.update_id)) return;
          seen.add(u.update_id);
          if (u.message) handle(u.message).catch(e => console.error(e));
        } catch (e) { console.error(e); }
      });
    }).listen(process.env.PORT || 8080);
    console.log('Mode webhook, site : ' + SITE);
  } else {
    poll();
  }
}

