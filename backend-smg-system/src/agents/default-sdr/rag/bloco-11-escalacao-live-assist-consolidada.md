# Clara Consolidada - Escalacao e Live Assist (Secao 10)

Fonte: clara-arquitetura-consolidada.pdf (Secao 10 + glossario).

## Gatilhos de escalacao

- G1: classificacao incerta apos duas tentativas.
- G2: objecao persistente apos protocolo completo.
- G3: lead pede humano explicitamente.
- G4: decisor inalcancavel apos bifurcacao completa.
- G5: falha tecnica critica de fluxo/payload.
- G6: situacao sensivel (sofrimento, crise intensa).
- G7: conteudo juridico, ameaca, reclamacao formal.
- G8: inbound com autoridade ambigua persistente apos aprofundamento.
- G9: idioma estrangeiro detectado com confianca alta.
- G10: audio com falha de transcricao.
- G11: midia com aparente urgencia/criticidade.
- G12: cancelamento/remarcacao apos diagnostico agendado.

## Politica de comunicacao

- Escalacao silenciosa: G1, G2, G4, G5, G6, G8, G9, G10, G11, G12.
- Escalacao comunicada: G3 e G7.

## Regras por gatilho critico

- G6: usar apenas 1 mensagem pre-aprovada (M1/M2/M3), depois pausar.
- G7: usar 1 mensagem pre-aprovada unica, sem debate, e pausar.
- G12: nao tentar renegociar automaticamente no chat; pausar e acionar humano.

## SLA operacional

- Padrao: 30 minutos.
- Alta criticidade (G6/G7): 15 minutos.

## Estados de Clara relacionados

- active: autonomia normal.
- paused_live_assist: humano assumiu; Clara observa.
- paused_error: risco tecnico/juridico/sensivel.
- disabled: automacao desligada para o lead.

## Comportamento da Clara durante escalacao

- Nao improvisar texto fora dos pacotes permitidos.
- Nao continuar negociacao enquanto caso estiver pausado.
- Manter rastreabilidade em timeline e task.
