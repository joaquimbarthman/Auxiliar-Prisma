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

// ======================================================
// CORS
// ======================================================

const corsOptions = {
  origin: function (origin, callback) {
    // Permite requisições sem origin
    // Ex.: UptimeRobot, Postman, servidor etc.
    if (!origin) {
      return callback(null, true);
    }

    const allowedDomains = [
      "http://127.0.0.1:5500",
      "http://localhost:5500",
      "https://barthman.com.br",
      "https://www.barthman.com.br",
      "https://dashboard.uptimerobot.com",
    ];

    // Permite barthman.xyz e qualquer subdomínio
    const isBarthmanSubdomain =
      /^https:\/\/([a-z0-9-]+\.)?barthman\.xyz$/i.test(origin);

    if (
      allowedDomains.includes(origin) ||
      isBarthmanSubdomain
    ) {
      return callback(null, true);
    }

    console.warn(`CORS bloqueado para: ${origin}`);

    return callback(
      new Error("Não permitido por CORS")
    );
  },

  methods: [
    "GET",
    "POST",
    "OPTIONS"
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization"
  ],

  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));


// ======================================================
// MIDDLEWARES
// ======================================================

app.use(
  express.json({
    limit: "32kb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "32kb"
  })
);

app.use((req, res, next) => {
  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );

  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  next();
});

// ======================================================
// VARIÁVEIS DE AMBIENTE
// ======================================================

const TOKEN =
  process.env.DISCORD_TOKEN;

const SERVER_ID =
  process.env.DISCORD_SERVER;

const USER_ID =
  process.env.DISCORD_USER;

const CLIENT_API =
  process.env.CLIENT_TWITCH;

const SECRET_API =
  process.env.SECRET_TWITCH;

const SUPABASE_URL =
  process.env.SUPABASE_URL?.replace(/\/$/, "");

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_TABLE =
  process.env.SUPABASE_TABLE ||
  "profile_views";

const SUPABASE_ENABLED =
  Boolean(
    SUPABASE_URL &&
    SUPABASE_SERVICE_ROLE_KEY
  );

// ======================================================
// CONFIGURAÇÕES OBRIGATÓRIAS
// ======================================================

const requiredConfig = {
  DISCORD_TOKEN: TOKEN,
  DISCORD_SERVER: SERVER_ID,
  DISCORD_USER: USER_ID,
};

const missingConfig =
  Object.entries(requiredConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);

if (missingConfig.length) {
  throw new Error(
    `Variaveis de ambiente ausentes: ${missingConfig.join(", ")}`
  );
}

// ======================================================
// BOT DISCORD
// ======================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],

  partials: [
    Partials.Channel
  ],
});

client.once(
  "ready",
  () => {
    console.log(
      `🤖 Bot online como ${client.user.tag}!`
    );
  }
);

// ======================================================
// HELPERS
// ======================================================

function isUUIDv4(uid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    uid
  );
}

const jogoCache =
  new Map();

let twitchTokenCache =
  null;

// ======================================================
// FETCH COM TIMEOUT
// ======================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeout = 8000
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeout
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

// ======================================================
// IGDB / TWITCH
// ======================================================

function escapeIgdb(value) {
  return String(value)
    .replace(
      /\\/g,
      "\\\\"
    )
    .replace(
      /"/g,
      '\\"'
    );
}

async function gerarTokenTwitch() {
  const agora =
    Date.now();

  if (
    twitchTokenCache &&
    twitchTokenCache.expiresAt > agora
  ) {
    return twitchTokenCache.accessToken;
  }

  if (
    !CLIENT_API ||
    !SECRET_API
  ) {
    throw new Error(
      "Credenciais da Twitch nao configuradas"
    );
  }

  const res =
    await fetchWithTimeout(
      "https://id.twitch.tv/oauth2/token",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },

        body: new URLSearchParams({
          client_id:
            CLIENT_API,

          client_secret:
            SECRET_API,

          grant_type:
            "client_credentials",
        }),
      }
    );

  if (!res.ok) {
    throw new Error(
      `Twitch OAuth respondeu com status ${res.status}`
    );
  }

  const json =
    await res.json();

  if (!json.access_token) {
    throw new Error(
      "Twitch OAuth nao retornou um token"
    );
  }

  twitchTokenCache = {
    accessToken:
      json.access_token,

    expiresAt:
      agora +
      Math.max(
        (json.expires_in || 3600) - 60,
        60
      ) *
        1000,
  };

  return twitchTokenCache.accessToken;
}

// ======================================================
// BUSCAR JOGO
// ======================================================

