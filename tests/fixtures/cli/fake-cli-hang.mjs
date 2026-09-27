#!/usr/bin/env node
// A FAKE CLI used only by tests/desktop-cli-turns.test.ts, to exercise
// `cancel()` killing a whole PROCESS GROUP rather than one process. It forks
// a grandchild (`sleep 30`) that inherits this process's process group (it is
// spawned WITHOUT its own `detached: true`), writes both pids to stderr as
// one JSON line, then idles. If `cancel()` only killed this immediate
// process, the grandchild `sleep` would survive it.
import { spawn } from 'node:child_process';

const grandchild = spawn('sleep', ['30'], { stdio: 'ignore' });
process.stderr.write(`${JSON.stringify({ pid: process.pid, grandchildPid: grandchild.pid })}\n`);

// Idle until killed. Not `setInterval` with no unref: this process must stay
// alive on its own, the same way a real CLI waiting on a slow model would.
setInterval(() => {}, 1000);
