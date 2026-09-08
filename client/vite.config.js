import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5000',
      '/socket.io': { target: 'http://localhost:5000', ws: true },
      '/login': 'http://localhost:5000',
      '/logout': 'http://localhost:5000',
      '/img': 'http://localhost:5000',
      '/styles.css': 'http://localhost:5000'
    }
  }
});
