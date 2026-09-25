import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('src/ui/app.tsx', import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist/ui',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry, formats: ['es'], fileName: () => 'app.js' },
    rollupOptions: {
      external: ["react","react/jsx-runtime","react/jsx-dev-runtime","react-dom","react-dom/client","@tanstack/react-query","react-router","react-router-dom","@sota/platform","@sota/platform/ui","@sota/platform/icons","@sota/core/components","@sota/core/hooks","@sota/core/state"],
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.name?.endsWith('.css') ? 'app.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
