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
      if (update.message) ctx.waitUntil(planifier(env, update.message).catch(e => console.error(e)));
      return toContainer(env, update);
    }

    if (url.pathname === '/forward') {
      if (!env.FORWARD_SECRET || request.headers.get('X-Forward-Secret') !== env.FORWARD_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const body = await request.json();
      const chatId = String(body.chat_id || (env.TELEGRAM_ALLOWED_IDS || '').split(',')[0].trim());
      if (!body.text || !chatId) return new Response('text et chat_id requis', { status: 400 });
      return toContainer(env, {
        update_id: Date.now(),
        message: { chat: { id: chatId }, from: { id: chatId }, text: String(body.text), forwarded: true },
      });
    }

    return new Response('not found', { status: 404 });
  },
};
