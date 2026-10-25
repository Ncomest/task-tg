import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('../..', import.meta.url));
  const env = loadEnv(mode, envDir, '');
  return {
    plugins: [vue()],
    envDir,
    server: { port: 5173, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${env.API_PORT || '3000'}` } } },
  };
});
