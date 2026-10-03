import { DurableObject } from 'cloudflare:workers';

const MOIS = {
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
};

const clean = t => String(t).replace(/[​-‍⁠﻿­]/g, '');
const isoOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

export const todayParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoOf(y, m, d + n);
}

// Numéros après "Suivi :" (même règle que bot.js)
export function parseSuivi(text) {
  const out = new Set();
  for (const m of clean(text).matchAll(/Suivi[^A-Za-z0-9:：]{0,5}[:：][^A-Za-z0-9]{0,5}([A-Za-z0-9]{6,30})/gi)) out.add(m[1]);
  return [...out];
}

// Lignes "Article : ..." et "Retour ... avant ..."
export function parseInfo(text) {
  const t = clean(text);
  const pick = re => {
    const m = t.match(re);
    return m ? m[1].trim().slice(0, 100) : '';
  };
  return {
    article: pick(/Article[ \t]*[:：][ \t]*([^\n]+)/i),
    retour: pick(/Retour[^\n]*?avant[ \t]+(?:le[ \t]+)?([^\n]+)/i),
  };
}

// "jeudi 8 octobre", "04/10/2026", "4/10" -> "YYYY-MM-DD" (ou null)
// Sans année, on prend l'année en cours, ou la suivante si la date est passée depuis plus de 60 jours.
export function parseRetourDate(label, todayIso) {
  let m1, d, m, y = 0;
  if ((m1 = label.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/))) {
    d = +m1[1]; m = +m1[2]; y = m1[3] ? +m1[3] : 0;
    if (y && y < 100) y += 2000;
  } else if ((m1 = label.match(/(\d{1,2})(?:er)?[ \t]+([A-Za-zéèêûîôàç]+)(?:[ \t]+(\d{4}))?/))) {
    d = +m1[1]; m = MOIS[m1[2].toLowerCase()]; y = m1[3] ? +m1[3] : 0;
  }
  if (!m || !d) return null;
  if (!y) {
    y = +todayIso.slice(0, 4);
    if ((Date.parse(todayIso) - Date.parse(isoOf(y, m, d))) / 864e5 > 60) y++;
  }
  const iso = isoOf(y, m, d);
  const [yy, mm, dd] = iso.split('-').map(Number);
  return yy === y && mm === m && dd === d ? iso : null;
}

// Un rappel par numéro de suivi, la veille de la date de retour. Un même numéro réécrit le précédent.
export class Reminders extends DurableObject {
  async add(rec) {
    await this.ctx.storage.put('r:' + rec.suivi, rec);
  }

  // Rappels à envoyer aujourd'hui ; supprime ceux dont la date de retour est passée
  async due(todayIso) {
    const out = [];
    for (const [key, rec] of await this.ctx.storage.list({ prefix: 'r:' })) {
      if (rec.retourIso < todayIso) await this.ctx.storage.delete(key);
      else if (rec.remindIso <= todayIso) out.push(rec);
    }
    return out;
  }

  async done(suivi) {
    await this.ctx.storage.delete('r:' + suivi);
  }
}

async function tgSend(env, chat_id, text) {
  const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text }),
  });
  return r.ok;
}

const store = env => env.REMINDERS.get(env.REMINDERS.idFromName('main'));

// Appelé pour chaque message reçu : programme un rappel si le message a un Suivi et une date de retour
export async function planifier(env, msg) {
  const liste = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
  const uid = String(msg.from && msg.from.id);
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  // Groupe : valable si le groupe est autorisé ; sinon seul un utilisateur autorisé programme un rappel
  const ok = isGroup
    ? liste(env.TELEGRAM_ALLOWED_CHATS).includes(String(msg.chat.id))
    : liste(env.TELEGRAM_ALLOWED_IDS).includes(uid);
  if (!ok) return;

  const text = msg.text || msg.caption || '';
  const suivis = parseSuivi(text);
  if (!suivis.length) return;
  const info = parseInfo(text);
  const retourIso = info.retour && parseRetourDate(info.retour, todayParis());
  if (!retourIso) return;

  const remindIso = addDays(retourIso, -1);
  for (const suivi of suivis) {
    await store(env).add({ suivi, chat: msg.chat.id, article: info.article, retourTxt: info.retour, retourIso, remindIso });
  }
  await tgSend(env, msg.chat.id, 'Rappel programmé la veille du retour (' + info.retour + ').');
}

// Appelé chaque jour par le cron : envoie les rappels du jour
export async function envoyerRappels(env) {
  const today = todayParis();
  const s = store(env);
  for (const rec of await s.due(today)) {
    const quand = rec.retourIso === today ? "aujourd'hui" : 'demain';
    const lignes = ['Rappel : retour à faire ' + quand + ' (' + rec.retourTxt + ')'];
    if (rec.article) lignes.push('Article : ' + rec.article);
    lignes.push('Suivi : ' + rec.suivi);
    if (await tgSend(env, rec.chat, lignes.join('\n'))) await s.done(rec.suivi);
  }
}
