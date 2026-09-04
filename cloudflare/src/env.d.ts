// Secrets and optional overrides that are set with `wrangler secret put` rather than in
// wrangler.jsonc, so `wrangler types` cannot discover them.
interface Env {
  /** Anthropic API key for the hosted assistant. Hosted mode is unavailable when unset. */
  ANTHROPIC_API_KEY?: string;
  /** Optional Anthropic base URL override (e.g. a Cloudflare AI Gateway endpoint). */
  ANTHROPIC_BASE_URL?: string;
  /** Set to "false" to disable server-side refusal fallbacks on hosted-agent model calls. */
  HOSTED_AGENT_FALLBACKS?: string;
  XAI_API_KEY?: string;
  CODEX_VOICE_BROKER_URL?: string;
  CODEX_VOICE_BROKER_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
}
