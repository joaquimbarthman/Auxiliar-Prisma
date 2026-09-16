const PLACEHOLDER_VALUES = new Set([
  "change-me",
  "replace-me",
  "token_do_bot",
  "client_secret_da_twitch",
  "chave_service_role",
]);

function required(env, name) {
  const value = env[name]?.trim();
  if (!value || PLACEHOLDER_VALUES.has(value.toLowerCase())) {
    throw new Error(
      `Variavel de ambiente obrigatoria ausente ou insegura: ${name}`,
    );
  }
  return value;
}

export function loadConfig(env = process.env) {
  const isProduction = (env.NODE_ENV || "development") === "production";
  const defaultProductionOrigins =
    "https://barthman.com.br,https://www.barthman.com.br";
  const hasSupabaseUrl = Boolean(env.SUPABASE_URL?.trim());
  const hasSupabaseKey = Boolean(env.SUPABASE_SERVICE_ROLE_KEY?.trim());
  if (hasSupabaseUrl !== hasSupabaseKey || (isProduction && !hasSupabaseUrl)) {
    throw new Error("Supabase deve ser configurado por completo em producao");
  }

  const table = (env.SUPABASE_TABLE || "profile_views").trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error("SUPABASE_TABLE possui formato invalido");
  }
  const port = Number.parseInt(env.PORT || "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT deve ser um numero entre 1 e 65535");
  }

  const allowedOrigins = (
    env.ALLOWED_ORIGINS || (isProduction ? defaultProductionOrigins : "")
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((origin) => {
      let url;
      try {
        url = new URL(origin);
      } catch {
        throw new Error(`Origem CORS invalida: ${origin}`);
      }
      if (
        url.origin !== origin ||
        (isProduction && url.protocol !== "https:")
      ) {
        throw new Error(`Origem CORS invalida: ${origin}`);
      }
      return origin;
    });
  let supabaseUrl = "";
  if (hasSupabaseUrl) {
    supabaseUrl = required(env, "SUPABASE_URL").replace(/\/$/, "");
    const parsed = new URL(supabaseUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      throw new Error("SUPABASE_URL deve usar HTTPS");
    }
  }

  return Object.freeze({
    isProduction,
    port,
    allowedOrigins,
    discordToken: required(env, "DISCORD_TOKEN"),
    discordServer: required(env, "DISCORD_SERVER"),
    discordUser: required(env, "DISCORD_USER"),
    twitchClient: env.CLIENT_TWITCH?.trim() || "",
    twitchSecret: env.SECRET_TWITCH?.trim() || "",
    supabaseUrl,
    supabaseServiceRoleKey: hasSupabaseKey
      ? required(env, "SUPABASE_SERVICE_ROLE_KEY")
      : "",
    supabaseTable: table,
  });
}
