export function legacyStageCliSummary(manifest) {
  return {
    version: manifest.version,
    kind: manifest.kind,
    sourceFormat: manifest.sourceFormat,
    ...(typeof manifest.complete === 'boolean' ? { complete: manifest.complete } : {}),
    ...(typeof manifest.batchId === 'string' ? { batchId: manifest.batchId } : {}),
    counts: manifest.counts,
    ...(manifest.configuration === undefined ? {} : { configuration: manifest.configuration }),
    mappedAccounts: Array.isArray(manifest.mappings) ? manifest.mappings.length : undefined,
    excludedAccounts: Array.isArray(manifest.exclusions) ? manifest.exclusions.length : undefined,
    sqlFiles: Array.isArray(manifest.sqlFiles) ? manifest.sqlFiles.length : 0,
  };
}

export function legacyMigrationUsage() {
  return `Cloudflare Webmail archived migration\n\n` +
    `  import-sql --sql OLD_SAFE_BACKUP.sql --database legacy.sqlite\n` +
    `  inventory --database legacy.sqlite --output inventory.json \\\n` +
    `    [--mapping-template mapping.json]\n` +
    `  validate-mapping --database legacy.sqlite --mapping mapping.json\n` +
    `  refresh-mapping --baseline-database baseline.sqlite --database final.sqlite \\\n` +
    `    --mapping baseline-mapping.json --output final-mapping.json\n` +
    `  provision-template --database legacy.sqlite --mapping mapping.json \\\n` +
    `    --owner-user-id UUID --owner-email EMAIL --access-issuer URL \\\n` +
    `    --access-subject SUBJECT [--system-admin] --output provision.json \\\n` +
    `    --report provisioning-review.json\n` +
    `  verify-provisioning --database legacy.sqlite --mapping mapping.json \\\n` +
    `    --manifest provision.json --review provisioning-review.json \\\n` +
    `    --deployment deployment.json --output verification.json\n` +
    `  fetch --database legacy.sqlite --mapping mapping.json --snapshot DIR \\\n` +
    `    (--object-root DIR | --bucket NAME (--local|--remote) --config FILE) \\\n` +
    `    [--seed-snapshot BASELINE_DIR --seed-database baseline.sqlite \\\n` +
    `     --seed-mapping baseline-mapping.json]\n` +
    `  bulk-fetch --database legacy.sqlite --mapping mapping.json --snapshot DIR \\\n` +
    `    --rclone-source REMOTE:BUCKET [--rclone-config FILE] \\\n` +
    `    [--seed-snapshot BASELINE_DIR --seed-database baseline.sqlite \\\n` +
    `     --seed-mapping baseline-mapping.json]\n` +
    `  verify-snapshot --database legacy.sqlite --mapping mapping.json --snapshot DIR\n` +
    `  prepare --database legacy.sqlite --mapping mapping.json --snapshot DIR --stage DIR\n` +
    `  prepare-delta --baseline-database baseline.sqlite --baseline-stage BASELINE_DIR \\\n` +
    `    --database final.sqlite --mapping final-mapping.json --snapshot FINAL_DIR \\\n` +
    `    --stage DELTA_DIR\n` +
    `  verify-stage --stage DIR\n` +
    `  capacity-rehearsal --stage DIR --database FILE --output FILE \\\n` +
    `    [--provisioning provision.json]\n` +
    `  bulk-apply --stage DIR --rclone-destination REMOTE:BUCKET \\\n` +
    `    (--local|--remote) --yes [--rclone-config FILE] [--tree DIR]\n` +
    `  bulk-audit --stage DIR --tree DIR --rclone-destination REMOTE:BUCKET\n` +
    `    --report FILE --output FILE (--local|--remote) [--rclone-config FILE]\n`;
}
