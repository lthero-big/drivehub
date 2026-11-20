import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Every build stamps a unique id. dist/version.json lets the server tell open
// pages that a newer bundle is on disk (GET /api/version -> web_build).
const version = process.env.DRIVEHUB_WEB_VERSION ?? process.env.npm_package_version ?? "0.1.0";
const build = version + "+" + Date.now().toString(36);

const versionJson = (): Plugin => ({
  name: "drivehub-version-json",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version, build }) + "\n" });
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), versionJson()],
  define: { __WEB_VERSION__: JSON.stringify(version), __WEB_BUILD__: JSON.stringify(build) },
  server: { proxy: { "/api": "http://127.0.0.1:8470" } },
});
