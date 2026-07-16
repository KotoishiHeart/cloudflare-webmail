import { spawnSync } from 'node:child_process';

const REFERENCES_SQL = `
  SELECT raw_key AS object_key, 'message/rfc822' AS content_type FROM messages
  UNION SELECT body_text_key, 'text/plain; charset=utf-8' FROM messages WHERE body_text_key IS NOT NULL
  UNION SELECT body_html_key, 'text/html; charset=utf-8' FROM messages WHERE body_html_key IS NOT NULL
  UNION SELECT storage_key, content_type FROM attachments
  ORDER BY object_key
`;
const EMPTY_D1_SQL = `
  SELECT COUNT(*) AS table_count
  FROM sqlite_master
  WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
    AND name NOT LIKE '_cf_%'
`;

export function exportD1(file, options, runner) {
  run(runner, [
    'd1', 'export', options.database, targetFlag(options),
    '--output', file, '--skip-confirmation', '--config', options.config,
  ]);
}

export function downloadR2Object(file, key, options, runner) {
  run(runner, [
    'r2', 'object', 'get', `${options.bucket}/${key}`,
    '--file', file, targetFlag(options), ...persistenceArgs(options),
    '--config', options.config,
  ]);
}

export function uploadR2Object(file, object, options, runner) {
  run(runner, [
    'r2', 'object', 'put', `${options.bucket}/${object.key}`,
    '--file', file, '--content-type', object.contentType,
    targetFlag(options), ...persistenceArgs(options), '--config', options.config,
  ]);
}

export function restoreD1(file, options, runner) {
  run(runner, [
    'd1', 'execute', options.database, targetFlag(options),
    '--file', file, '--yes', ...persistenceArgs(options), '--config', options.config,
  ]);
}

export function queryReferences(options, runner) {
  const rows = queryD1(REFERENCES_SQL, options, runner);
  return rows
    .map((row) => ({ key: row?.object_key, contentType: row?.content_type }))
    .sort((left, right) => String(left.key).localeCompare(String(right.key)));
}

export function queryTargetTableCount(options, runner) {
  const rows = queryD1(EMPTY_D1_SQL, options, runner);
  const value = Number(rows[0]?.table_count);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('could not verify target D1 emptiness');
  }
  return value;
}

export function defaultRunner() {
  return { spawn: spawnSync };
}

export function queryD1(sql, options, runner) {
  const output = capture(runner, [
    'd1', 'execute', options.database, targetFlag(options), '--command', sql,
    '--json', ...persistenceArgs(options), '--config', options.config,
  ]);
  const payload = parseJsonOutput(output);
  return Array.isArray(payload)
    ? payload.flatMap((item) => item?.results ?? [])
    : payload?.results ?? [];
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    const starts = [output.indexOf('['), output.indexOf('{')].filter((index) => index >= 0);
    const start = Math.min(...starts);
    if (!Number.isFinite(start)) throw new Error('Wrangler did not return JSON');
    return JSON.parse(output.slice(start));
  }
}

function run(runner, args) {
  const result = runner.spawn('npx', ['--no-install', 'wrangler', ...args], spawnOptions('inherit'));
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler failed with exit ${result.status}`);
}

function capture(runner, args) {
  const result = runner.spawn('npx', ['--no-install', 'wrangler', ...args], spawnOptions('pipe'));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wrangler failed with exit ${result.status}: ${result.stderr ?? ''}`);
  }
  return String(result.stdout ?? '');
}

function spawnOptions(stdio) {
  return {
    cwd: process.cwd(),
    encoding: stdio === 'pipe' ? 'utf8' : undefined,
    stdio,
    shell: false,
    env: { ...process.env, WRANGLER_LOG_PATH: '/tmp/cf-webmail-wrangler.log' },
  };
}

function targetFlag(options) {
  return options.local ? '--local' : '--remote';
}

function persistenceArgs(options) {
  return options.persistTo ? ['--persist-to', options.persistTo] : [];
}
