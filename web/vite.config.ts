import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.WORDLOOM_API ?? 'http://127.0.0.1:8787';
const webPort = Number(process.env.WORDLOOM_WEB_PORT ?? '4173');

function wordloomTsSpecifiers() {
  return {
    name: 'wordloom-ts-specifiers',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      if (!importer || importer.includes('node_modules') || !source.startsWith('.') || !source.endsWith('.js')) {
        return null;
      }
      const file = importer.split('?')[0] ?? importer;
      const target = path.resolve(path.dirname(file), source.replace(/\.js$/, '.ts'));
      return existsSync(target) ? target : null;
    },
  };
}

const proxy = {
  '/api': { target: apiTarget, changeOrigin: false },
};

export default defineConfig({
  plugins: [wordloomTsSpecifiers(), react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy,
    fs: { allow: [path.resolve('..')] },
  },
  preview: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy,
  },
});
