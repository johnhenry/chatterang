#!/usr/bin/env node
// A FAKE CLI used only by tests/desktop-cli-turns.test.ts. Never one of the
// real CLIs. It replays the fixture named in argv[2] (relative to this file)
// to stdout, then reports its own cwd and the env var names it actually
// received to stderr as one JSON line — which is what the env-allowlist and
// cwd-confinement tests read, rather than parsing stdout content meant for
// the real translators.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureName = process.argv[2] ?? 'claude-pong.jsonl';
const text = readFileSync(join(here, fixtureName), 'utf8');

process.stderr.write(
  `${JSON.stringify({ cwd: process.cwd(), envKeys: Object.keys(process.env).sort() })}\n`,
);
process.stdout.write(text);
process.exit(0);