async function buscarDadosDoJogo(
  nomeDoJogo,
  accessToken
) {
  const CLIENT_ID =
    CLIENT_API;

  const nomeSeguro =
    escapeIgdb(nomeDoJogo);

  async function buscar(query) {
    const res =
      await fetchWithTimeout(
        "https://api.igdb.com/v4/games",
        {
          method: "POST",

          headers: {
            "Client-ID":
              CLIENT_ID,

            Authorization:
              `Bearer ${accessToken}`,

            Accept:
              "application/json",
          },

          body:
            query,
        }
      );

    if (!res.ok) {
      throw new Error(
        `IGDB respondeu com status ${res.status}`
      );
    }

    return await res.json();
  }

  let resultados =
    await buscar(`
      fields
        name,
        cover.url,
        involved_companies.developer,
        involved_companies.company.name,
        websites.url,
        first_release_date;

      where name = "${nomeSeguro}";

      sort first_release_date desc;

      limit 1;
    `);

  if (!resultados.length) {
    resultados =
      await buscar(`
        search "${nomeSeguro}";

        fields
          name,
          cover.url,
          involved_companies.developer,
          involved_companies.company.name,
          websites.url,
          first_release_date;

        where name ~ *"${nomeSeguro}"*;

        limit 1;
      `);
  }

  return resultados[0] || null;
}

async function obterJogo(
  nomeDoJogo
) {
  const agora =
    Date.now();

  const cache =
    jogoCache.get(nomeDoJogo);

  if (
    cache &&
    agora - cache.timestamp < 600000
  ) {
    return cache;
  }

  let dados;

  try {
    const token =
      await gerarTokenTwitch();

    dados =
      await buscarDadosDoJogo(
        nomeDoJogo,
        token
      );
  } catch (err) {
    console.error(
      `Erro ao consultar o jogo "${nomeDoJogo}":`,
      err.message
    );

    return null;
  }

  if (!dados) {
    return null;
  }

  const capa =
    dados.cover?.url
      ? `https:${dados.cover.url.replace(
          "t_thumb",
          "t_cover_big"
        )}`
      : null;

  const devsPrincipais =
    dados.involved_companies
      ?.filter(
        (c) =>
          c.developer === true
      )
      .map(
        (c) =>
          c.company.name
      );

  const desenvolvedor =
    devsPrincipais?.length
      ? devsPrincipais[0]
      : undefined;

  const resultado = {
    capa,
    desenvolvedor,
    timestamp:
      agora,
  };

  jogoCache.set(
    nomeDoJogo,
    resultado
  );

  if (
    jogoCache.size > 100
  ) {
    const primeiroItem =
      jogoCache
        .keys()
        .next()
        .value;

    jogoCache.delete(
      primeiroItem
    );
  }

  return resultado;
}

// ======================================================
// ESTADO GLOBAL
// ======================================================

let ultimoJogo =
  "";

let tempoInicioJogo =
  "";

let tempoFimJogo =
  "";

let ultimaMusica =
  "";

let tempoFimMusica =
  "";

let ultimaAtividadeGenero =
  "";

let ultimaAtividadeImagem =
  "";

let ultimaAtividadeNome =
  "";

let ultimaAtividadeProtutor =
  "";

let ultimaAtividadeHora =
  "";

let ultimaAtividadeLink =
  "";

// ======================================================
// SISTEMA DE VIEWS
// ======================================================
//
// IMPORTANTE:
//
// views.json guarda SOMENTE:
//
// {
//   "uidGeral": "..."
// }
//
// Nenhum visitante é armazenado nele.
//
// Todos os visitantes ficam no Supabase.
//
// 1 visitor_uid = 1 view.
//
// Mesmo usuário entrando várias vezes
// NÃO aumenta a quantidade de views.
//
// ======================================================

const VIEWS_FILE =
  path.join(
    __dirname,
    "views.json"
  );

// ======================================================
// UID GERAL
// ======================================================

function loadUidGeral() {
  try {
    if (
      fs.existsSync(
        VIEWS_FILE
      )
    ) {
      const data =
        JSON.parse(
          fs.readFileSync(
            VIEWS_FILE,
            "utf8"
          )
        );

      if (
        data?.uidGeral &&
        isUUIDv4(
          data.uidGeral
        )
      ) {
        return data.uidGeral;
      }
    }
  } catch (err) {
    console.error(
      "Erro ao carregar uidGeral:",
      err.message
    );
  }

  return null;
}

function saveUidGeral(
  uidGeral
) {
  try {
    fs.writeFileSync(
      VIEWS_FILE,

      JSON.stringify(
        {
          uidGeral
        },
        null,
        2
      ),

      "utf8"
    );
  } catch (err) {
    console.error(
      "Erro ao salvar uidGeral:",
      err.message
    );
  }
}

