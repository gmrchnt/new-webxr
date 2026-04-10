import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  assetsInclude: ['**/*.onnx'],
});
