import { defineConfig } from 'vite';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
        child = spawn('python3', ['-u', 'scripts/train_ppo.py', '--live', '--days', String(days),
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
            run.message = code === 0 ? 'Training complete' : (error.trim() || `Trainer exited with code ${code}`);
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

export default defineConfig({
  plugins: [trainingApi()],
  server: { port: 5173, open: false },
  build: { target: 'es2022', sourcemap: true },
  // rules.json / visuals.json are fetched at runtime from the project root so they
  // can be edited without a rebuild. Keep them out of the bundle.
  publicDir: 'data',
});
