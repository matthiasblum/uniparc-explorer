import { defineConfig } from "vite";

export default defineConfig({
  // Relative URLs, so the site works from any path
  base: "./",
  build: { target: "es2022" },
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
});
