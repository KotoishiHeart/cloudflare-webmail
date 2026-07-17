import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { legacyMappingSha256 } from './legacy-inventory.mjs';
import { prepareMigratedMessage, deterministicUuid, sha256 } from './migration-message.mjs';
import { renderLegacyBatchSql, renderLegacyMessageSql } from './legacy-stage-sql.mjs';
import {
  legacyMessageLabels,
  readLegacyConfiguration,
} from './legacy-configuration.mjs';
import {
  buildLegacyConfigurationPlan,
  renderLegacyMessageLabelSql,
} from './legacy-configuration-sql.mjs';
import {
  loadLegacyRaw,
  normalizeLegacyMessage,
  openLegacyStageSource,
  requireMatchingAttachments,
} from './legacy-stage-source.mjs';

const SQL_CHUNK_SIZE = 50;

export async function prepareLegacyMigrationStage(options) {
  const stage = resolve(options.stage);
  await assertMissing(stage);
  const objectsRoot = join(stage, 'objects');
  const d1Root = join(stage, 'd1');
  await mkdir(objectsRoot, { recursive: true, mode: 0o700 });
  await mkdir(d1Root, { recursive: true, mode: 0o700 });
  await Promise.all([
    chmod(stage, 0o700),
    chmod(objectsRoot, 0o700),
    chmod(d1Root, 0o700),
  ]);
  const createdAt = options.now ?? Date.now();
  const source = openLegacyStageSource(options);
  const mappingSha256 = legacyMappingSha256(options.mapping);
  const batchId = deterministicUuid([
    'cloudflare-webmail-archived', source.imported.sourceSha256,
    mappingSha256, source.snapshotSha256,
  ].join('\u0000'));
  const objects = [];
  const failures = [];
  const sqlChunks = [];
  const seen = new Set();
  const configuration = readLegacyConfiguration(
    source.database, options.mapping.mappings, createdAt,
  );
  const configurationPlan = buildLegacyConfigurationPlan(
    configuration, options.mapping.mappings, batchId, createdAt,
  );
  for (let index = 0; index < configurationPlan.statements.length; index += SQL_CHUNK_SIZE) {
    sqlChunks.push(await writeLegacyStageSqlChunk(
      stage,
      sqlChunks.length + 1,
      configurationPlan.statements.slice(index, index + SQL_CHUNK_SIZE),
    ));
  }
  const accountCounts = new Map(options.mapping.mappings.map((mapping) => [mapping.sourceAddress, {
    sourceAddress: mapping.sourceAddress,
    mailboxId: mapping.mailboxId,
    address: mapping.address,
    discovered: 0,
    prepared: 0,
    failed: 0,
    inbound: 0,
    outbound: 0,
    read: 0,
    starred: 0,
    archived: 0,
    deleted: 0,
    attachments: 0,
  }]));
  let currentSql = [];
  let discovered = 0;
  let prepared = 0;
  let duplicates = 0;
  let quarantined = 0;
  try {
    for (const row of source.messageStatement.iterate()) {
      const mapping = source.mappings.get(String(row.account_email));
      if (mapping === undefined) continue;
      discovered += 1;
      accountCounts.get(mapping.sourceAddress).discovered += 1;
      try {
        const legacy = normalizeLegacyMessage(row, mapping);
        const raw = await loadLegacyRaw(source, legacy);
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
          throw new Error('prepared raw MIME differs from legacy D1');
        }
        requireMatchingAttachments(source, legacy.id, message.attachments);
        const dedupeKey = `${message.mailboxId}\u0000${message.rawSha256}`;
        if (seen.has(dedupeKey)) {
          duplicates += 1;
          throw new Error('target mailbox contains a duplicate raw MIME record');
        }
        seen.add(dedupeKey);
        await addLegacyStageObject(stage, objects, message.rawKey, message.raw, 'message/rfc822');
        if (message.bodyTextKey !== null) {
          await addLegacyStageObject(stage, objects, message.bodyTextKey, message.bodyText, 'text/plain; charset=utf-8');
        }
        if (message.bodyHtmlKey !== null) {
          await addLegacyStageObject(stage, objects, message.bodyHtmlKey, message.bodyHtml, 'text/html; charset=utf-8');
        }
        for (const attachment of message.attachments) {
          await addLegacyStageObject(stage, objects, attachment.key, attachment.content, attachment.contentType);
        }
        const labelSql = legacyMessageLabels(
          configuration, legacy.id, legacy.targetMailboxId,
        ).map((association) => renderLegacyMessageLabelSql(
          configurationPlan, association, message.id, batchId, createdAt,
        ));
        currentSql.push([
          renderLegacyMessageSql(message, legacy, batchId, createdAt),
          ...labelSql,
        ].join('\n\n'));
        if (message.status === 'quarantined') quarantined += 1;
        prepared += 1;
        const account = accountCounts.get(mapping.sourceAddress);
        account.prepared += 1;
        account[message.direction] += 1;
        account.read += message.flags.isRead ? 1 : 0;
        account.starred += message.flags.isStarred ? 1 : 0;
        account.archived += message.flags.isArchived ? 1 : 0;
        account.deleted += message.flags.isDeleted ? 1 : 0;
        account.attachments += message.attachments.length;
        if (currentSql.length >= SQL_CHUNK_SIZE) {
          sqlChunks.push(await writeLegacyStageSqlChunk(stage, sqlChunks.length + 1, currentSql));
          currentSql = [];
        }
      } catch (error) {
        failures.push({
          sourceRecordId: String(row.id ?? ''),
          sourceAccount: String(row.account_email ?? ''),
          sourceRawKey: String(row.raw_key ?? ''),
          error: error instanceof Error ? error.message : String(error),
        });
        accountCounts.get(mapping.sourceAddress).failed += 1;
      }
    }
    if (currentSql.length > 0) {
      sqlChunks.push(await writeLegacyStageSqlChunk(stage, sqlChunks.length + 1, currentSql));
    }
  } finally {
    source.close();
  }
  if (discovered === 0 || prepared === 0) throw new Error('legacy stage contains no prepared messages');
  const batch = {
    id: batchId,
    sourceDatabaseSha256: source.imported.sourceSha256,
    mappingSha256,
    snapshotSha256: source.snapshotSha256,
    expectedMessages: discovered,
    sourceObjects: source.snapshotSummary.objects,
    stagedObjects: objects.length,
    createdAt,
  };
  const batchSql = await writeLegacyStageSqlChunk(stage, 0, [renderLegacyBatchSql(batch)]);
  const sqlFiles = [batchSql, ...sqlChunks];
  await writeFile(
    join(stage, 'objects.jsonl'),
    objects.map((object) => JSON.stringify(object)).join('\n') + '\n',
    { mode: 0o600 },
  );
  await writeFile(
    join(stage, 'failures.jsonl'),
    failures.map((failure) => JSON.stringify(failure)).join('\n') + (failures.length > 0 ? '\n' : ''),
    { mode: 0o600 },
  );
  const complete = failures.length === 0 && duplicates === 0 && prepared === discovered;
  const manifest = {
    version: 3,
    kind: 'cf-webmail-migration-stage',
    sourceFormat: 'cloudflare-webmail-archived-d1-r2',
    createdAt,
    batchId,
    sourceDatabaseSha256: batch.sourceDatabaseSha256,
    mappingSha256,
    snapshotSha256: batch.snapshotSha256,
    complete,
    mappings: [...accountCounts.values()],
    exclusions: options.mapping.exclusions,
    configuration: {
      source: configuration.sourceCounts,
      target: configurationPlan.counts,
    },
    counts: {
      discovered,
      prepared,
      duplicates,
      failed: failures.length,
      quarantined,
      sourceObjects: batch.sourceObjects,
      objects: objects.length,
    },
    sqlFiles,
  };
  await writeFile(
    join(stage, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

export async function addLegacyStageObject(stage, objects, key, value, contentType) {
  const content = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  const file = `objects/${String(objects.length).padStart(8, '0')}.bin`;
  await mkdir(dirname(join(stage, file)), { recursive: true, mode: 0o700 });
  await writeFile(join(stage, file), content, { mode: 0o600 });
  objects.push({ key, file, contentType, size: content.byteLength, sha256: sha256(content) });
}

export async function writeLegacyStageSqlChunk(stage, index, statements) {
  const file = `d1/${String(index).padStart(6, '0')}.sql`;
  const content = Buffer.from(`${statements.join('\n\n')}\n`);
  await writeFile(join(stage, file), content, { mode: 0o600 });
  return { file, size: content.byteLength, sha256: sha256(content) };
}

async function assertMissing(path) {
  try {
    await access(path);
    throw new Error(`stage already exists: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
