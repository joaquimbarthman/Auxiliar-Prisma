# Auxiliar Prisma

Bot do Discord que monitora a atividade de um unico usuario e a disponibiliza
por uma API HTTP. O bot acompanha somente a presenca, o jogo atual e a musica
do Spotify. Ele nao le mensagens nem executa tarefas de moderacao.

## Requisitos

- Node.js 18 ou superior
- Uma aplicacao com bot criada no Discord Developer Portal
- O intent privilegiado `Presence Intent` habilitado
- Credenciais da Twitch para consultar informacoes de jogos na IGDB

## Configuracao

Crie um arquivo `.env` na raiz do projeto:

```env
DISCORD_TOKEN=token_do_bot
DISCORD_SERVER=id_do_servidor
DISCORD_USER=id_do_usuario_monitorado
CLIENT_TWITCH=client_id_da_twitch
SECRET_TWITCH=client_secret_da_twitch
PORT=3000

# Use 1 somente se a hospedagem utilizar um unico proxy reverso confiavel.
TRUST_PROXY_HOPS=0

# Persistencia opcional no Supabase
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=chave_service_role
SUPABASE_TABLE=profile_views
```

O arquivo `.env` e ignorado pelo Git para evitar o envio de credenciais ao
repositorio.

## Executando

```bash
npm install
npm test
npm start
```

A API fica disponivel em `http://localhost:3000` por padrao.

A API aplica limites por endereco IP: 300 requisicoes a cada 15 minutos,
60 consultas de status por minuto e 3 tentativas de registro de visitante por
dia. Em ambientes com mais de uma instancia, configure um armazenamento
compartilhado para os limites antes de escalar horizontalmente.

## Rotas

- `GET /api/status`: retorna presenca, jogo ou Spotify do usuario monitorado.
- `GET /api/uid-geral`: retorna o identificador persistente da instalacao.
- `POST /api/profile-view`: registra um visitante unico.
- `POST /api/sync-uids`: restaura identificadores de visitantes.
- `GET /api/profile-views`: retorna as estatisticas de visitantes.

Sem as configuracoes do Supabase, os identificadores de visitantes continuam
sendo persistidos localmente em `views.json`.

## Supabase

A migration [202608270001_create_profile_views.sql](supabase/migrations/202608270001_create_profile_views.sql)
cria a tabela `public.profile_views`. Execute o arquivo no SQL Editor do
Supabase ou aplique-o com a CLI do Supabase.

Depois, execute
[202608270002_migrate_legacy_profile_views.sql](supabase/migrations/202608270002_migrate_legacy_profile_views.sql)
para importar os 729 visitantes unicos recuperados do backend antigo. A
importacao usa `on conflict do nothing`, portanto pode ser repetida sem duplicar
visitantes existentes.

A tabela guarda o UUID anonimo do visitante, a quantidade de acessos e as datas
da primeira e da ultima visualizacao. A funcao `register_profile_view` atualiza
esses dados de forma atomica. O RLS fica habilitado e o acesso direto de usuarios
anonimos ou autenticados e bloqueado; as operacoes devem ser feitas pelo backend
com a chave `service_role`.
