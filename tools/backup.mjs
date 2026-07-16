#!/usr/bin/env node
import { runBackupCli } from './lib/backup-cli.mjs';

try {
  process.exitCode = await runBackupCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`backup: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
