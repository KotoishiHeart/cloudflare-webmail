#!/usr/bin/env node
import { runOpsCli } from './lib/ops-cli.mjs';

try {
  process.exitCode = await runOpsCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`cf-webmail: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
