import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { federation } from '@module-federation/vite';
import path from 'path';

// Builds the scenario-test harness as a proper Module Federation host.
// The federation plugin wires up the shared scope automatically, so bootstrap.tsx
// can call registerRemotes/loadRemote exactly like rimori-main's FederatedPluginRenderer.
// Assets are served at /__rimori_harness__/* by RimoriTestEnvironment.interceptRoutes.

export default defineConfig({
  root: path.resolve(__dirname, 'src/harness'),
  base: '/__rimori_harness__/',
  plugins: [
    react(),
    federation({
      name: 'rimori-scenario-host',
      dts: false,
      remotes: {},
      shared: {
        react: { singleton: true },
        'react-dom': { singleton: true },
        'react/jsx-runtime': { singleton: true },
        'react/jsx-dev-runtime': { singleton: true },
        '@rimori/client': { singleton: true },
        '@rimori/react-client': { singleton: true },
        '@tanstack/react-query': { singleton: true },
        zod: { singleton: true },
      },
    }),
  ],
  build: {
    outDir: path.resolve(__dirname, 'dist/harness'),
    emptyOutDir: true,
    target: 'esnext',
    minify: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/harness/index.html'),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
