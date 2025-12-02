import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [vue(), wasm(), topLevelAwait(), tailwindcss()],
  publicDir: 'public',
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  json: {
    stringify: true,
  },
  optimizeDeps: {
    include: [
      '@reown/appkit',
      '@reown/appkit/networks',
      '@reown/appkit-adapter-wagmi',
      '@wagmi/core',
      'wagmi',
      'viem',
    ],
    exclude: [],
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: ['faucet.basementnodes.ca', 'localhost'],
    proxy: {
      '/send': 'http://localhost:8088',
      '/config.json': 'http://localhost:8088',
      '/balance': 'http://localhost:8088',
      '/transaction': 'http://localhost:8088',
    },
  },
});
