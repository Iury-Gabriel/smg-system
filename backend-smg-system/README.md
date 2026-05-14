# backend-smg-system

Backend para scraping automatizado com **2 workflows no mesmo serviço**:

- `smg` (fluxo original)
- `bsb` (novo LDR BSB)

Cada workflow usa:

- banco separado (URLs diferentes)
- presets/segmentos separados
- agendamento diario proprio

Stack:

- Node.js + Express
- BullMQ (fila + worker)
- Prisma
- SerpAPI (`google` + `google_maps`)

## 1. Setup

```bash
cd backend-smg-system
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate deploy
npx prisma db push
npm run seed
```

## 2. Rodar

Em terminais separados:

```bash
# API
npm run dev

# Worker BullMQ
npm run worker
```

Opcional para garantir o agendamento:

```bash
npm run scheduler
```

## 3. Agendamento diario

Defaults no `.env`:

- `SCRAPER_CRON_SMG=0 9 * * *`
- `SCRAPER_CRON_BSB=0 10 * * *`
- `SCRAPER_TIMEZONE=America/Sao_Paulo`

Ou seja:

- `smg` roda diariamente as **09:00**
- `bsb` roda diariamente as **10:00**

## 4. Banco unico com tabelas por workflow

Variaveis principais:

- `DATABASE_URL` (default: `postgresql://smg:smg123@localhost:5432/smg?schema=public`)
- `DEFAULT_WORKFLOW` (default: `smg`)

O backend resolve o workflow por `workflow=smg|bsb` (query/body).
Sem informar, usa `DEFAULT_WORKFLOW`.

Separacao de dados:

- `smg`: tabelas `LeadAutomacao`, `DiscardLog`, `SegmentConfig`, `SearchPreset`, `JobExecution`
- `bsb`: tabelas `LeadAutomacaoBsb`, `DiscardLogBsb`, `SegmentConfigBsb`, `SearchPresetBsb`, `JobExecutionBsb`

## 5. Endpoints

- `GET /api/health`
- `POST /api/scrape/run` body opcional: `{ "workflow": "bsb", "segments": ["engenharia"] }`
- `POST /api/scrape/schedule/ensure` body opcional: `{ "workflow": "all" }`
- `GET /api/scrape/executions?workflow=smg|bsb|all`
- `GET /api/leads?workflow=smg|bsb|all`
- `GET /api/leads/discarded?workflow=smg|bsb|all`
- `GET /api/config/segments?workflow=smg|bsb`
- `PATCH /api/config/segments/:segment` body: `{ "workflow": "bsb", "isActive": true }`
- `GET /api/config/presets?workflow=smg|bsb`
- `PATCH /api/config/presets/:id/start` body: `{ "workflow": "bsb", "startOffset": 0 }`

## 6. Seed

```bash
# ambos
npm run seed

# somente SMG
npm run seed:smg

# somente BSB
npm run seed:bsb
```

O seed BSB cria segmentos/presets para:

- construtora
- engenharia
- arquitetura

com foco em Brasilia.

## 7. LDR BSB implementado

No fluxo BSB:

- deduplicacao adicional por `email`
- descarte quando nao houver email
- descarte quando nao houver site
- descarte quando o WhatsApp nao iniciar com DDD 11
- Instagram opcional (quando existir, e salvo no lead)
- validacao do conteudo do site para confirmar atuacao em obras, engenharia, arquitetura ou consultoria relacionada
- descarte por palavras-chave proibidas (paisagismo/interiores/incorporadora pura)
- `canalAquisicao` salvo como `scrap_bsb`
- meta obrigatoria por execucao: no minimo 70 aprovados (com ate 4 passadas pelos presets no mesmo job)

Metas por execucao:

- `smg`: 34 leads aprovados
- `bsb`: 70 leads aprovados

No fluxo SMG:

- comportamento original preservado
- `canalAquisicao` segue `scrap_smg`

## 8. Enriquecimento de website

Implementado em `src/services/site-scraper.service.js` com `axios + cheerio`.

Esse modulo tenta extrair emails/telefones da URL do site do lead.

Para sites com renderizacao JS pesada, a recomendacao e adicionar fallback com Playwright.

## 9. Multiagentes por pasta (webhooks + IA)

Agora o backend suporta agentes por pasta fisica com pipeline completo de atendimento:

- parser inbound (Meta oficial e Uazapi)
- buffer de mensagens por conversa
- contexto/historico persistido em banco (Prisma)
- orchestrator OpenAI com LangChain e tools por agente
- envio de resposta por provider (Meta/Uazapi)

Estrutura:

- `src/agents/default-sdr/agent.js` (exemplo pronto)
- `src/agents/_template/` (template para duplicar)

Cada pasta de agente gera webhooks dedicados:

- `GET /api/webhooks/:agentSlug/meta` (verificacao Meta)
- `POST /api/webhooks/:agentSlug/meta` (inbound Meta)
- `POST /api/webhooks/:agentSlug/uazapi` (inbound Uazapi)

Endpoints de apoio:

- `GET /api/agents` (lista agentes, urls de webhook, workflow e status de IA/credenciais)
- `GET /api/agents/:agentSlug`
- `POST /api/agents/:agentSlug/messages/send` body: `{ "provider": "meta|uazapi", "to": "5599999999999", "text": "Oi" }`

Comando especial no inbound:

- `/clear` limpa memoria da conversa (historico/sessao) e descarta buffer pendente.

## 10. Credenciais por agente

Campos ja preparados no `.env.example` para o agente `default-sdr`:

- Meta: `AGENT_DEFAULT_SDR_META_ACCESS_TOKEN`, `AGENT_DEFAULT_SDR_META_WABA_ID`, `AGENT_DEFAULT_SDR_META_PHONE_NUMBER_ID`, `AGENT_DEFAULT_SDR_META_VERIFY_TOKEN`
- Uazapi: `AGENT_DEFAULT_SDR_UAZAPI_BASE_URL`, `AGENT_DEFAULT_SDR_UAZAPI_INSTANCE_TOKEN`, `AGENT_DEFAULT_SDR_UAZAPI_WEBHOOK_SECRET`, `AGENT_DEFAULT_SDR_UAZAPI_SEND_PATH`
- IA: `AGENT_DEFAULT_SDR_AI_ENABLED`, `AGENT_DEFAULT_SDR_OPENAI_API_KEY`, `AGENT_DEFAULT_SDR_OPENAI_MODEL`, `AGENT_DEFAULT_SDR_BUFFER_SECONDS`, `AGENT_DEFAULT_SDR_HISTORY_LIMIT`

Tambem existem defaults globais:

- `META_GRAPH_BASE_URL`
- `META_WEBHOOK_VERIFY_TOKEN`
- `UAZAPI_BASE_URL`
- `UAZAPI_SEND_MESSAGE_PATH`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_BASE_URL`
- `AGENT_DEFAULT_BUFFER_SECONDS`
- `AGENT_CONVERSATION_HISTORY_LIMIT`

## 11. Como criar um novo agente

1. Copiar `src/agents/_template` para `src/agents/<slug-do-cliente>`.
2. Ajustar `slug`, `name`, `workflow`, `providers` e bloco `ai` no `agent.js`.
3. (Opcional) Implementar `buildTools` para tools customizadas do agente.
4. Preencher credenciais no `.env`.
5. Consultar o webhook em `GET /api/agents` e cadastrar na Meta/Uazapi.
