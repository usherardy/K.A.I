// Cloudflare Workers entry point (`npm run deploy`). Bindings from wrangler.toml and
// `wrangler secret put` arrive as the env argument of fetch().
import { createApp } from "./app";

export default createApp();
