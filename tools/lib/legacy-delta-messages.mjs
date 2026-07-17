import { prepareMigratedMessage, deterministicUuid } from './migration-message.mjs';
import {
  addLegacyStageObject,
} from './legacy-stage.mjs';
import {
  loadLegacyRaw,
  normalizeLegacyMessage,
  legacyMessageByIdStatement,
  requireMatchingAttachments,
} from './legacy-stage-source.mjs';
import {
  changedLegacyImmutableFields,
  legacyDeltaExpectedSha256,
  legacyFlags,
  legacyFlagsChanged,
  readLegacyAttachmentFingerprints,
} from './legacy-delta-compare.mjs';

export async function collectLegacyMessageDelta(options) {
  const mappings = new Map(options.mapping.mappings.map((item) => [item.sourceAddress, item]));
  const baselineById = legacyMessageByIdStatement(options.baselineDatabase);
  const baselineAttachments = readLegacyAttachmentFingerprints(options.baselineDatabase);
  const finalAttachments = readLegacyAttachmentFingerprints(options.source.database);
  const baselineRows = options.baselineDatabase.prepare(`
    SELECT id, LOWER(account_email) AS account_email, raw_sha256 FROM messages ORDER BY id
  `).all().filter((row) => mappings.has(String(row.account_email)));
  const targetDedupe = new Set();
  for (const row of baselineRows) {
    const mapping = mappings.get(String(row.account_email));
    const key = `${mapping.mailboxId}\u0000${String(row.raw_sha256).toLowerCase()}`;
    if (targetDedupe.has(key)) throw new Error('baseline stage contains a duplicate target message');
    targetDedupe.add(key);
  }
  const finalIds = new Set();
  const objects = [];
  const messages = [];
  const flagChanges = [];
  const sourceObjects = new Set();
  let finalMessages = 0;
  let quarantined = 0;
  for (const row of options.source.messageStatement.iterate()) {
    const mapping = mappings.get(String(row.account_email));
    if (mapping === undefined) continue;
    const sourceId = String(row.id);
    finalIds.add(sourceId);
    finalMessages += 1;
    const candidate = baselineById.get(sourceId);
    const baseline = candidate !== undefined
      && mappings.has(String(candidate.account_email)) ? candidate : undefined;
    if (baseline !== undefined) {
      requireUnchangedMessage(
        baseline, row, baselineAttachments.get(sourceId), finalAttachments.get(sourceId),
      );
      if (legacyFlagsChanged(baseline, row)) {
        const flags = legacyFlags(row);
        const targetKey = deterministicUuid(`${mapping.mailboxId}\u0000${String(row.raw_sha256).toLowerCase()}`);
        flagChanges.push({
          kind: 'message_flags',
          action: 'update',
          sourceKey: sourceId,
          targetKey,
          mailboxId: mapping.mailboxId,
          rawSha256: String(row.raw_sha256).toLowerCase(),
          flags,
          expectedSha256: legacyDeltaExpectedSha256({ targetKey, flags }),
        });
      }
      continue;
    }
    const legacy = normalizeLegacyMessage(row, mapping);
    const dedupeKey = `${legacy.targetMailboxId}\u0000${legacy.rawSha256}`;
    if (targetDedupe.has(dedupeKey)) {
      throw new Error(`new legacy message duplicates an imported target: ${sourceId}`);
    }
    targetDedupe.add(dedupeKey);
    const raw = await loadLegacyRaw(options.source, legacy);
    const message = await prepareMigratedMessage(raw, {
      mailboxId: legacy.targetMailboxId,
      address: legacy.targetAddress,
      direction: legacy.direction === 'in' ? 'inbound' : 'outbound',
      modifiedAt: legacy.receivedAt,
      createdAt: legacy.createdAt,
      flags: legacy.flags,
      metadata: legacy.metadata,
    });
    if (message.rawSha256 !== legacy.rawSha256 || message.rawSize !== legacy.rawSize) {
      throw new Error(`new legacy message MIME differs from final D1: ${sourceId}`);
    }
    requireMatchingAttachments(options.source, sourceId, message.attachments);
    await addMessageObjects(options.stage, objects, message);
    sourceObjects.add(legacy.rawKey);
    if (message.status === 'quarantined') quarantined += 1;
    messages.push({
      legacy,
      message,
      change: {
        kind: 'message',
        action: 'insert',
        sourceKey: sourceId,
        targetKey: message.id,
        mailboxId: message.mailboxId,
        expectedSha256: legacyDeltaExpectedSha256({
          targetKey: message.id,
          rawSha256: message.rawSha256,
          rawSize: message.rawSize,
        }),
      },
    });
  }
  const removed = baselineRows.filter((row) => !finalIds.has(String(row.id)));
  if (removed.length > 0) {
    throw new Error(`final legacy database removed ${removed.length} baseline message(s)`);
  }
  return {
    baselineMessages: baselineRows.length,
    finalMessages,
    messages,
    flagChanges,
    sourceObjects: sourceObjects.size,
    objects,
    quarantined,
  };
}

function requireUnchangedMessage(baseline, final, baselineAttachments, finalAttachments) {
  const fields = changedLegacyImmutableFields(baseline, final);
  if ((baselineAttachments ?? '[]') !== (finalAttachments ?? '[]')) fields.push('attachments');
  if (fields.length > 0) {
    throw new Error(
      `legacy message ${String(final.id)} changed immutable field(s): ${fields.slice(0, 8).join(', ')}`,
    );
  }
}

async function addMessageObjects(stage, objects, message) {
  await addLegacyStageObject(stage, objects, message.rawKey, message.raw, 'message/rfc822');
  if (message.bodyTextKey !== null) {
    await addLegacyStageObject(
      stage, objects, message.bodyTextKey, message.bodyText, 'text/plain; charset=utf-8',
    );
  }
  if (message.bodyHtmlKey !== null) {
    await addLegacyStageObject(
      stage, objects, message.bodyHtmlKey, message.bodyHtml, 'text/html; charset=utf-8',
    );
  }
  for (const attachment of message.attachments) {
    await addLegacyStageObject(
      stage, objects, attachment.key, attachment.content, attachment.contentType,
    );
  }
}