// Carrega o UID existente
let uidGeral =
  loadUidGeral();

// Se não existir cria um
if (!uidGeral) {
  uidGeral =
    crypto.randomUUID();
}

// Sempre regrava.
//
// Dessa forma se o JSON antigo tiver:
//
// {
//   uidGeral,
//   uniqueVisitors,
//   qualquerOutraCoisa
// }
//
// ele será limpo automaticamente
// e ficará apenas com uidGeral.
//
saveUidGeral(
  uidGeral
);

console.log(
  "🔑 uidGeral ativo:",
  uidGeral
);

// ======================================================
// VERIFICAR SUPABASE
// ======================================================

if (!SUPABASE_ENABLED) {
  console.warn(
    "⚠️ Supabase não configurado. Sistema de views indisponível."
  );
}

// ======================================================
// REQUISIÇÃO SUPABASE
// ======================================================

async function supabaseRequest(
  endpoint,
  options = {}
) {
  if (!SUPABASE_ENABLED) {
    throw new Error(
      "Supabase não configurado"
    );
  }

  const response =
    await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/${endpoint}`,
      {
        ...options,

        headers: {
          apikey:
            SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

          "Content-Type":
            "application/json",

          ...options.headers,
        },
      }
    );

  if (!response.ok) {
    const details =
      await response.text();

    throw new Error(
      `Supabase respondeu com status ${response.status}: ${details}`
    );
  }

  if (
    response.status === 204 ||
    options.method === "HEAD"
  ) {
    return {
      data: null,
      response
    };
  }

  return {
    data:
      await response.json(),

    response,
  };
}

// ======================================================
// PEGAR QUANTIDADE DE VIEWS
// ======================================================
//
// A quantidade de views é simplesmente:
//
// quantidade de linhas da tabela.
//
// Como visitor_uid é PRIMARY KEY,
// nunca haverá dois registros com o mesmo UID.
//
// ======================================================

async function getSupabaseVisitorCount() {
  const {
    response
  } =
    await supabaseRequest(
      `${encodeURIComponent(
        SUPABASE_TABLE
      )}?select=visitor_uid`,
      {
        method:
          "HEAD",

        headers: {
          Prefer:
            "count=exact",
        },
      }
    );

  const contentRange =
    response.headers.get(
      "content-range"
    ) ||
    "*/0";

  const total =
    Number(
      contentRange.substring(
        contentRange.lastIndexOf(
          "/"
        ) + 1
      )
    );

  return Number.isFinite(
    total
  )
    ? total
    : 0;
}

// ======================================================
// REGISTRAR VISITANTE
// ======================================================
//
// NÃO usa register_profile_view.
//
// Isso é proposital.
//
// Sua função antiga incrementava:
//
// view_count = view_count + 1
//
// Aqui fazemos INSERT direto.
//
// Como visitor_uid é PRIMARY KEY:
//
// primeiro acesso:
// insere
//
// próximos acessos:
// conflito -> ignora
//
// Portanto:
//
// 1 usuário = 1 view
//
// ======================================================

async function registerSupabaseVisitor(
  uidUnico
) {
  const {
    data
  } =
    await supabaseRequest(
      `${encodeURIComponent(
        SUPABASE_TABLE
      )}?on_conflict=visitor_uid`,
      {
        method:
          "POST",

        headers: {
          Prefer:
            "resolution=ignore-duplicates,return=representation",
        },

        body:
          JSON.stringify({
            visitor_uid:
              uidUnico,
          }),
      }
    );

  // Se retornou uma linha:
  // visitante novo.
  //
  // Se retornou []:
  // UID já existia.

  return (
    Array.isArray(
      data
    ) &&
    data.length > 0
  );
}

// ======================================================
// API - UID GERAL
// ======================================================

app.get(
  "/api/uid-geral",
  (req, res) => {
    return res.json({
      uidGeral
    });
  }
);

// ======================================================
// API - REGISTRAR VIEW
// ======================================================

app.post(
  "/api/profile-view",
  async (
    req,
    res
  ) => {
    const {
      uidUnico
    } =
      req.body;

    // O navegador deve fornecer
    // um UUID v4 persistente.

    if (
      !uidUnico ||
      !isUUIDv4(
        uidUnico
      )
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "UID inválido ou ausente. O cliente deve enviar um UUID v4 válido.",
        });
    }

    try {
      const isNewVisitor =
        await registerSupabaseVisitor(
          uidUnico
        );

      // Sempre consulta o banco
      // depois do registro.

      const uniqueVisitors =
        await getSupabaseVisitorCount();

      console.log(
        `${
          isNewVisitor
            ? "Novo visitante"
            : "Visitante já existente"
        }: ${uidUnico}`
      );

      return res.json({
        success:
          true,

        isNewVisitor,

        uniqueVisitors,
      });
    } catch (err) {
      console.error(
        "Erro ao registrar visualização no banco:",
        err.message
      );

      // NÃO usa JSON como fallback.
      //
      // Se banco cair,
      // retorna erro.

      return res
        .status(503)
        .json({
          success:
            false,

          error:
            "Não foi possível consultar o banco de visualizações.",
        });
    }
  }
);

// ======================================================
// API - CONSULTAR VIEWS
// ======================================================
//
// Essa é a rota que o SITE usa
// para saber quantas views existem.
//
// Exemplo:
//
// GET /api/profile-views
//
// retorno:
//
// {
//   "uniqueVisitors": 27
// }
//
// ======================================================

app.get(
  "/api/profile-views",
  async (
    req,
    res
  ) => {
    try {
      // Consulta diretamente o banco.

      const uniqueVisitors =
        await getSupabaseVisitorCount();

      return res.json({
        uniqueVisitors
      });
    } catch (err) {
      console.error(
        "Erro ao consultar visualizações:",
        err.message
      );

      return res
        .status(503)
        .json({
          error:
            "Não foi possível consultar as visualizações.",
        });
    }
  }
);

// ======================================================
// API STATUS DISCORD
// ======================================================

app.get(
  "/api/status",
  async (
    req,
    res
  ) => {
    const requestTimestamp =
      Date.now();

    try {
      // ==================================================
      // BOT AINDA NÃO CONECTOU
      // ==================================================

      if (
        !client.isReady()
      ) {
        return res
          .status(503)
          .json({
            error:
              "Bot ainda não está conectado ao Discord",

            timestamp:
              requestTimestamp,
          });
      }

      // ==================================================
      // BUSCAR SERVIDOR E MEMBRO
      // ==================================================

      const guild =
        await client.guilds.fetch(
          SERVER_ID
        );

      const member =
        await guild.members
          .fetch(
            USER_ID
          )
          .catch(
            () => null
          );

      if (
        !member ||
        !member.user
      ) {
        return res
          .status(503)
          .json({
            error:
              "Usuário não encontrado ou bot não tem acesso.",

            timestamp:
              requestTimestamp,
          });
      }

      // ==================================================
      // DADOS DO USUÁRIO
      // ==================================================

      const user =
        member.user;

      const presence =
        member.presence ||
        {};

      const activities =
        presence.activities ||
        [];

      const status =
        presence.status ||
        "offline";

      const avatar =
        user.displayAvatarURL({
          format:
            "png",

          size:
            256,
        });

      // ==================================================
      // DECORAÇÃO DO AVATAR
      // ==================================================

      let decoration =
        null;

      if (
        user.avatarDecorationData
      ) {
        const asset =
          user
            .avatarDecorationData
            .asset;

        const params =
          asset.startsWith(
            "a_"
          )
            ? "size=240"
            : "size=240&passthrough=false";

        decoration =
          `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png?${params}`;
      }

      // ==================================================
      // ATIVIDADES
      // ==================================================

      const jogo =
        activities.find(
          (a) =>
            a.type === 0
        );

      const spotify =
        activities.find(
          (a) =>
            a.name ===
            "Spotify"
        );

      let totalAtividades =
        0;

      if (jogo) {
        totalAtividades++;
      }

      if (spotify) {
        totalAtividades++;
      }

      const additional =
        totalAtividades > 1
          ? totalAtividades - 1
          : 0;

      // ==================================================
      // JOGO
      // ==================================================

      if (jogo) {
        const detalhes =
          await obterJogo(
            jogo.name
          );

        if (
          jogo.name !==
          ultimoJogo
        ) {
          ultimoJogo =
            jogo.name;

          tempoInicioJogo =
            jogo.timestamps
              ?.start ||
            Date.now();
        }

        ultimaAtividadeGenero =
          "jogo";

        ultimaAtividadeImagem =
          detalhes?.capa ||
          null;

        ultimaAtividadeNome =
          jogo.name;

        ultimaAtividadeProtutor =
          detalhes
            ?.desenvolvedor ||
          null;

        ultimaAtividadeLink =
          null;

        return res.json({
          timestamp:
            requestTimestamp,

          avatar,

          decoration,

          status,

          additional,

          type:
            1,

          name:
            jogo.name,

          time:
            tempoInicioJogo,

          developers:
            detalhes
              ?.desenvolvedor ||
            [],

          img:
            detalhes?.capa ||
            null,
        });
      }

      // ==================================================
      // JOGO FINALIZADO
      // ==================================================

      if (
        !jogo &&
        ultimoJogo
      ) {
        tempoFimJogo =
          Date.now();

        ultimaAtividadeHora =
          tempoFimJogo;
      }

      ultimoJogo =
        "";

      tempoInicioJogo =
        "";

      // ==================================================
      // SPOTIFY
      // ==================================================

      if (spotify) {
        let comecoMusica =
          spotify.timestamps
            ?.start
            ? typeof spotify
                .timestamps
                .start ===
              "number"
              ? spotify
                  .timestamps
                  .start
              : new Date(
                  spotify
                    .timestamps
                    .start
                ).getTime()
            : Date.now();

        let nomeMusica =
          spotify.details;

        let artistaMusica =
          spotify.state;

        let imagemMusica =
          spotify.assets
            ?.largeImage
            ? `https://i.scdn.co/image/${spotify.assets.largeImage.replace(
                "spotify:",
                ""
              )}`
            : null;

        let linkMusica =
          `https://open.spotify.com/track/${spotify.syncId}`;

        ultimaMusica =
          nomeMusica;

        ultimaAtividadeGenero =
          "musica";

        ultimaAtividadeImagem =
          imagemMusica;

        ultimaAtividadeNome =
          nomeMusica;

        ultimaAtividadeProtutor =
          artistaMusica;

        ultimaAtividadeLink =
          linkMusica;

        return res.json({
          timestamp:
            requestTimestamp,

          avatar,

          decoration,

          status,

          additional,

          type:
            2,

          name:
            nomeMusica,

          artist:
            artistaMusica,

          time:
            spotify.timestamps
              ?.end &&
            spotify.timestamps
              ?.start
              ? spotify
                  .timestamps
                  .end -
                spotify
                  .timestamps
                  .start
              : null,

          startTime:
            comecoMusica,

          img:
            imagemMusica,

          link:
            linkMusica,
        });
      }

      // ==================================================
      // MÚSICA FINALIZADA
      // ==================================================

      if (
        !spotify &&
        ultimaMusica
      ) {
        tempoFimMusica =
          Date.now();

        ultimaAtividadeHora =
          tempoFimMusica;
      }

      ultimaMusica =
        "";

      // ==================================================
      // SEM ATIVIDADE
      // ==================================================

      return res.json({
        timestamp:
          requestTimestamp,

        avatar,

        decoration,

        status,

        additional:
          0,

        type:
          0,

        genre:
          ultimaAtividadeGenero,

        img:
          ultimaAtividadeImagem,

        name:
          ultimaAtividadeNome,

        producer:
          ultimaAtividadeProtutor,

        time:
          ultimaAtividadeHora,

        link:
          ultimaAtividadeLink,
      });

    } catch (err) {
      console.error(
        "Erro na rota /api/status:",
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Erro interno ao buscar status",

          timestamp:
            requestTimestamp,
        });
    }
  }
);

