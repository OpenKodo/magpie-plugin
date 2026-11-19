// OpenKodo as an OpenCode / magpie provider.
//
// An account is an OpenKodo API key (`ok_live_...`). The plugin validates it
// against /api/plugin/usage, declares the live model catalog, and exposes the
// credit balance and 5-hour request window to magpie's account card.

const ID = "openkodo"
const BASE = "https://api.openkodo.dev/v1"
const ICON = "https://openkodo.dev/favicon.svg"
const PUBLIC_MODELS = "https://api.openkodo.dev/api/public/models"
const USAGE = "https://api.openkodo.dev/api/plugin/usage"

// The gateway's windows are rolling, not calendar-based, so the reset time is
// when the oldest spend in the window falls out — not a fixed midnight.
const FIVE_HOURS = 5 * 60 * 60_000
const SEVEN_DAYS = 7 * 24 * 60 * 60_000

// Offline fallback only. The live /api/public/models response is authoritative;
// these are the official standard (off-peak) USD list rates.
const FALLBACK = {
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", context: 1_000_000, output: 65_536, input: 0.15, outputPrice: 0.6, cache: 0.003 },
  "deepseek-v4.1-pro": { name: "DeepSeek V4 Pro 0813", context: 1_000_000, output: 131_072, input: 0.66, outputPrice: 1.98, cache: 0.022 },
  "glm-5.3": { name: "GLM-5.3", context: 1_000_000, output: 131_072, input: 1.4, outputPrice: 4.4, cache: 0.26 },
  "glm-5.3-flash": { name: "GLM-5.3 Flash", context: 1_000_000, output: 131_072, input: 0.15, outputPrice: 0.5, cache: 0.03 },
  "kimi-k3.1-pro": { name: "Kimi K3.1 Pro", context: 1_000_000, output: 131_072, input: 2.0, outputPrice: 10.0, cache: 0.2 },
  "qwen3.8-max": { name: "Qwen3.8 Max", context: 1_000_000, output: 131_072, input: 2.0, outputPrice: 6.0, cache: 0.25 },
  "MiniMax-M3": { name: "MiniMax M3", context: 1_000_000, output: 131_072, input: 0.6, outputPrice: 2.4, cache: 0.12 },
}

const fallbackModels = () =>
  Object.fromEntries(
    Object.entries(FALLBACK).map(([id, m]) => [
      id,
      {
        name: m.name,
        context: m.context,
        output: m.output,
        cost: { input: m.input, output: m.outputPrice, cache: { read: m.cache } },
      },
    ]),
  )

const keyOf = (auth) => String(auth?.key ?? auth?.access ?? "").trim()

async function fetchUsage(key) {
  const res = await fetch(USAGE, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(body?.error?.message || `OpenKodo usage failed (${res.status})`)
    error.status = res.status
    throw error
  }
  return body
}

async function fetchModels() {
  const res = await fetch(PUBLIC_MODELS, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`OpenKodo model list failed (${res.status})`)
  const body = await res.json()
  const out = {}
  for (const m of body.models || []) {
    if (!m?.code) continue
    out[m.code] = {
      name: m.name || m.code,
      context: m.context_window || 1_000_000,
      output: m.max_output || 131_072,
      cost: {
        // Show the standard (off-peak) rate the gateway charges most of the
        // day, not the peak rate stored in the primary columns.
        input: Number(m.offpeak_input_price_micros_per_mtok || m.input_price_micros_per_mtok || 0) / 1_000_000,
        output: Number(m.offpeak_output_price_micros_per_mtok || m.output_price_micros_per_mtok || 0) / 1_000_000,
        cache: { read: Number(m.offpeak_cached_input_price_micros_per_mtok || m.cached_input_price_micros_per_mtok || 0) / 1_000_000 },
      },
    }
  }
  return Object.keys(out).length ? out : fallbackModels()
}

