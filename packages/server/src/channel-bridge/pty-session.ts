import pty from 'node-pty';
import { createServer, type Server as NetServer } from 'node:net';
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// One-shot runner executing an interactive Claude Code session (without `-p`).
// Spawns claude via PTY, injects prompt into stdin, and receives result via Unix domain socket
// when the model invokes the report_result MCP tool. Each job runs in an isolated session.
// Concurrency is throttled by caller via semaphores up to maxConcurrent sessions.

export interface PtyJobConfig {
  cliPath: string;
  model: string;
  workingDir?: string;
  timeoutMs: number;
  extraArgs?: string[];
  readyMaxWaitMs?: number;
  readyIdleMs?: number;
}

export interface PtyJobResult {
  content: string;
  status: 'success' | 'error';
}

const SYSTEM_REMINDER =
  'You are operating as a one-shot worker behind an API. When you finish the task you MUST call the report_result MCP tool with your final answer as the `payload`. Do not only print the answer in chat — the report_result tool call is the only way the result is delivered to the caller.';

const require = createRequire(import.meta.url);

// Ensure execution permissions for node-pty spawn-helper if postinstall chmod was skipped (e.g. ignore-scripts).
let helperEnsured = false;
function ensureSpawnHelper(): void {
  if (helperEnsured) return;
  helperEnsured = true;
  try {
    const ptyRoot = dirname(require.resolve('node-pty/package.json'));
    const helper = join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch {
    // best-effort
  }
}

// Resolve reporter entry point command matching active runtime (tsx vs node).
function resolveReporterCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith('.ts');
  const entry = join(dirname(here), isTs ? 'mcp-reporter.ts' : 'mcp-reporter.js');
  return isTs
    ? { command: process.execPath, args: ['--import', 'tsx', entry] }
    : { command: process.execPath, args: [entry] };
}

// Strip CLI/print-only flags incompatible with interactive sessions.
// extra_args are typically configured for print/SDK modes and conflict with PTY interactive mode
// (e.g. --no-session-persistence requires --print, --permission-mode conflicts with --dangerously-skip-permissions).
const PTY_DROP_WITH_VALUE = new Set([
  '--output-format', '--input-format', '--permission-mode', '--model', '--resume', '--agent',
]);
const PTY_DROP_FLAGS = new Set([
  '-p', '--print', '--no-session-persistence', '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions', '--fork-session', '--verbose', '--continue',
]);

function sanitizeInteractiveArgs(args: string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (PTY_DROP_WITH_VALUE.has(a)) { dropped.push(a, args[i + 1] ?? ''); i++; continue; }
    if (PTY_DROP_FLAGS.has(a)) { dropped.push(a); continue; }
    kept.push(a);
  }
  return { kept, dropped };
}

function cleanClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
    'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENABLE_TASKS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  ]) {
    delete env[k];
  }
  return env;
}

export async function runClaudeJob(
  prompt: string,
  config: PtyJobConfig,
  signal?: AbortSignal,
): Promise<PtyJobResult> {
  ensureSpawnHelper();

  const work = mkdtempSync(join(tmpdir(), 'ch-'));
  const socketPath = join(work, 's.sock');
  const mcpConfigPath = join(work, 'mcp.json');
  const reporter = resolveReporterCommand();

  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      reporter: {
        type: 'stdio',
        command: reporter.command,
        args: reporter.args,
        env: { BRIDGE_REPORT_SOCKET: socketPath },
      },
    },
  }));

  let settle: ((r: PtyJobResult) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const resultPromise = new Promise<PtyJobResult>((res, rej) => { settle = res; fail = rej; });

  // Unix domain socket server receiving report_result payloads.
  const sock: NetServer = createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { type?: string; payload?: unknown; status?: string };
          if (msg.type === 'report_result') {
            settle?.({
              content: typeof msg.payload === 'string' ? msg.payload : String(msg.payload ?? ''),
              status: msg.status === 'error' ? 'error' : 'success',
            });
          }
        } catch {
          // ignore malformed line
        }
      }
    });
  });
  await new Promise<void>((res, rej) => {
    sock.once('error', rej);
    sock.listen(socketPath, res);
  });

  const { kept: safeExtraArgs, dropped } = sanitizeInteractiveArgs(config.extraArgs ?? []);
  if (dropped.length > 0) {
    console.error(`[channel-bridge] dropped CLI-only extra_args for interactive session: ${dropped.filter(Boolean).join(' ')}`);
  }

  const term = pty.spawn(config.cliPath, [
    '--mcp-config', mcpConfigPath,
    '--dangerously-skip-permissions',
    '--append-system-prompt', SYSTEM_REMINDER,
    '--model', config.model,
    ...safeExtraArgs,
  ], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: config.workingDir || process.cwd(),
    env: cleanClaudeEnv() as Record<string, string>,
  });

  let injected = false;
  let firstDataAt = 0;
  let lastDataAt = 0;
  const startedAt = Date.now();
  const readyMax = config.readyMaxWaitMs ?? 8000;
  const readyIdle = config.readyIdleMs ?? 1500;

  const debug = process.env.CHANNEL_BRIDGE_DEBUG === '1';
  term.onData((data) => {
    if (debug) process.stderr.write(data);
    const now = Date.now();
    if (!firstDataAt) firstDataAt = now;
    lastDataAt = now;
  });

  // Inject prompt once TUI becomes ready (idle after output or timeout reached).
  const readyTimer = setInterval(() => {
    if (injected) return;
    const now = Date.now();
    const idleReady = firstDataAt > 0 && now - lastDataAt >= readyIdle;
    const maxReady = now - startedAt >= readyMax;
    if (idleReady || maxReady) {
      injected = true;
      // Append delivery instructions to ensure report_result is called even if user prompt specifies "OK only / brief",
      // because chat text is discarded and only tool outputs are delivered.
      const injectedPrompt = `${prompt}\n\n────\n[Delivery — this OVERRIDES any "only/nothing else/brief" instruction above] You MUST call the report_result tool with your COMPLETE answer as the payload. Chat text is discarded; the tool call is the only thing delivered to the user.`;
      term.write(injectedPrompt);
      setTimeout(() => { try { term.write('\r'); } catch { /* killed */ } }, 400);
    }
  }, 300);

  const timeout = setTimeout(
    () => fail?.(new Error(`Channel PTY job timed out after ${config.timeoutMs}ms`)),
    config.timeoutMs,
  );

  const onAbort = () => fail?.(new Error('Request cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });

  term.onExit(({ exitCode }) => {
    // Delay failure slightly on process exit to allow in-flight socket messages to finish processing.
    setTimeout(() => fail?.(new Error(`claude session exited (code ${exitCode}) before report_result`)), 800);
  });

  try {
    return await resultPromise;
  } finally {
    clearInterval(readyTimer);
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    try { term.kill(); } catch { /* already gone */ }
    try { sock.close(); } catch { /* ignore */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
