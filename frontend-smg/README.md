# frontend-smg

Painel web para monitorar agentes do `backend-smg-system`.

## O que mostra

- Lista de agentes detectados em `src/agents/*`.
- Conversas da IA por `conversationKey`.
- Configuracoes do agente (AI/WF2/providers).
- Execucoes com grafo de etapas (React Flow), estilo observabilidade de workflow.

## Rodar local

1. Backend:

```bash
cd backend-smg-system
npm install
npm run dev
```

2. Frontend:

```bash
cd frontend-smg
npm install
npm run dev
```

3. Acesse:

- Frontend: `http://localhost:5175`
- Backend API: `http://localhost:3344/api`

## Variavel de ambiente

Copie `.env.example` para `.env` e ajuste se necessario:

```env
VITE_SMG_API_URL=http://localhost:3344/api
```

## Endpoints consumidos

- `GET /api/agents`
- `GET /api/agents/:agentSlug/conversations`
- `GET /api/agents/:agentSlug/conversations/:conversationKey/messages`
- `GET /api/agents/:agentSlug/executions`
- `GET /api/agents/:agentSlug/executions/:runId`
