import dotenv from "dotenv";
dotenv.config();

import { Client, GatewayIntentBits, Partials } from "discord.js";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");

// ===== CONFIGURAÇÃO DE CORS =====
const corsOptions = {
  origin: function (origin, callback) {
    // Permite requisições sem origin
    if (!origin) {
      return callback(null, true);
    }

    // Verifica domínios exatos permitidos
    const allowedDomains = [
      "http://127.0.0.1:5500",
      "https://barthman.com.br",
      "https://www.barthman.com.br",
      "https://dashboard.uptimerobot.com",
    ];

    // Permite qualquer subdomínio de barthman.xyz
    const isBarthmanSubdomain = origin.match(/^https:\/\/([a-z0-9-]+\.)?barthman\.xyz$/);

    if (allowedDomains.includes(origin) || isBarthmanSubdomain) {
      return callback(null, true);
    }
    
    return callback(new Error("Não permitido por CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
// Aplica CORS ANTES de qualquer outro middleware
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Middlewares
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: true, limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// Variáveis de ambiente
const TOKEN = process.env.DISCORD_TOKEN;
const SERVER_ID = process.env.DISCORD_SERVER;
const USER_ID = process.env.DISCORD_USER;
const CLIENT_API = process.env.CLIENT_TWITCH;
const SECRET_API = process.env.SECRET_TWITCH;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "profile_views";
const SUPABASE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const requiredConfig = {
  DISCORD_TOKEN: TOKEN,
  DISCORD_SERVER: SERVER_ID,
  DISCORD_USER: USER_ID,
};
const missingConfig = Object.entries(requiredConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingConfig.length) {
  throw new Error(`Variaveis de ambiente ausentes: ${missingConfig.join(", ")}`);
}

// ─────────────── BOT ───────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log(`🤖 Bot online como ${client.user.tag}!`);
});


// ------------------ Helpers ------------------
function isUUIDv4(uid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uid);
}

const jogoCache = new Map();
let twitchTokenCache = null;

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function escapeIgdb(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function gerarTokenTwitch() {
  const agora = Date.now();
  if (twitchTokenCache && twitchTokenCache.expiresAt > agora) {
    return twitchTokenCache.accessToken;
  }

  if (!CLIENT_API || !SECRET_API) {
    throw new Error("Credenciais da Twitch nao configuradas");
  }

  const res = await fetchWithTimeout('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_API,
      client_secret: SECRET_API,
      grant_type: 'client_credentials'
    })
  });

  if (!res.ok) {
    throw new Error(`Twitch OAuth respondeu com status ${res.status}`);
  }

  const json = await res.json();
  if (!json.access_token) {
    throw new Error("Twitch OAuth nao retornou um token");
  }

  twitchTokenCache = {
    accessToken: json.access_token,
    expiresAt: agora + Math.max((json.expires_in || 3600) - 60, 60) * 1000,
  };
  return twitchTokenCache.accessToken;
}

async function buscarDadosDoJogo(nomeDoJogo, accessToken) {
  const CLIENT_ID = CLIENT_API;
  const nomeSeguro = escapeIgdb(nomeDoJogo);

  async function buscar(query) {
    const res = await fetchWithTimeout('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': CLIENT_ID,
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      },
      body: query
    });

    if (!res.ok) {
      throw new Error(`IGDB respondeu com status ${res.status}`);
    }

    return await res.json();
  }

  let resultados = await buscar(`
   fields name, cover.url, involved_companies.developer, involved_companies.company.name, websites.url, first_release_date;
   where name = "${nomeSeguro}";
   sort first_release_date desc;
   limit 1;
 `);

  if (!resultados.length) {
    resultados = await buscar(`
     search "${nomeSeguro}";
     fields name, cover.url, involved_companies.developer, involved_companies.company.name, websites.url, first_release_date;
     where name ~ *"${nomeSeguro}"*;
     limit 1;
   `);
  }

  return resultados[0] || null;
}