export const OpenKodoAuthPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    const p = (cfg.provider[ID] ??= {})
    p.name ??= "OpenKodo"
    p.icon ??= ICON
    p.npm ??= "@ai-sdk/openai-compatible"
    p.api ??= BASE
    p.models = { ...fallbackModels(), ...(p.models ?? {}) }
  },

  provider: {
    id: ID,
    async models(provider) {
      try {
        return await fetchModels()
      } catch {
        return provider?.models && Object.keys(provider.models).length ? provider.models : fallbackModels()
      }
    },
  },

  auth: {
    provider: ID,
    // magpie reads the provider mark from auth.icon, not from config.provider.
    // Declaring it here is what turns the generic provider box into our logo.
    icon: ICON,

    methods: [
      {
        type: "api",
        label: "OpenKodo API key",
        keyless: true,
        prompts: [
          {
            type: "password",
            key: "apiKey",
            message: "OpenKodo API key (Console → API keys)",
            placeholder: "ok_live_...",
            validate: (v) => (String(v ?? "").trim().startsWith("ok_live_") ? undefined : "Enter an OpenKodo API key"),
          },
        ],
        async authorize(inputs) {
          const key = String(inputs?.apiKey ?? "").trim()
          if (!key.startsWith("ok_live_")) return { type: "failed", error: "Enter an OpenKodo API key" }
          try {
            const usage = await fetchUsage(key)
            if (!usage?.plan) throw new Error("OpenKodo usage response was not valid")
            return {
              type: "success",
              key,
              metadata: { plan: usage.plan, email: usage.email },
            }
          } catch (e) {
            return { type: "failed", error: e?.message || "OpenKodo rejected this key" }
          }
        },
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth()
      const key = keyOf(auth)
      if (!key) return {}
      return { baseURL: BASE, apiKey: key }
    },

    async usage(getAuth) {
      const auth = await getAuth()
      const key = keyOf(auth)
      if (!key) return { error: "not signed in", signIn: "expired" }
      try {
        const d = await fetchUsage(key)
        // Cents, not raw division: $26.599999999999994 must render as $26.60.
        const usd = (micros) => Math.round(Number(micros || 0) / 10_000) / 100
        const remaining = usd(d.credits_remaining_micros)
        const included = usd(d.credits_included_micros)
        const spent = Math.max(0, included - remaining)
        const used5h = usd(d.cost_5h_micros)
        const cap5h = usd(d.credits_per_5h_micros)
        const used7d = usd(d.cost_7d_micros)
        const cap7d = usd(d.credits_per_week_micros)
        const periodEnd = d.period_end ? new Date(d.period_end).toISOString() : undefined
        // Each window is rolling: the cap frees up when the oldest spend in it
        // ages out. A window with no spend has nothing to expire.
        const rollingReset = (oldest, span) =>
          oldest ? new Date(new Date(oldest).getTime() + span).toISOString() : undefined
        return {
          plan: d.plan,
          user: d.email,
          windows: [
            ...(cap5h > 0
              ? [{
                  name: "5 hours",
                  used: used5h,
                  limit: cap5h,
                  span: FIVE_HOURS,
                  display: `$${used5h.toFixed(2)} / $${cap5h.toFixed(2)}`,
                  ...(rollingReset(d.oldest_5h, FIVE_HOURS) ? { resetsAt: rollingReset(d.oldest_5h, FIVE_HOURS) } : {}),
                }]
              : []),
            ...(cap7d > 0
              ? [{
                  name: "7 days",
                  used: used7d,
                  limit: cap7d,
                  span: SEVEN_DAYS,
                  display: `$${used7d.toFixed(2)} / $${cap7d.toFixed(2)}`,
                  ...(rollingReset(d.oldest_7d, SEVEN_DAYS) ? { resetsAt: rollingReset(d.oldest_7d, SEVEN_DAYS) } : {}),
                }]
              : []),
            {
              name: "Month",
              used: spent,
              limit: included,
              // Welcome-credit accounts have no plan pool, so "left of $0.00"
              // would be nonsense. Show what they actually have.
              display: included > 0
                ? `$${remaining.toFixed(2)} left of $${included.toFixed(2)}`
                : `$${remaining.toFixed(2)} remaining`,
              ...(periodEnd ? { resetsAt: periodEnd } : {}),
            },
            {
              name: d.model_window?.model ? `Requests / 5h · ${d.model_window.model}` : "Requests / 5h",
              used: Number(d.model_window?.used ?? d.requests_5h ?? 0),
              limit: Number(d.model_window?.limit ?? d.requests_limit_5h ?? 0),
              display: `${Number(d.model_window?.used ?? d.requests_5h ?? 0).toLocaleString()} / ${Number(d.model_window?.limit ?? d.requests_limit_5h ?? 0).toLocaleString()}`,
              span: FIVE_HOURS,
            },
          ],
        }
      } catch (e) {
        return { error: e?.message || "OpenKodo usage unavailable", signIn: e?.status === 401 ? "expired" : "kept" }
      }
    },
  },
})

export default OpenKodoAuthPlugin
