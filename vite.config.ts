import { defineConfig } from 'vite';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Which Python runs the REINFORCE trainer.
 *
 * Spawning a bare `python3` picks up whatever interpreter is first on PATH,
 * which is usually a system one with none of this project's dependencies: the
 * trainer then dies on `import numpy` before it reaches any of its own code.
 * A virtual environment in the project is preferred when there is one, and
 * IRESSA_PYTHON overrides both.
 */
function pythonExecutable(): string {
  const override = process.env.IRESSA_PYTHON;
  if (override) return override;
  for (const candidate of ['.venv/bin/python', '.venv/Scripts/python.exe', 'venv/bin/python']) {
    const full = resolve(process.cwd(), candidate);
    if (existsSync(full)) return full;
  }
  return 'python3';
}

/** Turn a missing-dependency traceback into something actionable. */
function explainTrainerFailure(stderr: string): string {
  const missing = /ModuleNotFoundError: No module named '([^']+)'/.exec(stderr);
  if (missing) {
    return (
      `The Python trainer is missing ${missing[1]}. Install the dependencies, then try again:\n` +
      '  python3 -m venv .venv && .venv/bin/pip install -r requirements-rl.txt\n' +
      '(or set IRESSA_PYTHON to an interpreter that already has them).'
    );
  }
  return stderr.trim();
}


/**
 * The AI add-on: a REINFORCE agent learning a treatment pattern in under a minute
 * (scripts/train_reinforce.py), streamed to the viewer.
 *
 * POST /api/ai/start {cancer, seconds} starts a session, GET /api/ai/status reports
 * it, POST /api/ai/stop ends it. The status keeps the learning curve, the
 * agent's preferences after each update and the practice runs it recorded for
 * the 3D world, newest last.
 */
type AiStatus = {
  state: 'idle' | 'running' | 'completed' | 'stopped' | 'failed';
  message: string;
  cancer?: string;
  seconds?: number;
  startedAt?: number;
  start?: unknown;
  updates: unknown[];
  showcases: unknown[];
  evaluation?: unknown;
};
const AI_CANCERS = ['lung_egfr', 'breast_er_her2neg'];

function aiApi() {
  let child: ChildProcessWithoutNullStreams | undefined;
  let status: AiStatus = { state: 'idle', message: '', updates: [], showcases: [] };
  let pending = '';
  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/ai/')) return next();
    if (req.method === 'GET' && req.url === '/api/ai/status') return send(res, 200, status);
    if (req.method === 'POST' && req.url === '/api/ai/stop') {
      if (child && status.state === 'running') {
        status.state = 'stopped';
        status.message = 'Training stopped';
        child.kill('SIGTERM');
      }
      return send(res, 200, status);
    }
    if (req.method !== 'POST' || req.url !== '/api/ai/start') return send(res, 404, { error: 'Not found' });
    if (child) return send(res, 409, { error: 'The agent is still training' });
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let input: Record<string, unknown> = {};
      try { input = body ? JSON.parse(body) as Record<string, unknown> : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      const cancer = typeof input.cancer === 'string' && AI_CANCERS.includes(input.cancer) ? input.cancer : 'lung_egfr';
      const seconds = typeof input.seconds === 'number' && Number.isFinite(input.seconds) ? Math.min(120, Math.max(5, input.seconds)) : 45;
      status = { state: 'running', message: 'Waking the agent', cancer, seconds, startedAt: Date.now(), updates: [], showcases: [] };
      pending = '';
      const proc = spawn(pythonExecutable(),
        ['-u', 'scripts/train_reinforce.py', '--live', '--cancer', cancer, '--seconds', String(seconds), '--output-dir', 'outputs/rl'],
        { cwd: process.cwd(), env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } });
      child = proc;
      proc.stdout.on('data', (chunk: Buffer) => {
        if (child !== proc) return;
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('RL_PROGRESS ')) continue;
          try {
            const event = JSON.parse(line.slice(12)) as { type: string; [key: string]: unknown };
            if (event.type === 'start') {
              status.start = event;
              status.message = 'Practising';
            } else if (event.type === 'update') {
              status.updates.push(event);
              if (status.updates.length > 400) status.updates.shift();
              status.message = `Practising · ${event.episodes} runs · update ${event.update}`;
            } else if (event.type === 'showcase') {
              status.showcases.push(event);
              if (status.showcases.length > 50) status.showcases.shift();
            } else if (event.type === 'stage') {
              status.message = 'Testing the learned pattern on tumours it never saw';
            } else if (event.type === 'evaluation') {
              status.evaluation = event.result;
            }
          } catch { /* a malformed line; the exit code reports real failures */ }
        }
      });
      let error = '';
      proc.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-2000); });
      proc.on('error', (cause) => {
        if (child !== proc) return;
        status.state = 'failed'; status.message = cause.message; child = undefined;
      });
      proc.on('close', (code) => {
        if (child !== proc) return;
        if (status.state === 'running') {
          status.state = code === 0 ? 'completed' : 'failed';
          status.message = code === 0 ? 'Learned' : (explainTrainerFailure(error) || `Trainer exited with code ${code}`);
        }
        child = undefined;
      });
      return send(res, 202, status);
    });
  };
  return {
    name: 'reinforce-ai',
    configureServer(server: { middlewares: { use: typeof handler }; httpServer?: { on: (event: string, fn: () => void) => void } }) {
      server.middlewares.use(handler);
      server.httpServer?.on('close', () => child?.kill('SIGTERM'));
    },
  };
}

/**
 * Two pages: the landing page at / and the simulator at /simulation/.
 *
 * Addresses a static host would resolve are made to resolve the same way here:
 * /simulation gains its trailing slash (keeping the query - recorded-run and
 * sign-in links carry one), and the landing page's old address, /landing/,
 * sends people to /. Without that, an old bookmark showed the landing page at
 * /landing/, its relative links resolved under /landing/ too, and every one of
 * them answered with the same page - so "Open the simulator" did nothing.
 */
function pageRoutes() {
  const redirect = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const to =
      url.pathname === '/simulation' ? `/simulation/${url.search}`
      : url.pathname === '/landing' || url.pathname === '/landing/' || url.pathname === '/landing/index.html' ? `/${url.search}${url.hash}`
      : undefined;
    if (!to) return next();
    res.writeHead(301, { Location: to });
    res.end();
  };
  return {
    name: 'page-routes',
    configureServer(server: { middlewares: { use: typeof redirect } }) { server.middlewares.use(redirect); },
    configurePreviewServer(server: { middlewares: { use: typeof redirect } }) { server.middlewares.use(redirect); },
  };
}

export default defineConfig({
  plugins: [aiApi()],
  server: { port: 5173, open: false, allowedHosts: ['iressa.quicx.dev'] },
  preview: { allowedHosts: ['iressa.quicx.dev'] },
  build: { target: 'es2022', sourcemap: true },
  plugins: [pageRoutes(), aiApi()],
  // A multi-page site, not a single-page app: an address that matches no page
  // is a 404, rather than the landing page served under the wrong URL.
  appType: 'mpa',
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: { input: { main: resolve('index.html'), simulation: resolve('simulation/index.html') } },
  },
  // rules.json / visuals.json are fetched at runtime from the project root so they
  // can be edited without a rebuild. Keep them out of the bundle.
  publicDir: 'data',
});
