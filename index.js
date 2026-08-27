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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Variáveis de ambiente
const TOKEN = process.env.DISCORD_TOKEN;
const SERVER_ID = process.env.DISCORD_SERVER;
const USER_ID = process.env.DISCORD_USER;
const CLIENT_API = process.env.CLIENT_TWITCH;
const SECRET_API = process.env.SECRET_TWITCH;

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

let jogoCache = {};

async function gerarTokenTwitch() {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_API,
      client_secret: SECRET_API,
      grant_type: 'client_credentials'
    })
  });
  const json = await res.json();
  return json.access_token;
}

async function buscarDadosDoJogo(nomeDoJogo, accessToken) {
  const CLIENT_ID = CLIENT_API;

  async function buscar(query) {
    const res = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': CLIENT_ID,
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      },
      body: query
    });
    return await res.json();
  }

  let resultados = await buscar(`
   fields name, cover.url, involved_companies.developer, involved_companies.company.name, websites.url, first_release_date;
   where name = "${nomeDoJogo}";
   sort first_release_date desc;
   limit 1;
 `);

  if (!resultados.length) {
    resultados = await buscar(`
     search "${nomeDoJogo}";
     fields name, cover.url, involved_companies.developer, involved_companies.company.name, websites.url, first_release_date;
     where name ~ *"${nomeDoJogo}"*;
     limit 1;
   `);
  }

  return resultados[0] || null;
}

async function obterJogo(nomeDoJogo) {
  const agora = Date.now();

  if (jogoCache[nomeDoJogo] && (agora - jogoCache[nomeDoJogo].timestamp < 600000)) {
    return jogoCache[nomeDoJogo];
  }

  const token = await gerarTokenTwitch();
  const dados = await buscarDadosDoJogo(nomeDoJogo, token);

  if (!dados) return null;

  const capa = dados.cover?.url
    ? `https:${dados.cover.url.replace("t_thumb", "t_cover_big")}`
    : null;

  const devsPrincipais = dados.involved_companies
    ?.filter(c => c.developer === true)
    .map(c => c.company.name);

  const desenvolvedor = devsPrincipais?.length ? devsPrincipais[0] : undefined;

  const resultado = { capa, desenvolvedor, timestamp: agora };
  jogoCache[nomeDoJogo] = resultado;
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

// ------------------ Rotas ------------------

// UID do servidor
app.get("/api/uid-geral", (req, res) => {
  res.json({ uidGeral });
});

// 🔄 Sincronizar UIDs do navegador (restauração)
app.post("/api/sync-uids", (req, res) => {
  const { allVisitorUids } = req.body;

  if (!Array.isArray(allVisitorUids)) {
    return res.status(400).json({ error: "allVisitorUids deve ser um array" });
  }

  let restored = 0;

  allVisitorUids.forEach(uid => {
    if (isUUIDv4(uid) && !profileViews.uniqueVisitors[uid]) {
      profileViews.uniqueVisitors[uid] = true;
      restored++;
    }
  });

  if (restored > 0) {
    saveViews(profileViews);
  }

  return res.json({
    success: true,
    uidGeral,
    restored,
    uniqueVisitors: Object.keys(profileViews.uniqueVisitors).length
  });
});

// ✅ Registrar visitante único
app.post("/api/profile-view", (req, res) => {
  const { uidUnico } = req.body;

  // Validação: se UID inválido, REJEITA (não cria novo)
  if (!uidUnico || !isUUIDv4(uidUnico)) {
    return res.status(400).json({
      error: "UID inválido ou ausente. Cliente deve gerar um UID válido.",
      uidGeral,
      uniqueVisitors: Object.keys(profileViews.uniqueVisitors).length
    });
  }

  // Verifica se é novo visitante
  const isNewVisitor = !profileViews.uniqueVisitors[uidUnico];

  if (isNewVisitor) {
    profileViews.uniqueVisitors[uidUnico] = true;
    saveViews(profileViews);
    console.log(`✅ Novo visitante registrado: ${uidUnico}`);
  } else {
    console.log(`ℹ️  Visitante conhecido: ${uidUnico}`);
  }

  return res.json({
    success: true,
    uidUnico,
    uidGeral,
    isNewVisitor,
    uniqueVisitors: Object.keys(profileViews.uniqueVisitors).length
  });
});


// Estatísticas
app.get("/api/profile-views", (req, res) => {
  res.json({
    uniqueVisitors: Object.keys(profileViews.uniqueVisitors).length,
    allVisitorUIDs: Object.keys(profileViews.uniqueVisitors),
    uidGeral
  });
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

// ------------------ Server ------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 API online na porta ${PORT}!`));

client.login(TOKEN);