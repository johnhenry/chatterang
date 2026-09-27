#!/usr/bin/env node
// A FAKE CLI used only by tests/desktop-cli-turns.test.ts and
// tests/desktop-cli-plugin.test.ts. Never one of the real CLIs. It replays a
// fixture (relative to this file) to stdout, then reports its own cwd and the
// env var names it actually received to stderr as one JSON line — which is
// what the env-allowlist and cwd-confinement tests read, rather than parsing
// stdout content meant for the real translators.
//
// The fixture name comes from argv[2] WHEN IT LOOKS LIKE ONE (ends in
// ".jsonl") -- tests/desktop-cli-turns.test.ts calls this script directly
// with a fixture name as its one argument. tests/desktop-cli-plugin.test.ts
// instead spawns it through the REAL spawnCliBinaryTurn, whose argv is
// claude's/codex's/gemini's own real flags (e.g. "-p"), not a fixture name --
// this script must not mistake that for one and try to open a file called
// "-p". Either way, this stays a fake: it never reads a real CLI's actual
// argv semantics, it only avoids crashing on one.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const candidate = process.argv[2];
const fixtureName = candidate && candidate.endsWith('.jsonl') ? candidate : 'claude-pong.jsonl';
const text = readFileSync(join(here, fixtureName), 'utf8');

process.stderr.write(
  `${JSON.stringify({ cwd: process.cwd(), envKeys: Object.keys(process.env).sort() })}\n`,
);
process.stdout.write(text);
process.exit(0);
