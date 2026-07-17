import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { legacyMappingSha256, legacyMappingTopologySha256 } from './legacy-inventory.mjs';
import { readLegacyImportMetadata } from './legacy-sqlite.mjs';
import { deterministicUuid, sha256 } from './migration-message.mjs';
import { verifyMigrationStage } from './migration-stage.mjs';
import { stageSha256 } from './legacy-bulk-stage.mjs';
import { openLegacyStageSource } from './legacy-stage-source.mjs';
import { collectLegacyMessageDelta } from './legacy-delta-messages.mjs';
import { collectLegacyConfigurationDelta } from './legacy-delta-configuration.mjs';
import { renderLegacyConfigurationDelta } from './legacy-delta-configuration-sql.mjs';
import {
  renderLegacyDeltaFlagSql,
  renderLegacyDeltaHeaderSql,
  renderLegacyDeltaMessageSql,
} from './legacy-delta-sql.mjs';
import { writeLegacyStageSqlChunk } from './legacy-stage.mjs';

const SQL_CHUNK_SIZE = 50;

export async function prepareLegacyDeltaStage(options) {
  const stage = resolve(options.stage);
  await assertMissing(stage);
  const baselineStage = await verifyMigrationStage(options.baselineStage);
  requireBaseline(baselineStage, options.mapping);
  const baselineDatabase = new DatabaseSync(resolve(options.baselineDatabase), { readOnly: true });
  const imported = readLegacyImportMetadata(baselineDatabase);
  if (imported.sourceSha256 !== baselineStage.manifest.sourceDatabaseSha256) {
    baselineDatabase.close();
    throw new Error('baseline stage belongs to a different baseline database');
  }
  const source = openLegacyStageSource(options);
  try {
    await createStageRoot(stage);
    const createdAt = options.now ?? Date.now();
    const collected = await collectLegacyMessageDelta({
      baselineDatabase, source, mapping: options.mapping, stage,
    });
    const configuration = collectLegacyConfigurationDelta({
      baselineDatabase,
      finalDatabase: source.database,
      mapping: options.mapping,
      createdAt,
    });
    if (collected.baselineMessages !== baselineStage.manifest.counts.discovered) {
      throw new Error('baseline database message count differs from the baseline stage');
    }
    const mappingSha256 = legacyMappingSha256(options.mapping);
    const deltaId = deterministicUuid([
      'cloudflare-webmail-archived-delta', baselineStage.manifest.batchId,
      source.imported.sourceSha256, mappingSha256, source.snapshotSha256,
    ].join('\u0000'));
    const messageBatchId = collected.messages.length === 0 ? null : deterministicUuid(
      `cloudflare-webmail-archived-delta-messages\u0000${deltaId}`,
    );
    const changes = [
      ...collected.messages.map((item) => item.change),
      ...collected.flagChanges,
      ...configuration.changes,
    ].sort(compareChange);
    const changesContent = changes.map((change) => JSON.stringify(change)).join('\n')
      + (changes.length > 0 ? '\n' : '');
    const changeSetSha256 = sha256(Buffer.from(changesContent));
    const delta = {
      id: deltaId,
      baselineBatchId: baselineStage.manifest.batchId,
      messageBatchId,
      sourceDatabaseSha256: source.imported.sourceSha256,
      mappingSha256,
      snapshotSha256: source.snapshotSha256,
      changeSetSha256,
      newMessages: collected.messages.length,
      flagUpdates: collected.flagChanges.length,
      configurationMutations: configuration.changes.length,
      objects: collected.objects.length,
      changes: changes.length,
      createdAt,
    };
    const messageBatch = messageBatchId === null ? null : {
      id: messageBatchId,
      sourceDatabaseSha256: source.imported.sourceSha256,
      mappingSha256,
      snapshotSha256: source.snapshotSha256,
      expectedMessages: collected.messages.length,
      sourceObjects: collected.sourceObjects,
      stagedObjects: collected.objects.length,
      createdAt,
    };
    const statements = [
      ...collected.messages.map((item) => renderLegacyDeltaMessageSql(
        item.message, item.legacy, delta, item.change,
      )),
      ...collected.flagChanges.map((change) => renderLegacyDeltaFlagSql(change, delta)),
      ...renderLegacyConfigurationDelta(configuration.operations, delta),
    ];
    const sqlFiles = [await writeLegacyStageSqlChunk(
      stage, 0, [renderLegacyDeltaHeaderSql(delta, messageBatch)],
    )];
    for (let index = 0; index < statements.length; index += SQL_CHUNK_SIZE) {
      sqlFiles.push(await writeLegacyStageSqlChunk(
        stage, sqlFiles.length, statements.slice(index, index + SQL_CHUNK_SIZE),
      ));
    }
    await writeStageEvidence(stage, collected.objects, changesContent);
    const manifest = deltaManifest({
      delta, collected, baselineStage, mappings: options.mapping.mappings,
      exclusions: options.mapping.exclusions, sqlFiles, changesContent,
      configuration: configuration.counts,
    });
    await writeFile(
      join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 },
    );
    return manifest;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  } finally {
    source.close();
    baselineDatabase.close();
  }
}

