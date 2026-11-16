import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works from any static host (GitHub Pages, Netlify, a sub-folder).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: { charts: ['lightweight-charts'], react: ['react', 'react-dom'] },
      },
    },
  },
});
