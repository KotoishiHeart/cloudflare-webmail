#!/usr/bin/env node
import { runMigrationCli } from './lib/migration-cli.mjs';

try {
  process.exitCode = await runMigrationCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`migrate-mail: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
