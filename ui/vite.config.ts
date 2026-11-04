import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cross-origin isolation lets the on-device AI models use threads
// (SharedArrayBuffer); the Tauri app sends the same headers.
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

// Shared by the browser build and the Tauri shells (desktop + mobile).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || false, headers: isolation },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
});
