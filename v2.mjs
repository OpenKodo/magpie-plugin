// v2 host entry point (OpenCode 2.x / magpie).
//
// Those hosts load the package's `exports["."]` and require its default to be
// { id, setup(ctx) }. The 1.x plugin in ./index.mjs is a function returning
// { config, provider, auth }, which 1.x understands but 2.x does not. This file
// adapts one to the other: it runs the 1.x plugin against the host context,
// publishes the provider (id, name, npm package, base URL, models, and the
// sign-in method) and routes requests through the credential the user stored.
//
// Only what 2.x can actually act on is forwarded. Chat hooks that need a
// session, plus magpie's usage card, are 1.x-only and stay there.

import * as v1 from "./index.mjs"

const ID = "openkodo"
const BASE = "https://api.openkodo.dev/v1"

const readKey = (auth) => String(auth?.key ?? auth?.access ?? "").trim()

const methodsOf = (plugin) => plugin?.auth?.methods ?? []
const loaderOf = (plugin) => plugin?.auth?.loader
const modelsOf = async (plugin, provider) => {
  try {
    const models = await plugin?.provider?.models?.(provider)
    if (models && Object.keys(models).length) return models
  } catch {}
  return provider?.models ?? {}
}

export async function setup(ctx) {
  const plugin = await (v1.OpenKodoAuthPlugin ?? v1.default)()
  const provider = plugin?.provider ?? {}
  const authCfg = plugin?.auth ?? {}

  // 2.x builds the SDK from this provider record.
  const record = {
    id: ID,
    name: "OpenKodo",
    icon: "https://openkodo.dev/favicon.svg",
    npm: "@ai-sdk/openai-compatible",
    api: BASE,
    models: await modelsOf(plugin, provider),
    auth: { type: "api" },
  }

  // Let the 1.x plugin widen the config the way it does for OpenCode 1.x.
  try {
    const cfg = { provider: { [ID]: record } }
    await plugin?.config?.(cfg)
    await ctx?.provider?.set?.(cfg.provider[ID] ?? record)
  } catch (e) {
    console.error(`${ID}: provider setup failed: ${e?.message ?? e}`)
  }

  // Publish the sign-in method: paste an API key, validated against the API.
  const method = methodsOf(plugin)[0]
  if (method && ctx?.auth?.method) {
    try {
      await ctx.auth.method({
        id: `${ID}-key`,
        provider: ID,
        label: method.label ?? "OpenKodo API key",
        type: "api",
        async authorize(inputs) {
          const key = String(inputs?.apiKey ?? inputs?.key ?? "").trim()
          if (!key.startsWith("ok_live_")) return { type: "failed", error: "Enter an OpenKodo API key" }
          const result = await method.authorize({ ...inputs, apiKey: key })
          if (result?.type !== "success") return result
          return { type: "success", key, metadata: { ...(result.metadata ?? {}), provider: ID } }
        },
      })
    } catch (e) {
      console.error(`${ID}: auth method failed: ${e?.message ?? e}`)
    }
  }

  // Per-request credentials: the stored key, on our base URL.
  const loader = loaderOf(plugin)
  if (ctx?.fetch && loader) {
    try {
      const result = await loader(async () => ctx.auth?.get?.())
      if (result?.baseURL) record.api = result.baseURL
    } catch {}
  }
  if (ctx?.auth) {
    ctx.auth.provider?.(ID, {
      async loader() {
        const auth = await ctx.auth.get?.()
        const key = readKey(auth)
        if (!key && loader) return loader(async () => auth)
        return key ? { baseURL: BASE, apiKey: key } : {}
      },
    })
  }
}

export default { id: ID, setup }
