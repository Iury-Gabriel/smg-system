# Base RAG da Clara

Esta pasta guarda conhecimento de suporte para a Clara.

## Como funciona

- O orquestrador carrega os arquivos desta pasta.
- Em cada mensagem inbound, ele monta o payload operacional (lead, historico, formulario, config).
- O mecanismo de retrieval seleciona os trechos mais relevantes por:
  - `lead.status`
  - `lead.pipeline_origin`
  - `lead.segmento`
  - `config.etapa_atual`
  - mensagem atual do lead
- Os trechos selecionados sao injetados no system prompt como `Contexto RAG recuperado`.

## Arquivos

- `bloco-01-objetivo-papel.md`: identidade, objetivo, limites e principios.
- `bloco-02-variaveis-contexto.md`: contrato de payload, prioridade de variaveis e uso.
- `bloco-03-classificacao-intencao.md`: categorias de intencao, acao obrigatoria e protocolo de incerteza.
- `bloco-04-qualificacao-bant-spin.md`: qualificacao com formulario obrigatorio, BANT + SPIN adaptados.
- `bloco-05-identificacao-decisor.md`: sinais passivos/ativos, fluxo de intermediario e rastreabilidade.
- `bloco-06-estrutura-prompt-etapas.md`: comportamento por etapa do funil outbound/inbound.
- `bloco-07-diferenciacao-por-segmento.md`: calibracao por segmento (dores, objecoes, tom, urgencia).
- `aprendizados_contextuais.json`: padroes de conversa (segmento + etapa) para injecao dinamica.

## Como adicionar novos blocos

1. Crie um novo `.md` nesta pasta com titulo e secoes claras.
2. Use texto objetivo e orientado a decisao.
3. Se for aprendizado acionavel, adicione tambem em `aprendizados_contextuais.json`.

## Exemplo de registro de aprendizado

```json
{
  "segmento": "dentista",
  "etapa": "FORMULARIO_RESPONDIDO",
  "padrao": "Ao mencionar perda de pacientes por falta de retorno, use CTA unico para agendar diagnostico em ate 2 opcoes de horario.",
  "origem": "conversao_autonoma",
  "tags": ["objecao_tempo", "agendamento"]
}
```
