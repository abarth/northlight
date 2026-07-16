import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves the app from a subpath (e.g. /northlight/); the
  // deploy workflow sets BASE_PATH accordingly. Local dev/preview use '/'.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
});
