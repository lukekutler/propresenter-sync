// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

export default defineConfig({
  plugins: [
    react(),
    electron({
      // <-- IMPORTANT: point Electron at your main process entry
      entry: 'electron/main.ts',
      vite: {
        build: {
          outDir: 'dist-electron',
          sourcemap: true,
          rollupOptions: {
            // Externalize native deps so Rollup doesn't try to parse .node files
            external: ['keytar', 'better-sqlite3'],
          },
        },
      },
    } as any),
    // Build the preload script as CJS
    electron({
      entry: 'electron/main.ts',
      vite: { build: { outDir: 'dist-electron', sourcemap: true } },
      preload: {
        input: 'electron/preload.cjs',
        vite: {
          build: {
            outDir: 'dist-electron',
            sourcemap: true,
            rollupOptions: {
              output: {
                format: 'cjs',
                entryFileNames: 'preload.cjs',
              },
            },
          },
        },
      },
    } as any),
    renderer(),
  ],
  build: { outDir: 'dist' },
});
