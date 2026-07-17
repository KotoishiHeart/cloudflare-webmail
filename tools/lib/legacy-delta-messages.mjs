import { prepareMigratedMessage, deterministicUuid } from './migration-message.mjs';
import {
  addLegacyStageObject,
} from './legacy-stage.mjs';
import {
  loadLegacyRaw,
  normalizeLegacyMessage,
  legacyMessagesByIdStatement,
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
  const objects = [];
  const messages = [];
  const flagChanges = [];
  const sourceObjects = new Set();
  let finalMessages = 0;
  let quarantined = 0;
  let removed = 0;
  const baselineIterator = legacyMessagesByIdStatement(options.baselineDatabase)
    .iterate()[Symbol.iterator]();
  const finalIterator = options.source.messageByIdStatement.iterate()[Symbol.iterator]();
  let baseline = nextMapped(baselineIterator, mappings);
  let row = nextMapped(finalIterator, mappings);
  while (baseline !== undefined || row !== undefined) {
    const baselineId = baseline === undefined ? null : String(baseline.id);
    const sourceId = row === undefined ? null : String(row.id);
    if (row === undefined || (baseline !== undefined && baselineId < sourceId)) {
      removed += 1;
      baseline = nextMapped(baselineIterator, mappings);
      continue;
    }
    if (baseline !== undefined && baselineId === sourceId) {
      finalMessages += 1;
      const mapping = mappings.get(String(row.account_email));
      requireUnchangedMessage(
        baseline, row, baselineAttachments.get(sourceId), finalAttachments.get(sourceId),
      );
      if (legacyFlagsChanged(baseline, row)) {
        const flags = legacyFlags(row);
        const targetKey = deterministicUuid(
          `${mapping.mailboxId}\u0000${String(row.raw_sha256).toLowerCase()}`,
        );
        flagChanges.push({
          kind: 'message_flags', action: 'update', sourceKey: sourceId, targetKey,
          mailboxId: mapping.mailboxId, rawSha256: String(row.raw_sha256).toLowerCase(), flags,
          expectedSha256: legacyDeltaExpectedSha256({ targetKey, flags }),
        });
      }
      baseline = nextMapped(baselineIterator, mappings);
      row = nextMapped(finalIterator, mappings);
      continue;
    }
    const mapping = mappings.get(String(row.account_email));
    finalMessages += 1;
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
    row = nextMapped(finalIterator, mappings);
  }
  if (removed > 0) {
    throw new Error(`final legacy database removed ${removed} baseline message(s)`);
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

function nextMapped(iterator, mappings) {
  for (let item = iterator.next(); !item.done; item = iterator.next()) {
    if (mappings.has(String(item.value.account_email))) return item.value;
  }
  return undefined;
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
