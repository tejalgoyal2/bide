import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  server: {
    // Live data comes from the deployed Worker during local development.
    proxy: { '/api': { target: 'https://bide.itejalgoyal.workers.dev', changeOrigin: true } },
  },
  build: { target: 'es2022', outDir: '../dist', emptyOutDir: true },
});
