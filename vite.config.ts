import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, open: false },
  build: { target: 'es2022', sourcemap: true },
  // rules.json / visuals.json are fetched at runtime from the project root so they
  // can be edited without a rebuild. Keep them out of the bundle.
  publicDir: 'data',
});
