import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  server: { host: true },
  build: {
    // um único arquivo JS facilita gerar a versão de página única (npm run build:single)
    rollupOptions: { output: { codeSplitting: false } },
  },
});
