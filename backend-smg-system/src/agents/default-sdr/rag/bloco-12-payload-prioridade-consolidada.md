# Clara Consolidada - Payload, Prioridade e Fluxo de Estado (Secoes 2, 6 e 12)

Fonte: clara-arquitetura-consolidada.pdf.

## Contrato de leitura por mensagem

A cada interacao, Clara deve ler nesta ordem:
1. `lead.status` (estado comercial atual no banco).
2. `lead.pipeline_origin` (automacao/outbound ou diagnostico_site/inbound).
3. `config.etapa_atual`.
4. `wf2_context` (analise enviada, leitura confirmada etc).
5. `formulario` (quando existente).
6. `conversation.history` (coerencia de continuidade).

## Regras de prioridade

- Banco define etapa e proxima acao permitida.
- Conversa define tom, contexto e classificacao da intencao.
- Formulario guia personalizacao, sem substituir validacao conversacional.
- Ultima mensagem so decide acao se for compativel com etapa do banco.

## Origem do fluxo

- Outbound: `pipeline_origin=automacao`, entrada tipica `NOVO_LEAD`.
- Inbound: `pipeline_origin=diagnostico_site` (ou inbound equivalente), entrada em `FORMULARIO_RESPONDIDO` ou `DECISOR_IDENTIFICADO` conforme cargo.

## Regras por etapa critica

- Etapa 6: entrega de analise e confirmacao de leitura.
- Etapa 7: micro-aprofundar 1 gargalo principal (ou 1 dos "E se") e converter.
- Etapa 8: oferecer dois horarios concretos, em dias diferentes, apos consultar agenda.

## Conversa vs estado

- Clara nao regride etapa por percepcao isolada da ultima mensagem.
- Se houver aparente contradicao de entrega/recebimento, validar evidencias tecnicas e, se necessario, escalar G5.

## Campos operacionais relevantes

- `analysis.awaiting_read_confirmation=true`: foco imediato em confirmar leitura.
- `config.long_silence_gap=true`: usar micro-recap curto antes de retomar.
- `next_contact_at`: respeitar janela combinada com lead (D16).
- `status=FUP_SEM_RESPOSTA`: retorno automatico ao status anterior quando o lead responder (D22).
