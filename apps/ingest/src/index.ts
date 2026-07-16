import { handleInboundEmail } from './email-handler.js';

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleInboundEmail(message, {
      db: env.DB,
      rawEmails: env.RAW_EMAILS,
      enqueue: async (body) => {
        await env.INBOUND_QUEUE.send(body, { contentType: 'json' });
      },
    }, {
      messageId: crypto.randomUUID(),
      receivedAt: Date.now(),
    });
  },
} satisfies ExportedHandler<Env>;
