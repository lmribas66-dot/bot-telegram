import { Container, getContainer } from '@cloudflare/containers';

export class LabelBot extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/telegram') {
      return new Response('ok');
    }
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

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
      body: await request.text(),
    }));
  },
};
