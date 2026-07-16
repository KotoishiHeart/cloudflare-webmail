#!/usr/bin/env node
import { runLegacyMigrationCli } from './lib/legacy-cli.mjs';

try {
  process.exitCode = await runLegacyMigrationCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`migrate-legacy: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
