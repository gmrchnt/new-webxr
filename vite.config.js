import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  assetsInclude: ['**/*.onnx'],
});
