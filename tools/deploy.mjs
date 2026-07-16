#!/usr/bin/env node
import { runDeployCli } from './lib/deploy-cli.mjs';

try {
  process.exitCode = await runDeployCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`deploy: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
