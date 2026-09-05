import {
  INBOUND_DEAD_LETTER_QUEUE_NAME,
  INBOUND_QUEUE_NAME,
  OUTBOUND_DEAD_LETTER_QUEUE_NAME,
  OUTBOUND_QUEUE_NAME,
} from '@cf-webmail/contracts';
import { handleDeadLetterBatch } from './dead-letter-consumer.js';
import { recoverRequestedDeadLetters } from './dead-letter-recovery.js';
import { handleInboundBatch } from './inbound-consumer.js';
import { recoverInboundHandoffs } from './inbound-recovery.js';
import { handleOutboundBatch } from './outbound-consumer.js';
import { recoverOutboundDeliveries } from './outbound-recovery.js';
import { reconcileInboundStaging } from './staging-reconciliation.js';
import { auditCanonicalStorage } from './storage-audit.js';
import { processApprovedRetentionRuns } from './retention-runner.js';
import { pruneExpiredEvents } from '@cf-webmail/database';
import { createSmtp2goMailer } from './smtp2go-mailer.js';

export const MAINTENANCE_TASKS = [
  'inbound_handoff',
  'dead_letter',
  'outbound',
  'staging',
  'storage_audit',
  'retention',
  'event_retention',
] as const;

type MaintenanceTask = typeof MAINTENANCE_TASKS[number];

export default {
  async queue(batch: MessageBatch<unknown>, env: JobsEnv): Promise<void> {
    if (
      batch.queue === INBOUND_DEAD_LETTER_QUEUE_NAME
      || batch.queue === OUTBOUND_DEAD_LETTER_QUEUE_NAME
    ) {
      await handleDeadLetterBatch(batch.queue, batch.messages, env.DB, Date.now());
      return;
    }
    if (batch.queue === INBOUND_QUEUE_NAME) {
      await handleInboundBatch(batch.messages, {
        db: env.DB,
        rawEmails: env.RAW_EMAILS,
        now: Date.now,
      });
      return;
    }
    if (batch.queue === OUTBOUND_QUEUE_NAME) {
      await handleOutboundBatch(batch.messages, {
        db: env.DB,
        rawEmails: env.RAW_EMAILS,
        mailer: createSmtp2goMailer(env.SMTP2GO_API_KEY),
        now: Date.now,
      });
      return;
    }
    batch.retryAll({ delaySeconds: 0 });
  },

  async scheduled(controller: ScheduledController, env: JobsEnv): Promise<void> {
    const now = Date.now();
    // Workers Free permits 50 external-service requests per invocation. Run a
    // single bounded maintenance task each minute instead of aggregating them.
    const task = selectMaintenanceTask(controller.scheduledTime);
    try {
      const result = await runMaintenanceTask(task, env, now);
      console.log(JSON.stringify({ event: `${task}.recovery_completed`, result }));
    } catch (error) {
      console.error(JSON.stringify({
        event: `${task}.recovery_failed`,
        errorType: error instanceof Error ? error.name : typeof error,
      }));
      throw error;
    }
  },
} satisfies ExportedHandler<JobsEnv>;

export function selectMaintenanceTask(scheduledTime: number): MaintenanceTask {
  const minute = Math.floor(scheduledTime / 60_000);
  return MAINTENANCE_TASKS[minute % MAINTENANCE_TASKS.length]!;
}

function runMaintenanceTask(
  task: MaintenanceTask,
  env: JobsEnv,
  now: number,
): Promise<unknown> {
  switch (task) {
    case 'inbound_handoff':
      return recoverInboundHandoffs(env.DB, env.INBOUND_QUEUE, now);
    case 'dead_letter':
      return recoverRequestedDeadLetters(env.DB, env.INBOUND_QUEUE, env.OUTBOUND_QUEUE, now);
    case 'outbound':
      return recoverOutboundDeliveries(env.DB, env.OUTBOUND_QUEUE, now);
    case 'staging':
      return reconcileInboundStaging(env.DB, env.RAW_EMAILS, env.INBOUND_QUEUE, now);
    case 'storage_audit':
      return auditCanonicalStorage(env.DB, env.RAW_EMAILS, now);
    case 'retention':
      return processApprovedRetentionRuns(env.DB, env.RAW_EMAILS);
    case 'event_retention':
      return pruneExpiredEvents(env.DB, now);
  }
}
