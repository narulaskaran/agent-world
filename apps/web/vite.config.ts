import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The lazily loaded map chunk is mostly the three.js WebGL renderer.
  build: { chunkSizeWarningLimit: 600 },
});