async function obterJogo(nomeDoJogo) {
  const agora = Date.now();

  const cache = jogoCache.get(nomeDoJogo);
  if (cache && agora - cache.timestamp < 600000) {
    return cache;
  }

  let dados;
  try {
    const token = await gerarTokenTwitch();
    dados = await buscarDadosDoJogo(nomeDoJogo, token);
  } catch (err) {
    console.error(`Erro ao consultar o jogo "${nomeDoJogo}":`, err.message);
    return null;
  }

  if (!dados) return null;

  const capa = dados.cover?.url
    ? `https:${dados.cover.url.replace("t_thumb", "t_cover_big")}`
    : null;

  const devsPrincipais = dados.involved_companies
    ?.filter(c => c.developer === true)
    .map(c => c.company.name);

  const desenvolvedor = devsPrincipais?.length ? devsPrincipais[0] : undefined;

  const resultado = { capa, desenvolvedor, timestamp: agora };
  jogoCache.set(nomeDoJogo, resultado);

  if (jogoCache.size > 100) {
    const primeiroItem = jogoCache.keys().next().value;
    jogoCache.delete(primeiroItem);
  }
  return resultado;
}

// ------------------ Estado global ------------------
let ultimoJogo = "";
let tempoInicioJogo = "";
let tempoFimJogo = "";

let ultimaMusica = "";
let tempoFimMusica = "";

let ultimaAtividadeGenero = "";
let ultimaAtividadeImagem = "";
let ultimaAtividadeNome = "";
let ultimaAtividadeProtutor = "";
let ultimaAtividadeHora = "";
let ultimaAtividadeLink = "";

// ------------------ Sistema de Visualizações ------------------

const VIEWS_FILE = path.join(__dirname, 'views.json');


function loadViews() {
  try {
    if (fs.existsSync(VIEWS_FILE)) {
      return JSON.parse(fs.readFileSync(VIEWS_FILE, "utf8"));
    }
  } catch (err) {
    console.error("Erro ao carregar views:", err);
  }

  return {
    uidGeral: null,
    uniqueVisitors: {}
  };
}

