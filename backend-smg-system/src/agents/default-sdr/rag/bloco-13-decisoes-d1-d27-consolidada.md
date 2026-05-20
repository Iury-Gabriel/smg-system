# Clara Consolidada - Decisoes Aprovadas (D1-D27)

Resumo executivo das decisoes estrategicas aprovadas no documento consolidado.

## Identidade, fluxo e governanca

- D1: closer comunicado genericamente como "especialista do time" (nome apenas se houver variavel injetada).
- D2: pergunta "quem fala?" dispara apresentacao completa (S3).
- D3: inbound entra como decisor apenas com cargo inequivoco.
- D4: tres listas de cargo (decisor, nao-decisor, ambiguo) governam autoridade.
- D5: fluxos antigos deixam de ser canonicos; consolidado prevalece.

## Escalacao e seguranca

- D6: tres mensagens pre-aprovadas para G6.
- D7: mensagem unica pre-aprovada para G7.
- D8: SLA de validacao de live assist (janela inicial mais longa, depois 48h).

## Learning loop

- D9: threshold de injecao por origem (live assist com menos ocorrencias; conversao autonoma exige massa).
- D10: compilacao periodica por volume/tempo.

## Dados e operacao

- D11: deduplicacao por nome+empresa, sem exigir CNPJ/email.
- D12: formulario via WhatsApp entra em `leads_diagnostico` e vale como registro completo.
- D13: idioma estrangeiro vira gatilho G9.
- D14: audio/imagem/documento com bifurcacao de risco (G10/G11).
- D15: cancelamento/remarcacao pos-agendamento escala via G12.
- D16: `next_contact_at` para "me chama depois".
- D17: em mensagem mista, OBJECAO tem prioridade sobre INTERESSE.
- D18: micro-recap apos silencio longo.
- D19: etapa 7 aprofunda 1 "E se" (nao repetir os 3).
- D20: score do PDF nao pode contradizer leitura operacional.
- D21: resposta vaga de formulario pede aprofundamento antes da analise.
- D22: FUP_SEM_RESPOSTA com trigger temporal e retorno automatico ao status anterior.
- D23: `clara_state` separado de status comercial.
- D24: enum formal de eventos em timeline.
- D25: mensagens humanas em live assist entram no historico com rastreio interno.
- D26: documento consolidado entregue como artefato canonico unico.
- D27: nivel de detalhe profundo por etapa/segmento/gatilho.

## Uso pratico no prompt

- Quando houver ambiguidade, preferir protocolo seguro em vez de inferencia agressiva.
- Priorizar consistencia de estado, rastreabilidade e anti-improviso.
