import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

const validEnv = {
  NODE_ENV: "production", PORT: "3000", DISCORD_TOKEN: "novo-token-seguro",
  DISCORD_SERVER: "123", DISCORD_USER: "456",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "nova-chave-segura",
  ALLOWED_ORIGINS: "https://example.com",
};

test("carrega configuracao de producao valida", () => {
  assert.deepEqual(loadConfig(validEnv).allowedOrigins, ["https://example.com"]);
});

test("rejeita placeholders e Supabase incompleto", () => {
  assert.throws(() => loadConfig({ ...validEnv, DISCORD_TOKEN: "change-me" }), /DISCORD_TOKEN/);
  assert.throws(() => loadConfig({ ...validEnv, SUPABASE_SERVICE_ROLE_KEY: "" }), /Supabase/);
});

test("exige HTTPS no CORS de producao", () => {
  assert.throws(() => loadConfig({ ...validEnv, ALLOWED_ORIGINS: "http://example.com" }), /CORS/);
});
