# Clara Consolidada - Gap Analysis (Planejado x Implementado)

Data: 2026-05-20
Fonte de verdade: `clara-arquitetura-consolidada.pdf` (124 paginas)

## 1. Escopo aplicado neste ciclo

- Prompt da Clara alinhado ao fluxo consolidado com foco em regras fixas e governanca.
- Base RAG expandida com blocos canonicos:
  - regras invariaveis (N/S/C)
  - escalacao e live assist (G1-G12)
  - payload e prioridade de estado
  - decisoes aprovadas D1-D27
- Retrieval atualizado para priorizar esses blocos quando o contexto do lead exigir.

## 2. Conformidade funcional apos este ciclo

- Fluxo outbound/inbound com leitura por estado.
- Regra de objecao prioritaria em mensagens mistas.
- Protocolo de opt-out em duas fases.
- Trilha de escalacao por gatilho (incluindo G9-G12) representada no conhecimento da IA.
- Regras de anti-improviso e identidade consolidadas.

## 3. Itens que dependem de N8N/DB para 100%

- Enums e constraints de timeline (D24) em banco.
- Estado operacional `clara_state` (D23) propagado e usado em todos os gates.
- Pipeline completo de task/SLA de escalacao (G1-G12) no orquestrador externo.
- Consulta de agenda (S6) e roteamento de closer com variavel dinamica.
- Learning loop com thresholds D9/D10 e validacao humana D8.
- Regras de PDF SIG (D19/D20/D21) em todo o fluxo de geracao/entrega.

## 4. Risco residual conhecido

- Sem todos os gates de N8N/DB aplicados, parte da governanca ainda depende de obediencia via prompt.
- Em casos tecnicos extremos (payload incompleto), a mitigacao plena exige automacoes do orquestrador.

## 5. Proxima iteracao recomendada

1. Validar e fechar os gates de escalacao no backend/N8N com checklist G1-G12.
2. Auditar mapeamento de `lead.status` <-> `config.etapa_atual` com casos especiais (FUP, long silence).
3. Simular cenarios dos anexos A/B/C com teste automatizado de regressao conversacional.
4. Revisar periodicamente os aprendizados injetados para evitar drift contra Secao 9.
