import { Container, getContainer } from '@cloudflare/containers';
import { planifier, envoyerRappels } from './rappel.js';

export { Reminders } from './rappel.js';

export class LabelBot extends Container {
  defaultPort = 8080;
  sleepAfter = '3m';
}

async function toContainer(env, update) {
  const container = getContainer(env.LABEL_BOT, 'main');
  await container.startAndWaitForPorts({
    startOptions: {
      envVars: {
        WEBHOOK_MODE: '1',
        TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_ALLOWED_IDS: env.TELEGRAM_ALLOWED_IDS || '',
        TELEGRAM_ALLOWED_CHATS: env.TELEGRAM_ALLOWED_CHATS || '',
        MAIN_BOT_URL: env.MAIN_BOT_URL || '',
        FORWARD_SECRET: (env.FORWARD_SECRET || '').trim(),
      },
    },
    cancellationOptions: { portReadyTimeoutMS: 60000 },
  });
  return container.fetch(new Request('http://container/update', {
    method: 'POST',
    body: JSON.stringify(update),
  }));
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(envoyerRappels(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'POST') return new Response('ok');

    if (url.pathname === '/telegram') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json();
      const m = update.message;
      if (!m) return new Response('ok');
      // Groupe : le conteneur ne démarre que pour /id ou un message "Suivi" d'un groupe autorisé
      if (m.chat.type === 'group' || m.chat.type === 'supergroup') {
        const t = m.text || m.caption || '';
        const chats = (env.TELEGRAM_ALLOWED_CHATS || '').split(',').map(s => s.trim());
        if (!/^\/id(@\w+)?$/i.test(t.trim()) && !(chats.includes(String(m.chat.id)) && /Suivi/i.test(t))) {
          return new Response('ok');
        }
        // Groupe vérifié ici : le conteneur ne dépend pas de ses variables d'environnement, qui peuvent être périmées
        if (chats.includes(String(m.chat.id))) m.group_ok = true;
      }
      ctx.waitUntil(planifier(env, m).catch(e => console.error(e)));
      return toContainer(env, update);
    }

    if (url.pathname === '/forward') {
      const fwd = (env.FORWARD_SECRET || '').trim();
      if (!fwd || request.headers.get('X-Forward-Secret') !== fwd) {
        return new Response('forbidden', { status: 403 });
      }
      const body = await request.json();
      const liste = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
      const ids = liste(env.TELEGRAM_ALLOWED_IDS);
      const chats = liste(env.TELEGRAM_ALLOWED_CHATS);
      // Sans chat_id : le premier groupe autorisé, sinon le premier utilisateur autorisé
      const chatId = String(body.chat_id || chats[0] || ids[0] || '');
      if (!body.text || !chatId) return new Response('text et chat_id requis', { status: 400 });
      const isGroup = chats.includes(chatId);
      if (!isGroup && !ids.includes(chatId)) return new Response('chat_id non autorise', { status: 400 });
      const message = isGroup
        ? { chat: { id: chatId, type: 'group' }, from: { id: chatId }, text: String(body.text), forwarded: true, group_ok: true }
        : { chat: { id: chatId }, from: { id: chatId }, text: String(body.text), forwarded: true };
      ctx.waitUntil(planifier(env, message).catch(e => console.error(e)));
      // Réponse immédiate : l'appelant n'attend pas le démarrage du conteneur
      ctx.waitUntil(toContainer(env, { update_id: Date.now(), message }).catch(e => console.error(e)));
      return new Response('accepted', { status: 202 });
    }

    return new Response('not found', { status: 404 });
  },
};
