import type { Bindings } from "./config";

/** Loads .env from the current directory into process.env (Node only), if present. */
export function loadDotEnv(): Bindings {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return process.env as Bindings;
}
