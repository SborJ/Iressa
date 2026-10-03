import { defineConfig } from 'vite';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Which Python runs the trainer.
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


type Point = { steps: number; total: number; episode: number; episode_reward: number | null; burden: number; eci: number; resistant_fraction: number; action: number };
type Training = { state: 'idle' | 'running' | 'completed' | 'stopped' | 'failed'; points: Point[]; message: string; checkpoint?: string; evaluation?: unknown; config?: { days: number; timesteps: number } };

function trainingApi() {
  let child: ChildProcessWithoutNullStreams | undefined;
  let run: Training = { state: 'idle', points: [], message: '' };
  const statusPath = resolve('outputs/rl/ui_status.json');
  try {
    const saved = JSON.parse(readFileSync(statusPath, 'utf8')) as Training;
    if (saved.state === 'completed') run = saved;
  } catch { /* No completed run has been saved yet. */ }
  let pending = '';
  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/rl/')) return next();
    if (req.method === 'GET' && req.url === '/api/rl/status') return send(res, 200, run);
    if (req.method === 'POST' && req.url === '/api/rl/stop') {
      if (child && run.state === 'running') {
        run.state = 'stopped';
        run.message = 'Training stopped';
        child.kill('SIGTERM');
      }
      return send(res, 200, run);
    }
    if (req.method !== 'POST' || req.url !== '/api/rl/start') return send(res, 404, { error: 'Not found' });
    if (child) return send(res, 409, { error: 'Wait for the current trainer to exit' });
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const input = JSON.parse(body) as Record<string, unknown>;
        const number = (key: string, min: number, max: number) => {
          const value = input[key];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
            throw new Error(`${key} must be between ${min} and ${max}`);
          }
          return value;
        };
        const days = number('days', 2, 240);
        const total = number('timesteps', 32, 20000);
        if (!Number.isInteger(total)) throw new Error('timesteps must be an integer');
        run = { state: 'running', points: [], message: 'Starting Python trainer', config: { days, timesteps: total } };
        rmSync(statusPath, { force: true });
        pending = '';
        child = spawn(pythonExecutable(), ['-u', 'scripts/train_ppo.py', '--live', '--days', String(days),
          '--total-timesteps', String(total), '--rollout-steps', String(Math.min(64, total)), '--progress-interval', '8',
          '--width', '14', '--height', '10', '--depth', '8', '--cells', '100', '--output-dir', 'outputs/rl'],
        { cwd: process.cwd(), env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } });
        const processForRun = child;
        processForRun.stdout.on('data', (chunk: Buffer) => {
          if (child !== processForRun) return;
          pending += chunk.toString();
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('RL_PROGRESS ')) continue;
            try {
              const event = JSON.parse(line.slice(12));
              if (event.type === 'progress') {
                run.points.push(event as Point);
                if (run.points.length > 500) run.points.shift();
                run.message = `Training: ${event.steps} / ${event.total} steps`;
              } else if (event.type === 'stage') {
                run.message = 'Testing PPO against fixed schedules on held-out seeds';
              } else if (event.type === 'evaluation') {
                run.evaluation = event.result;
                run.message = 'Preparing PPO experiment view';
              } else if (event.type === 'complete') {
                run.checkpoint = event.checkpoint;
              }
            } catch { /* Ignore malformed progress lines; the process exit reports failure. */ }
          }
        });
        let error = '';
        processForRun.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-2000); });
        processForRun.on('error', (cause) => {
          if (child !== processForRun) return;
          run.state = 'failed'; run.message = cause.message; child = undefined;
        });
        processForRun.on('close', (code) => {
          if (child !== processForRun) return;
          if (run.state === 'running') {
            run.state = code === 0 ? 'completed' : 'failed';
            run.message = code === 0
              ? 'Training complete'
              : (explainTrainerFailure(error) || `Trainer exited with code ${code}`);
            if (run.state === 'completed') {
              mkdirSync(resolve('outputs/rl'), { recursive: true });
              writeFileSync(statusPath, JSON.stringify(run));
            }
          }
          child = undefined;
        });
        return send(res, 202, run);
      } catch (cause) {
        return send(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
      }
    });
  };
  return {
    name: 'local-ppo-training',
    configureServer(server: { middlewares: { use: typeof handler }; httpServer?: { on: (event: string, fn: () => void) => void } }) {
      server.middlewares.use(handler);
      server.httpServer?.on('close', () => child?.kill('SIGTERM'));
    },
  };
}

/**
 * The live two-way simulator (scripts/serve_live.py), started on demand.
 *
 * POST /api/live/start {policy?: string} spawns the Python WebSocket server once
 * (on port 8788) and answers with its address; GET /api/live/status reports it.
 * The same Python as the trainer, for the same reason.
 */
function liveApi() {
  let child: ChildProcessWithoutNullStreams | undefined;
  let state: { state: 'idle' | 'starting' | 'running' | 'failed'; url: string; message: string; policy?: string } =
    { state: 'idle', url: 'ws://localhost:8788', message: '' };
  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/live/')) return next();
    if (req.method === 'GET' && req.url === '/api/live/status') return send(res, 200, state);
    if (req.method !== 'POST' || req.url !== '/api/live/start') return send(res, 404, { error: 'Not found' });
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let policy: string | undefined;
      try {
        const input = body ? JSON.parse(body) as { policy?: unknown } : {};
        if (typeof input.policy === 'string' && /^[\w./-]+\.zip$/.test(input.policy) && !input.policy.includes('..')) policy = input.policy;
      } catch { /* no options */ }
      if (child && (state.state === 'running' || state.state === 'starting')) {
        if (policy && policy !== state.policy) return send(res, 409, { ...state, error: `The live server is already running${state.policy ? ` with ${state.policy}` : ''}` });
        return send(res, 200, state);
      }
      const args = ['-u', 'scripts/serve_live.py', '--port', '8788'];
      if (policy && existsSync(resolve(process.cwd(), policy))) args.push('--policy', policy);
      state = { state: 'starting', url: 'ws://localhost:8788', message: 'Starting the live simulator', policy };
      const proc = spawn(pythonExecutable(), args, { cwd: process.cwd(), env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } });
      child = proc;
      let error = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        if (child === proc && chunk.toString().includes('live simulator on')) state = { ...state, state: 'running', message: 'Live simulator running' };
      });
      proc.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-2000); });
      proc.on('error', (cause) => { if (child === proc) { state = { ...state, state: 'failed', message: cause.message }; child = undefined; } });
      proc.on('close', (code) => {
        if (child !== proc) return;
        state = { ...state, state: code === 0 ? 'idle' : 'failed', message: code === 0 ? '' : (explainTrainerFailure(error) || `Live server exited with code ${code}`) };
        child = undefined;
      });
      return send(res, 202, state);
    });
  };
  return {
    name: 'local-live-simulator',
    configureServer(server: { middlewares: { use: typeof handler }; httpServer?: { on: (event: string, fn: () => void) => void } }) {
      server.middlewares.use(handler);
      server.httpServer?.on('close', () => child?.kill('SIGTERM'));
    },
  };
}

export default defineConfig({
  plugins: [trainingApi(), liveApi()],
  server: { port: 5173, open: false },
  build: { target: 'es2022', sourcemap: true },
  // rules.json / visuals.json are fetched at runtime from the project root so they
  // can be edited without a rebuild. Keep them out of the bundle.
  publicDir: 'data',
});
