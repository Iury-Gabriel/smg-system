# Estrutura de Agentes por Pasta

Cada agente fica em uma pasta com `agent.js` e pode usar:

- webhook Meta/Uazapi por agente
- orchestrator de IA (OpenAI + LangChain tools)
- buffer de mensagens por conversa
- historico e sessao da conversa no banco (Prisma)

Exemplo:

- `src/agents/default-sdr/agent.js`
- `src/agents/<novo-cliente>/agent.js`

Rotas geradas:

- `GET /api/webhooks/:agentSlug/meta`
- `POST /api/webhooks/:agentSlug/meta`
- `POST /api/webhooks/:agentSlug/uazapi`

Comando de memoria:

- Enviar `/clear` limpa o historico/sessao da conversa e o buffer pendente.

Para criar agente novo, duplique `src/agents/_template` e ajuste:

- `workflow`
- `ai` (api key/model/buffer/history)
- `providers`
- `buildTools` (opcional, para tools customizadas de IA)
