import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export async function assertLegacySafeBackup(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!buffer.subarray(0, bytesRead).toString('utf8').includes('CF Webmail Starter safe logical backup')) {
      throw new Error('source is not an archived safe logical backup');
    }
  } finally {
    await handle.close();
  }
}

export async function inspectLegacySafeSql(path) {
  const tables = new Map();
  for await (const statement of readLegacySqlStatements(path)) {
    const operation = classifyLegacyStatement(statement);
    if (operation.kind === 'control') continue;
    if (!tables.has(operation.table)) tables.set(operation.table, new Set());
    if (operation.kind === 'insert') {
      for (const column of operation.columns) tables.get(operation.table).add(column);
    }
  }
  return tables;
}

export function classifyLegacyStatement(statement) {
  const normalized = statement.trim();
  if (/^(?:PRAGMA\s+foreign_keys\s*=|BEGIN(?:\s+TRANSACTION)?\b|COMMIT\b)/iu.test(normalized)) {
    return { kind: 'control' };
  }
  const deletion = normalized.match(/^DELETE\s+FROM\s+"((?:[^"]|"")+)"\s*;$/iu);
  if (deletion) return { kind: 'delete', table: identifier(deletion[1]) };
  const insertion = normalized.match(
    /^INSERT\s+INTO\s+"((?:[^"]|"")+)"\s*\(([\s\S]*?)\)\s+VALUES\s*\([\s\S]*\)\s*;$/iu,
  );
  if (insertion) {
    return {
      kind: 'insert',
      table: identifier(insertion[1]),
      columns: quotedIdentifiers(insertion[2]),
    };
  }
  throw new Error('legacy SQL contains a statement outside the safe-backup format');
}

export async function* readLegacySqlStatements(path) {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  let statement = '';
  let single = false;
  let double = false;
  let pendingSingle = false;
  let pendingDouble = false;
  let pendingDash = false;
  let comment = false;
  for await (const chunk of stream) {
    const completed = [];
    const process = (character) => {
      if (comment) {
        if (character === '\n') {
          comment = false;
          statement += ' ';
        }
        return;
      }
      if (pendingSingle) {
        pendingSingle = false;
        if (character === "'") {
          statement += character;
          return;
        }
        single = false;
      }
      if (pendingDouble) {
        pendingDouble = false;
        if (character === '"') {
          statement += character;
          return;
        }
        double = false;
      }
      if (single) {
        statement += character;
        if (character === "'") pendingSingle = true;
        return;
      }
      if (double) {
        statement += character;
        if (character === '"') pendingDouble = true;
        return;
      }
      if (pendingDash) {
        pendingDash = false;
        if (character === '-') {
          comment = true;
          return;
        }
        statement += '-';
      }
      if (character === '-') {
        pendingDash = true;
      } else if (character === "'") {
        single = true;
        statement += character;
      } else if (character === '"') {
        double = true;
        statement += character;
      } else if (character === ';') {
        statement += character;
        if (statement.trim() !== '') completed.push(statement);
        statement = '';
      } else {
        statement += character;
      }
    };
    for (const character of chunk) process(character);
    for (const item of completed) yield item;
  }
  if (pendingDash) statement += '-';
  if (pendingSingle) single = false;
  if (pendingDouble) double = false;
  if (single || double || statement.trim() !== '') {
    throw new Error('legacy SQL ended with an incomplete statement');
  }
}

function quotedIdentifiers(value) {
  const columns = [];
  let offset = 0;
  const expression = /\s*"((?:[^"]|"")+)"\s*(?:,|$)/gyu;
  while (offset < value.length) {
    expression.lastIndex = offset;
    const match = expression.exec(value);
    if (!match || match.index !== offset) throw new Error('legacy SQL column list is invalid');
    columns.push(identifier(match[1]));
    offset = expression.lastIndex;
  }
  if (columns.length === 0 || new Set(columns).size !== columns.length) {
    throw new Error('legacy SQL column list is empty or duplicated');
  }
  return columns;
}

function identifier(value) {
  const decoded = value.replaceAll('""', '"');
  if (!IDENTIFIER.test(decoded)) throw new Error('legacy SQL identifier is invalid');
  return decoded;
}
