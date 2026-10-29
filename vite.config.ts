import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server sends CORS so a local wallet can fetch /<app>/manifest.json.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, cors: true },
  preview: { port: 5174, cors: true },
});
