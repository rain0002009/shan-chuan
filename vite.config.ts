import UnoCSS from "unocss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react(), UnoCSS()],
  build: {
    outDir: "../dist",
    emptyOutDir: true
  }
});