// ======================================================
// ERROS
// ======================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    if (
      err instanceof
        SyntaxError &&
      err.status ===
        400 &&
      "body" in err
    ) {
      return res
        .status(400)
        .json({
          error:
            "JSON invalido",
        });
    }

    console.error(
      "Erro nao tratado na API:",
      err
    );

    return res
      .status(500)
      .json({
        error:
          "Erro interno do servidor",
      });
  }
);

// ======================================================
// SERVIDOR
// ======================================================

const PORT =
  process.env.PORT ||
  3000;

const server =
  app.listen(
    PORT,
    () => {
      console.log(
        `🌐 API online na porta ${PORT}!`
      );
    }
  );

server.on(
  "error",
  (err) => {
    console.error(
      `Erro ao iniciar a API na porta ${PORT}:`,
      err.message
    );

    process.exitCode =
      1;
  }
);

// ======================================================
// SHUTDOWN
// ======================================================

function shutdown(
  signal
) {
  console.log(
    `${signal} recebido. Encerrando o Auxiliar Prisma...`
  );

  client.destroy();

  server.close(
    () =>
      process.exit(0)
  );

  setTimeout(
    () =>
      process.exit(1),
    5000
  ).unref();
}

process.once(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);

process.once(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

// ======================================================
// LOGIN DISCORD
// ======================================================

client
  .login(TOKEN)
  .catch(
    (err) => {
      console.error(
        "Erro ao conectar o bot ao Discord:",
        err.message
      );

      server.close();

      process.exitCode =
        1;
    }
  );