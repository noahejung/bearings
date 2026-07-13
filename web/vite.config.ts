import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api straight to the FastAPI backend (see ../src/bearings/api.py)
// so the client can always fetch relative "/api/..." paths -- no CORS dance needed in
// dev, and the same relative-path code works unmodified once both are deployed behind
// one origin. Target is the backend's documented default (README.md: "Running the API"),
// overridable via BEARINGS_API_PROXY so a worker never has to hardcode a port that later
// moves.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.BEARINGS_API_PROXY ?? "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
