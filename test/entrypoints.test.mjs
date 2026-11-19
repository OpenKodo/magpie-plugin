import assert from "node:assert/strict"
import test from "node:test"

import * as core from "../index.mjs"
import * as v1Module from "../v1.mjs"
import * as v2Module from "../v2.mjs"

const v1Plugin = v1Module.default
const v2 = v2Module.default
const { setup } = v2Module

test("1.x entry exports the plugin factory", () => {
  assert.equal(typeof v1Module.OpenKodoAuthPlugin, "function")
  assert.equal(typeof v1Plugin, "function")
  assert.equal(v1Plugin, core.OpenKodoAuthPlugin)
})

test("2.x entry declares the default { id, setup } shape", () => {
  assert.equal(v2.id, "openkodo")
  assert.equal(typeof v2.setup, "function")
  assert.equal(v2.setup, setup)
})

test("2.x setup publishes the provider, its models, and its icon", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      models: [
        {
          code: "deepseek-v4.1-flash",
          name: "DeepSeek V4.1 Flash",
          context_window: 1_000_000,
          max_output: 65_536,
        },
      ],
    }),
  })

  let published
  let method
  await setup({
    provider: { set: async (p) => (published = p) },
    auth: {
      method: async (m) => (method = m),
      get: async () => ({ key: "ok_live_test_key_not_real" }),
      provider: () => {},
    },
  })

  assert.equal(published.id, "openkodo")
  assert.equal(published.icon, "https://openkodo.dev/favicon.svg")
  assert.equal(published.api, "https://api.openkodo.dev/v1")
  assert.ok(Object.keys(published.models).length >= 1)
  assert.equal(method.provider, "openkodo")
  assert.equal(method.type, "api")
})

// magpie titles a plugin row from package.json's magpie.name, not from the
// npm name (which must be lowercase). Without this field the Plugins list
// reads "openkodo".
test("package.json names the plugin OpenKodo for magpie", async () => {
  const { readFile } = await import("node:fs/promises")
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(pkg.name, "openkodo")
  assert.equal(pkg.magpie.name, "OpenKodo")
})