function saveViews(data) {
  try {
    fs.writeFileSync(VIEWS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Erro ao salvar views:", err);
  }
}

let profileViews = loadViews();

// ------------------ UID GERAL (PERSISTENTE) ------------------

let uidGeral = profileViews.uidGeral;

if (!uidGeral) {
  uidGeral = crypto.randomUUID();
  profileViews.uidGeral = uidGeral;
  saveViews(profileViews);
}

console.log("🔑 uidGeral ativo:", uidGeral);
console.log(`Persistencia de visualizacoes: ${SUPABASE_ENABLED ? "Supabase" : "views.json"}`);

async function supabaseRequest(endpoint, options = {}) {
  const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Supabase respondeu com status ${response.status}: ${details}`);
  }

  if (response.status === 204 || options.method === "HEAD") {
    return { data: null, response };
  }

  return { data: await response.json(), response };
}

async function getSupabaseVisitorCount() {
  const { response } = await supabaseRequest(
    `${encodeURIComponent(SUPABASE_TABLE)}?select=visitor_uid&limit=1`,
    { headers: { Prefer: "count=exact" } }
  );
  const contentRange = response.headers.get("content-range") || "*/0";
  return Number(contentRange.split("/")[1]) || 0;
}

async function getSupabaseVisitorUids() {
  const { data } = await supabaseRequest(
    `${encodeURIComponent(SUPABASE_TABLE)}?select=visitor_uid&order=first_seen_at.asc`
  );
  return data.map((row) => row.visitor_uid);
}

async function registerSupabaseVisitor(uidUnico) {
  const { data } = await supabaseRequest("rpc/register_profile_view", {
    method: "POST",
    body: JSON.stringify({ p_visitor_uid: uidUnico }),
  });
  return data === true;
}

async function syncSupabaseVisitors(allVisitorUids) {
  if (!allVisitorUids.length) return 0;

  const { data } = await supabaseRequest(encodeURIComponent(SUPABASE_TABLE), {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(allVisitorUids.map((visitor_uid) => ({ visitor_uid }))),
  });
  return Array.isArray(data) ? data.length : 0;
}

function localVisitorCount() {
  return Object.keys(profileViews.uniqueVisitors).length;
}

function registerLocalVisitor(uidUnico) {
  const isNewVisitor = !profileViews.uniqueVisitors[uidUnico];
  if (isNewVisitor) {
    profileViews.uniqueVisitors[uidUnico] = true;
    saveViews(profileViews);
  }
  return isNewVisitor;
}

// ------------------ Rotas ------------------

// UID do servidor
app.get("/api/uid-geral", (req, res) => {
  res.json({ uidGeral });
});

// 🔄 Sincronizar UIDs do navegador (restauração)
app.post("/api/sync-uids", async (req, res) => {
  const { allVisitorUids } = req.body;

  if (!Array.isArray(allVisitorUids)) {
    return res.status(400).json({ error: "allVisitorUids deve ser um array" });
  }

  const validUids = [...new Set(allVisitorUids.filter(isUUIDv4))];

  try {
    let restored = 0;
    let uniqueVisitors = 0;

    if (SUPABASE_ENABLED) {
      restored = await syncSupabaseVisitors(validUids);
      uniqueVisitors = await getSupabaseVisitorCount();
    } else {
      validUids.forEach((uid) => {
        if (registerLocalVisitor(uid)) restored++;
      });
      uniqueVisitors = localVisitorCount();
    }

    return res.json({ success: true, uidGeral, restored, uniqueVisitors });
  } catch (err) {
    console.error("Erro ao sincronizar visualizacoes:", err.message);
    let restored = 0;
    validUids.forEach((uid) => {
      if (registerLocalVisitor(uid)) restored++;
    });
    return res.json({
      success: true,
      uidGeral,
      restored,
      uniqueVisitors: localVisitorCount()
    });
  }
});

// ✅ Registrar visitante único
app.post("/api/profile-view", async (req, res) => {
  const { uidUnico } = req.body;

  // Validação: se UID inválido, REJEITA (não cria novo)
  if (!uidUnico || !isUUIDv4(uidUnico)) {
    return res.status(400).json({
      error: "UID inválido ou ausente. Cliente deve gerar um UID válido.",
      uidGeral,
      uniqueVisitors: localVisitorCount()
    });
  }

  try {
    const isNewVisitor = SUPABASE_ENABLED
      ? await registerSupabaseVisitor(uidUnico)
      : registerLocalVisitor(uidUnico);
    const uniqueVisitors = SUPABASE_ENABLED
      ? await getSupabaseVisitorCount()
      : localVisitorCount();

    console.log(`${isNewVisitor ? "Novo" : "Conhecido"} visitante: ${uidUnico}`);

    return res.json({
      success: true,
      uidUnico,
      uidGeral,
      isNewVisitor,
      uniqueVisitors
    });
  } catch (err) {
    console.error("Erro ao registrar visualizacao:", err.message);
    const isNewVisitor = registerLocalVisitor(uidUnico);
    return res.json({
      success: true,
      uidUnico,
      uidGeral,
      isNewVisitor,
      uniqueVisitors: localVisitorCount()
    });
  }
});


// Estatísticas
app.get("/api/profile-views", async (req, res) => {
  try {
    const allVisitorUIDs = SUPABASE_ENABLED
      ? await getSupabaseVisitorUids()
      : Object.keys(profileViews.uniqueVisitors);

    return res.json({
      uniqueVisitors: allVisitorUIDs.length,
      allVisitorUIDs,
      uidGeral
    });
  } catch (err) {
    console.error("Erro ao consultar visualizacoes:", err.message);
    const allVisitorUIDs = Object.keys(profileViews.uniqueVisitors);
    return res.json({
      uniqueVisitors: allVisitorUIDs.length,
      allVisitorUIDs,
      uidGeral
    });
  }
});


app.get("/api/status", async (req, res) => {
  const requestTimestamp = Date.now();

  try {
    if (!client.isReady()) {
      return res.status(503).json({
        error: "Bot ainda não está conectado ao Discord",
        timestamp: requestTimestamp
      });
    }

    const guild = await client.guilds.fetch(SERVER_ID);
    const member = await guild.members.fetch(USER_ID).catch(() => null);

    if (!member || !member.user) {
      return res.status(503).json({
        error: "Usuário não encontrado ou bot não tem acesso.",
        timestamp: requestTimestamp
      });
    }

    const user = member.user;
    const presence = member.presence || {};
    const activities = presence.activities || [];
    const status = presence.status || "offline";
    const avatar = user.displayAvatarURL({ format: "png", size: 256 });

    let decoration = null;
    if (user.avatarDecorationData) {
      const asset = user.avatarDecorationData.asset;
      const params = asset.startsWith('a_') ? 'size=240' : 'size=240&passthrough=false';
      decoration = `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png?${params}`;
    }

    const jogo = activities.find(a => a.type === 0);
    const spotify = activities.find(a => a.name === "Spotify");

    let totalAtividades = 0;
    if (jogo) totalAtividades++;
    if (spotify) totalAtividades++;

    const additional = totalAtividades > 1 ? totalAtividades - 1 : 0;

    if (jogo) {
      const detalhes = await obterJogo(jogo.name);

      if (jogo.name !== ultimoJogo) {
        ultimoJogo = jogo.name;
        tempoInicioJogo = jogo.timestamps?.start || Date.now();
      }

      ultimaAtividadeGenero = "jogo";
      ultimaAtividadeImagem = detalhes?.capa || null;
      ultimaAtividadeNome = jogo.name;
      ultimaAtividadeProtutor = detalhes?.desenvolvedor || null;
      ultimaAtividadeLink = null;

      return res.json({
        timestamp: requestTimestamp,
        avatar,
        decoration,
        status,
        additional,
        type: 1,
        name: jogo.name,
        time: tempoInicioJogo,
        developers: detalhes?.desenvolvedor || [],
        img: detalhes?.capa || null
      });
    }

    if (!jogo && ultimoJogo) {
      tempoFimJogo = Date.now();
      ultimaAtividadeHora = tempoFimJogo;
    }
    ultimoJogo = "";
    tempoInicioJogo = "";

    if (spotify) {
      let comecoMusica = spotify.timestamps?.start
        ? (typeof spotify.timestamps.start === 'number'
          ? spotify.timestamps.start
          : new Date(spotify.timestamps.start).getTime())
        : Date.now();

      let nomeMusica = spotify.details;
      let artistaMusica = spotify.state;
      let imagemMusica = spotify.assets?.largeImage
        ? `https://i.scdn.co/image/${spotify.assets.largeImage.replace("spotify:", "")}`
        : null;
      let linkMusica = `https://open.spotify.com/track/${spotify.syncId}`;

      ultimaMusica = nomeMusica;
      ultimaAtividadeGenero = "musica";
      ultimaAtividadeImagem = imagemMusica;
      ultimaAtividadeNome = nomeMusica;
      ultimaAtividadeProtutor = artistaMusica;
      ultimaAtividadeLink = linkMusica;

      return res.json({
        timestamp: requestTimestamp,
        avatar,
        decoration,
        status,
        additional,
        type: 2,
        name: nomeMusica,
        artist: artistaMusica,
        time: spotify.timestamps?.end && spotify.timestamps?.start
          ? spotify.timestamps.end - spotify.timestamps.start
          : null,
        startTime: comecoMusica, 
        img: imagemMusica,
        link: linkMusica
      });
    }

    if (!spotify && ultimaMusica) {
      tempoFimMusica = Date.now();
      ultimaAtividadeHora = tempoFimMusica;
    }
    ultimaMusica = "";

    return res.json({
      timestamp: requestTimestamp,
      avatar,
      decoration,
      status,
      additional: 0,
      type: 0,
      genre: ultimaAtividadeGenero,
      img: ultimaAtividadeImagem,
      name: ultimaAtividadeNome,
      producer: ultimaAtividadeProtutor,
      time: ultimaAtividadeHora,
      link: ultimaAtividadeLink
    });

  } catch (err) {
    console.error("Erro na rota /api/status:", err);
    return res.status(500).json({
      error: "Erro interno ao buscar status",
      timestamp: requestTimestamp
    });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "JSON invalido" });
  }

  console.error("Erro nao tratado na API:", err);
  return res.status(500).json({ error: "Erro interno do servidor" });
});

// ------------------ Server ------------------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`🌐 API online na porta ${PORT}!`));

server.on("error", (err) => {
  console.error(`Erro ao iniciar a API na porta ${PORT}:`, err.message);
  process.exitCode = 1;
});

function shutdown(signal) {
  console.log(`${signal} recebido. Encerrando o Auxiliar Prisma...`);
  client.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

client.login(TOKEN).catch((err) => {
  console.error("Erro ao conectar o bot ao Discord:", err.message);
  server.close();
  process.exitCode = 1;
});
