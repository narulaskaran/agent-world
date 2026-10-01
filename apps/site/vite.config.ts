import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "public",
  // The bundle is mostly the three.js WebGL renderer for the hero diorama.
  build: { chunkSizeWarningLimit: 600 },
});
