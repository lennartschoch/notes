import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const webHost = process.env.WEB_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: webHost,
    port: webPort,
    strictPort: true,
    // The Paseo service proxy forwards requests with a non-localhost Host
    // header, which Vite would otherwise reject.
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:4000",
      // The MCP endpoint for AI agents; SSE streaming needs to stay open.
      "/mcp": {
        target: "http://localhost:4000",
        proxyTimeout: 0,
        timeout: 0,
      },
    },
  },
});