function requireBaseline(verified, mapping) {
  const manifest = verified.manifest;
  if (manifest.version !== 3 || manifest.complete !== true) {
    throw new Error('legacy delta requires a complete version 3 baseline stage');
  }
  const baselineMapping = {
    version: 1,
    kind: 'cf-webmail-legacy-mapping',
    mappings: manifest.mappings.map((item) => ({
      sourceAddress: item.sourceAddress, mailboxId: item.mailboxId, address: item.address,
    })),
    exclusions: manifest.exclusions,
  };
  if (legacyMappingTopologySha256(baselineMapping) !== legacyMappingTopologySha256(mapping)) {
    throw new Error('final account mapping differs from the baseline stage');
  }
}

async function createStageRoot(stage) {
  await mkdir(join(stage, 'objects'), { recursive: true, mode: 0o700 });
  await mkdir(join(stage, 'd1'), { recursive: true, mode: 0o700 });
  await Promise.all([
    chmod(stage, 0o700), chmod(join(stage, 'objects'), 0o700), chmod(join(stage, 'd1'), 0o700),
  ]);
}

async function writeStageEvidence(stage, objects, changesContent) {
  await Promise.all([
    writeFile(
      join(stage, 'objects.jsonl'),
      objects.map((object) => JSON.stringify(object)).join('\n') + (objects.length ? '\n' : ''),
      { mode: 0o600 },
    ),
    writeFile(join(stage, 'failures.jsonl'), '', { mode: 0o600 }),
    writeFile(join(stage, 'changes.jsonl'), changesContent, { mode: 0o600 }),
  ]);
}

function deltaManifest(input) {
  const { delta, collected, baselineStage } = input;
  return {
    version: 4,
    kind: 'cf-webmail-migration-stage',
    sourceFormat: 'cloudflare-webmail-archived-d1-r2-delta',
    createdAt: delta.createdAt,
    batchId: delta.id,
    deltaId: delta.id,
    baselineBatchId: delta.baselineBatchId,
    baselineStageSha256: stageSha256(baselineStage.manifest, baselineStage.objects),
    messageBatchId: delta.messageBatchId,
    sourceDatabaseSha256: delta.sourceDatabaseSha256,
    mappingSha256: delta.mappingSha256,
    snapshotSha256: delta.snapshotSha256,
    changeSetSha256: delta.changeSetSha256,
    complete: true,
    mappings: input.mappings,
    exclusions: input.exclusions,
    configuration: { mutations: delta.configurationMutations, counts: input.configuration },
    counts: {
      baselineMessages: collected.baselineMessages,
      finalMessages: collected.finalMessages,
      newMessages: delta.newMessages,
      flagUpdates: delta.flagUpdates,
      configurationMutations: delta.configurationMutations,
      changes: delta.changes,
      failed: 0,
      quarantined: collected.quarantined,
      sourceObjects: collected.sourceObjects,
      objects: delta.objects,
    },
    changesFile: {
      file: 'changes.jsonl', count: delta.changes,
      size: Buffer.byteLength(input.changesContent), sha256: delta.changeSetSha256,
    },
    sqlFiles: input.sqlFiles,
  };
}

function compareChange(left, right) {
  return `${left.kind}\u0000${left.sourceKey}\u0000${left.targetKey}\u0000${left.action}`
    .localeCompare(`${right.kind}\u0000${right.sourceKey}\u0000${right.targetKey}\u0000${right.action}`);
}

async function assertMissing(path) {
  try {
    await access(path);
    throw new Error(`stage already exists: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
