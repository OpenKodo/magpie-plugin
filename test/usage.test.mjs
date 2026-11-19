import assert from "node:assert/strict"
import test from "node:test"

import { OpenKodoAuthPlugin } from "../index.mjs"

const KEY = "ok_live_test_key_not_real"

// stubFetch replaces global fetch for one test and records what was requested.
function stubFetch(payload, status = 200) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }
  }
  return calls
}

const plugin = async () => (await OpenKodoAuthPlugin())
const authed = async () => ({ key: KEY })

test("cloud auth: three spend windows plus the request guardrail", async () => {
  stubFetch({
    email: "go@example.com",
    plan: "Go",
    credits_remaining_micros: 73_400_000,
    credits_included_micros: 100_000_000,
    credits_per_5h_micros: 25_000_000,
    cost_5h_micros: 4_200_000,
    credits_per_week_micros: 50_000_000,
    cost_7d_micros: 18_900_000,
    oldest_5h: "2026-11-18T15:00:00Z",
    oldest_7d: "2026-11-14T09:30:00Z",
    period_end: "2026-12-18T00:00:00Z",
    requests_5h: 120,
    requests_limit_5h: 60_000,
    model_window: {},
  })

  const p = await plugin()
  const usage = await p.auth.usage(authed)

  assert.equal(usage.plan, "Go")
  assert.deepEqual(
    usage.windows.map((w) => w.name),
    ["5 hours", "7 days", "Month", "Requests / 5h"],
  )

  const [five, seven, month] = usage.windows
  assert.equal(five.display, "$4.20 / $25.00")
  assert.equal(five.limit, 25)
  // Rolling: the oldest 5h spend ages out five hours after it happened.
  assert.equal(five.resetsAt, "2026-11-18T20:00:00.000Z")

  assert.equal(seven.display, "$18.90 / $50.00")
  assert.equal(seven.resetsAt, "2026-11-21T09:30:00.000Z")

  assert.equal(month.display, "$73.40 left of $100.00")
  assert.equal(month.resetsAt, "2026-12-18T00:00:00.000Z")
})

test("money is rounded to cents, never raw floating point", async () => {
  stubFetch({
    email: "go@example.com",
    plan: "Go",
    credits_remaining_micros: 73_400_000,
    credits_included_micros: 100_000_000,
    credits_per_5h_micros: 25_000_000,
    cost_5h_micros: 4_200_001,
    credits_per_week_micros: 0,
    cost_7d_micros: 0,
    requests_5h: 0,
    requests_limit_5h: 0,
    model_window: {},
  })
  const p = await plugin()
  const usage = await p.auth.usage(authed)
  for (const w of usage.windows) {
    assert.ok(!/\.\d{3,}/.test(w.display), `${w.name} leaked precision: ${w.display}`)
  }
})

test("welcome-credit accounts do not claim a zero-dollar pool", async () => {
  stubFetch({
    email: "new@example.com",
    plan: "No plan",
    credits_remaining_micros: 9_950_000,
    credits_included_micros: 0,
    credits_per_5h_micros: 0,
    cost_5h_micros: 0,
    credits_per_week_micros: 0,
    cost_7d_micros: 0,
    requests_5h: 0,
    requests_limit_5h: 60,
    model_window: {},
  })
  const p = await plugin()
  const usage = await p.auth.usage(authed)
  const month = usage.windows.find((w) => w.name === "Month")
  assert.equal(month.display, "$9.95 remaining")
  assert.equal(usage.windows.some((w) => w.name === "5 hours"), false)
})

test("a window with no spend has nothing to expire", async () => {
  stubFetch({
    email: "go@example.com",
    plan: "Go",
    credits_remaining_micros: 100_000_000,
    credits_included_micros: 100_000_000,
    credits_per_5h_micros: 25_000_000,
    cost_5h_micros: 0,
    credits_per_week_micros: 50_000_000,
    cost_7d_micros: 0,
    oldest_5h: null,
    oldest_7d: null,
    requests_5h: 0,
    requests_limit_5h: 60_000,
    model_window: {},
  })
  const p = await plugin()
  const usage = await p.auth.usage(authed)
  for (const w of usage.windows.filter((w) => w.name === "5 hours" || w.name === "7 days")) {
    assert.equal(w.resetsAt, undefined, `${w.name} invented a reset time`)
  }
})

test("an expired key is reported as needing sign-in again", async () => {
  stubFetch({ error: { message: "Invalid API key." } }, 401)
  const p = await plugin()
  const usage = await p.auth.usage(authed)
  assert.equal(usage.error, "Invalid API key.")
  assert.equal(usage.signIn, "expired")
})

test("a signed-out account asks for an API key", async () => {
  const p = await plugin()
  const usage = await p.auth.usage(async () => ({}))
  assert.equal(usage.signIn, "expired")
})

test("sign-in rejects anything that is not an OpenKodo key", async () => {
  const p = await plugin()
  const result = await p.auth.methods[0].authorize({ apiKey: "sk-wrong" })
  assert.equal(result.type, "failed")
})

test("sign-in accepts a key the gateway validates", async () => {
  const calls = stubFetch({ plan: "Pro", email: "pro@example.com" })
  const p = await plugin()
  const result = await p.auth.methods[0].authorize({ apiKey: KEY })
  assert.equal(result.type, "success")
  assert.deepEqual(result.metadata, { plan: "Pro", email: "pro@example.com" })
  // The key travels as a bearer token, never in the URL.
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`)
  assert.ok(!calls[0].url.includes(KEY))
})

test("the provider advertises its icon where the host reads it", async () => {
  const p = await plugin()
  assert.equal(p.auth.icon, "https://openkodo.dev/favicon.svg")
  assert.equal(p.auth.provider, "openkodo")
})

test("models map vendor prices into the host's cost shape", async () => {
  stubFetch({
    models: [
      {
        code: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        context_window: 1_000_000,
        max_output: 65_536,
        offpeak_input_price_micros_per_mtok: 150_000,
        offpeak_output_price_micros_per_mtok: 600_000,
        offpeak_cached_input_price_micros_per_mtok: 3_000,
      },
    ],
  })
  const p = await plugin()
  const models = await p.provider.models({})
  assert.deepEqual(models["deepseek-v4.1-flash"].cost, {
    input: 0.15,
    output: 0.6,
    cache: { read: 0.003 },
  })
})

test("the live model list falls back when the API is down", async () => {
  stubFetch({ error: "down" }, 500)
  const p = await plugin()
  const models = await p.provider.models({ models: {} })
  assert.ok(Object.keys(models).length > 0)
  assert.ok(models["deepseek-v4.1-flash"])
})

test("the loader hands the host the base URL and key", async () => {
  const p = await plugin()
  const out = await p.auth.loader(authed)
  assert.deepEqual(out, { baseURL: "https://api.openkodo.dev/v1", apiKey: KEY })
  assert.deepEqual(await p.auth.loader(async () => ({})), {})
})
