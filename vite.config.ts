import { defineConfig } from 'vite';
export default defineConfig({ root: 'src/public', build: { outDir: '../../dist/public', emptyOutDir: true }, server: { host: '0.0.0.0' } });
