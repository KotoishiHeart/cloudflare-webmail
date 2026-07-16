import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateProvisionManifest } from './ops-manifest.mjs';
import {
  renderProvisionSql,
  renderRetryDeadLetterSql,
  renderRetryOutboundSql,
} from './ops-sql.mjs';

const STATUS_SQL = `
  SELECT 'users' AS metric, COUNT(*) AS value FROM users
  UNION ALL SELECT 'mailboxes', COUNT(*) FROM mailboxes
  UNION ALL SELECT 'messages_inbound', COUNT(*) FROM messages WHERE direction = 'inbound'
  UNION ALL SELECT 'messages_outbound', COUNT(*) FROM messages WHERE direction = 'outbound'
  UNION ALL SELECT 'outbound_queued', COUNT(*) FROM outbound_deliveries WHERE status = 'queued'
  UNION ALL SELECT 'outbound_sending', COUNT(*) FROM outbound_deliveries WHERE status = 'sending'
  UNION ALL SELECT 'outbound_sent', COUNT(*) FROM outbound_deliveries WHERE status = 'sent'
  UNION ALL SELECT 'outbound_failed', COUNT(*) FROM outbound_deliveries WHERE status = 'failed'
  UNION ALL SELECT 'inbound_handoff_staged', COUNT(*) FROM inbound_handoffs WHERE status = 'staged'
  UNION ALL SELECT 'inbound_handoff_queue_failed', COUNT(*) FROM inbound_handoffs WHERE status = 'queue_failed'
  UNION ALL SELECT 'inbound_handoff_dead_letter', COUNT(*) FROM inbound_handoffs WHERE status = 'dead_letter'
  UNION ALL SELECT 'inbound_staging_cleanup_pending', COUNT(*) FROM inbound_handoffs
    WHERE status = 'stored' AND staging_deleted = 0
  UNION ALL SELECT 'dead_letter_pending', COUNT(*) FROM queue_dead_letters WHERE status = 'pending'
  UNION ALL SELECT 'dead_letter_retry_requested', COUNT(*) FROM queue_dead_letters
    WHERE status = 'retry_requested'
  UNION ALL SELECT 'dead_letter_requeued', COUNT(*) FROM queue_dead_letters WHERE status = 'requeued'
  UNION ALL SELECT 'storage_issues_open', COUNT(*) FROM storage_issues WHERE status = 'open'
`;

const STORAGE_ISSUES_SQL = `
  SELECT issue_type, object_key, mailbox_id, message_id, details,
    occurrences, first_seen_at, last_seen_at
  FROM storage_issues
  WHERE status = 'open'
  ORDER BY last_seen_at DESC, issue_type, object_key
  LIMIT 100
`;

export async function runOpsCli(argv, io = defaultIo()) {
  const [command = 'help', ...args] = argv;
  const options = parseOptions(args);
  if (command === 'help' || options.help) {
    io.stdout(usage());
    return 0;
  }
  if (command === 'plan') {
    const manifestPath = required(options, 'manifest');
    const outputPath = required(options, 'output');
    const manifest = validateProvisionManifest(JSON.parse(await readFile(resolve(manifestPath), 'utf8')));
    const output = resolve(outputPath);
    if (!options.force && await exists(output)) throw new Error(`output already exists: ${output}`);
    await writeFile(output, renderProvisionSql(manifest), { encoding: 'utf8', flag: options.force ? 'w' : 'wx' });
    io.stdout(`Provision SQL written: ${output}\n`);
    return 0;
  }
  if (command === 'apply') {
    requireYes(options, command);
    const plan = resolve(required(options, 'plan'));
    await requireTarget(options);
    return runWrangler([
      'd1', 'execute', options.database ?? 'cf-webmail', targetFlag(options),
      '--file', plan, '--config', options.config ?? 'apps/web/wrangler.jsonc',
    ], io);
  }
  if (command === 'migrate') {
    requireYes(options, command);
    await requireTarget(options);
    return runWrangler([
      'd1', 'migrations', 'apply', options.database ?? 'cf-webmail', targetFlag(options),
      '--config', options.config ?? 'apps/web/wrangler.jsonc',
    ], io);
  }
  if (command === 'status') {
    await requireTarget(options);
    return runWrangler([
      'd1', 'execute', options.database ?? 'cf-webmail', targetFlag(options),
      '--command', STATUS_SQL, '--config', options.config ?? 'apps/web/wrangler.jsonc',
    ], io);
  }
  if (command === 'storage-issues') {
    await requireTarget(options);
    return runWrangler([
      'd1', 'execute', options.database ?? 'cf-webmail', targetFlag(options),
      '--command', STORAGE_ISSUES_SQL, '--config', options.config ?? 'apps/web/wrangler.jsonc',
    ], io);
  }
  if (command === 'retry-outbound') {
    requireYes(options, command);
    await requireTarget(options);
    const query = renderRetryOutboundSql(required(options, 'message-id'));
    return runWrangler([
      'd1', 'execute', options.database ?? 'cf-webmail', targetFlag(options),
      '--command', query, '--config', options.config ?? 'apps/web/wrangler.jsonc',
    ], io);
  }
  if (command === 'retry-dead-letter') {
    requireYes(options, command);
    await requireTarget(options);
    const query = renderRetryDeadLetterSql(required(options, 'dead-letter-id'));
    return runWrangler([
      'd1', 'execute', options.database ?? 'cf-webmail', targetFlag(options),
      '--command', query, '--config', options.config ?? 'apps/web/wrangler.jsonc',
    ], io);
  }
  throw new Error(`unknown command: ${command}`);
}

export function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (['yes', 'local', 'remote', 'force', 'help', 'empty-target'].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function runWrangler(args, io) {
  const result = io.spawn('npx', ['--no-install', 'wrangler', ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function targetFlag(options) {
  return options.local ? '--local' : '--remote';
}

async function requireTarget(options) {
  if (Boolean(options.local) === Boolean(options.remote)) {
    throw new Error('specify exactly one of --local or --remote');
  }
}

function requireYes(options, command) {
  if (!options.yes) throw new Error(`${command} changes D1; pass --yes after reviewing the command`);
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value === '') throw new Error(`--${key} is required`);
  return value;
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function defaultIo() {
  return {
    stdout: (value) => process.stdout.write(value),
    spawn: spawnSync,
  };
}

function usage() {
  return `Cloudflare Webmail operations\n\n` +
    `  plan --manifest FILE --output FILE [--force]\n` +
    `  apply --plan FILE (--local|--remote) --yes\n` +
    `  migrate (--local|--remote) --yes\n` +
    `  status (--local|--remote)\n` +
    `  storage-issues (--local|--remote)\n` +
    `  retry-outbound --message-id UUID (--local|--remote) --yes\n\n` +
    `  retry-dead-letter --dead-letter-id SHA256 (--local|--remote) --yes\n\n` +
    `Optional: --database NAME --config FILE\n`;
}
