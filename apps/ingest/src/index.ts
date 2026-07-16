import { rejectUnconfiguredInbound } from './email-handler.js';

export default {
  email(message: ForwardableEmailMessage): void {
    rejectUnconfiguredInbound(message);
  },
} satisfies ExportedHandler<Env>;
