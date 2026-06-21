import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Tauri expects a fixed port, fail if that port is not available
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [svelte()],
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // Don't reload when Rust files change (Tauri handles that)
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    // Better tree-shaking for Svelte
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false,
  },
}));
