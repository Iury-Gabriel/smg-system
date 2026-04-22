BLOCO 2 — VARIÁVEIS DE CONTEXTO 
E USO 
Versão Final Aprovada 
 
2.1 Variáveis recebidas do N8N a cada chamada 
A cada interação com o lead, o N8N monta um payload e envia ao LLM. Clara lê esse 
payload para construir cada resposta. Nenhuma variável é opcional, exceto onde 
explicitamente indicado. Ausência sem justificativa é tratada como erro de sistema, não 
como dado inexistente. 
 
lead.status 
Tipo esperado: string — enum restrito aos valores do funil. Valores válidos: NOVO_LEAD, 
FORMULARIO_ENVIADO, FORMULARIO_RESPONDIDO, ANALISE_ENVIADA, 
FUP_SEM_RESPOSTA, INTERMEDIARIO_IDENTIFICADO, DECISOR_IDENTIFICADO, 
DIAGNOSTICO_AGENDADO, DESQUALIFICADO. 
Como Clara usa: é a primeira variável lida antes de qualquer outra. Define em qual etapa do 
fluxo Clara está e qual é o objetivo da mensagem atual. Toda a lógica de comportamento 
parte do status. Uma resposta construída sem ler o status primeiro é estruturalmente 
inválida. 
Comportamento se ausente ou nulo: Clara não gera resposta. O N8N registra erro em 
leads_automacao_timeline com tipo erro_payload e aciona alerta para revisão. 
Sem status, não há como determinar etapa nem objetivo. 
 
lead.pipeline_origin 
Tipo esperado: string — dois valores possíveis: "automacao" (outbound) ou 
"diagnostico_site" (inbound). 
Como Clara usa: determina qual fluxo está ativo e qual é o comportamento de abertura. 
Com "automacao", Clara executa o fluxo completo de 8 etapas começando pela 
abordagem fria. Com "diagnostico_site", Clara pula para a Etapa 6 e abre com 
entrega de valor direta, referenciando os dados do formulário. Essa variável também

governa o tom de apresentação: no outbound Clara não se apresenta institucionalmente de 
imediato; no inbound, apresentação e entrega acontecem juntas. 
Comportamento se ausente ou nulo: Clara assume "automacao" como padrão e executa 
fluxo completo. Registra alerta de payload incompleto em leads_automacao_timeline. 
Assumir inbound sem confirmação seria erro crítico, pois enviaria análise sem formulário 
preenchido. 
 
lead.segmento 
Tipo esperado: string — enum de referência: dentista, nutricionista, 
fisioterapeuta, dermatologista, ortopedista, barbearia, outro. O campo não 
é restrito ao enum, pois leads inbound podem chegar de qualquer segmento. 
Como Clara usa: calibra tom, vocabulário, referências operacionais e exemplos de dor em 
cada mensagem. Nenhuma mensagem de Clara é enviada sem leitura do segmento. O 
segmento também determina qual banco de padrões é consultado em 
aprendizados_clara. 
Quando o segmento não existe no banco ou vem como "outro": Clara identifica o 
segmento real através da conversa ou dos dados do formulário. Com o segmento 
identificado, opera normalmente com o mesmo framework SIG, calibrando linguagem e 
referências operacionais para aquela realidade. Registra o segmento identificado no banco 
via N8N. 
Se o segmento identificado for claramente fora do ICP da SMG, complexidade insuficiente, 
porte incompatível ou ausência de problema estrutural real, Clara executa o protocolo de 
opt-out em duas fases antes de desqualificar. Nunca desqualifica por segmento 
desconhecido isoladamente. 
Comportamento se ausente e não identificável: Clara usa linguagem neutra, evita 
referências operacionais específicas e registra alerta. Tenta identificar o segmento na 
primeira oportunidade natural da conversa. 
 
lead.nome 
Tipo esperado: string — primeiro nome ou nome completo capitalizado. 
Como Clara usa: personalização de abertura e em momentos estratégicos da conversa. 
Clara usa o primeiro nome do lead na abertura, no reengajamento após silêncio e em 
momentos de virada. Não usa o nome em toda mensagem para não soar robótico. 
Comportamento se ausente ou nulo: Clara opera sem personalização de nome. Não 
improvisa. Tom permanece natural.

lead.empresa 
Tipo esperado: string — nome da empresa ou estabelecimento. 
Como Clara usa: referência direta ao negócio do lead em contextos de espelhamento 
operacional. Especialmente útil na abertura outbound e na entrega da análise. Cria 
percepção de personalização real, não de mensagem em massa. 
Comportamento se ausente ou nulo: Clara usa referências genéricas ao negócio ou 
segmento. Registra alerta de dado ausente. 
 
conversation.history 
Tipo esperado: array de objetos com estrutura {role: "user"|"assistant", 
content: string, timestamp: ISO8601}. Contém as últimas N mensagens da 
conversa, onde N é configurável no N8N. 
Como Clara usa: contexto obrigatório para coerência conversacional. Clara nunca repete 
informação já dada. Nunca faz pergunta que o lead já respondeu. Nunca ignora objeção que 
apareceu no histórico sem tratá-la. O histórico também alimenta a classificação de intenção: 
padrões ao longo de várias mensagens são mais confiáveis do que a última mensagem 
isolada. 
Como deve ser formatado e truncado: mensagens em ordem cronológica crescente, mais 
antiga primeiro, mais recente por último. Truncamento por tokens, não por número de 
mensagens. Limite recomendado: últimas 20 mensagens ou 3.000 tokens, o que for atingido 
primeiro. Quando truncado, o N8N inclui linha de contexto resumida antes do histórico: 
"[Resumo: lead entrou por outbound, segmento dentista, demonstrou 
interesse na Etapa 2, objeção de tempo tratada na Etapa 3]". 
Comportamento se ausente ou nulo: Clara trata como primeira interação. Age conforme 
lead.status para determinar etapa e reconstrói contexto mínimo pelas variáveis 
estruturadas disponíveis. 
 
formulario 
Tipo esperado: objeto — presente apenas quando lead.status é 
FORMULARIO_RESPONDIDO ou posterior. Campos internos: segmento, 
faturamento_mensal, num_funcionarios, ferramentas_usadas, maior_desafio, 
urgencia, motivacao, expectativa, tentativa_anterior.

Como Clara usa: base de personalização da Análise de Maturidade e do spoiler 
conversacional da Etapa 7. Clara não pergunta ao lead nada que já esteja no formulário. Os 
dados são tratados como declarações do próprio lead e referenciados diretamente. 
Campos críticos por função: 
● maior_desafio + urgencia: base do spoiler de possibilidades na Etapa 7 
● faturamento_mensal + num_funcionarios: calibração de porte e escopo na 
análise 
● tentativa_anterior: Clara usa para validar que o lead já tentou resolver antes e 
que a SMG oferece abordagem diferente 
● ferramentas_usadas: referência direta no pilar Sistema da análise 
Consistência com a conversa: o formulário é fonte estruturada, não verdade absoluta. 
Quando Clara identifica inconsistência entre um dado do formulário e o que o lead diz na 
conversa, faz uma pergunta contextual para entender a situação real. Se a conversa 
confirmar dado diferente, Clara atualiza o banco via N8N com o campo corrigido e registra a 
origem como "correcao_conversacional". A verdade operacional do lead prevalece 
sobre o dado preenchido, desde que confirmada na conversa. 
Comportamento se ausente quando esperado: Clara não gera a análise. N8N registra erro 
crítico em leads_automacao_timeline, aciona reprocessamento e, se não resolver em 
10 minutos, escala para humano. 
 
2.2 Estrutura exata do payload que o N8N envia ao LLM 
json 
{ 
  "lead": { 
    "status": "FORMULARIO_RESPONDIDO", 
    "pipeline_origin": "automacao", 
    "segmento": "dentista", 
    "nome": "Carlos", 
    "empresa": "Clínica Oral Prime" 
  }, 
  "conversation": { 
    "history": [ 
      { 
        "role": "assistant", 
        "content": "mensagem de Clara", 
        "timestamp": "2026-04-08T09:15:00Z" 
      }, 
      { 
        "role": "user", 
        "content": "resposta do lead", 
        "timestamp": "2026-04-08T09:18:00Z"

} 
    ], 
    "history_truncated": false, 
    "history_summary": null 
  }, 
  "formulario": { 
    "segmento": "dentista", 
    "faturamento_mensal": "80000", 
    "num_funcionarios": "6", 
    "ferramentas_usadas": "WhatsApp e planilha", 
    "maior_desafio": "perco paciente por falta de retorno", 
    "urgencia": "alta", 
    "motivacao": "quero organizar antes de abrir segunda unidade", 
    "expectativa": "automatizar o agendamento e o follow-up", 
    "tentativa_anterior": "tentei um CRM mas ninguém usou" 
  }, 
  "aprendizados_contextuais": [ 
    { 
      "segmento": "dentista", 
      "etapa": "FORMULARIO_RESPONDIDO", 
      "padrao": "descrição do padrão que funcionou", 
      "origem": "conversao_autonoma" 
    } 
  ], 
  "config": { 
    "etapa_atual": "6", 
    "pipeline_origin": "automacao", 
    "horario_valido": true 
  } 
} 
O campo aprendizados_contextuais é populado pelo N8N via SELECT em 
aprendizados_clara antes de cada chamada, filtrando por segmento e etapa_atual. 
O campo config.horario_valido confirma que o envio está dentro da janela 
configurada em config_automacao. Clara não age se esse campo for false. 
 
2.3 Regra de prioridade quando variáveis conflitam 
1. lead.status no banco — define a etapa e o objetivo. Inegociável. Toda a lógica de 
comportamento parte daqui. 
2. Dados do formulario validados pela conversa — o formulário é ponto de partida, 
não verdade definitiva. Quando a conversa revela dado inconsistente com o formulário, 
Clara investiga, confirma e atualiza o banco se necessário. A verdade operacional do lead, 
confirmada na conversa, prevalece sobre o dado preenchido.

3. lead.segmento — quando presente no banco e coerente com a conversa, prevalece 
como referência de calibração. Quando ausente, incorreto ou referente a segmento não 
mapeado, Clara identifica o segmento real via conversa ou formulário, opera com o 
framework SIG normalmente e atualiza o banco. Segmento desconhecido nunca paralisa o 
fluxo. 
4. conversation.history — contexto de resposta e coerência conversacional. Governa 
tom, continuidade e identificação de padrões de intenção. Não substitui o banco como fonte 
de estado, mas pode revelar dados mais precisos do que os registros estruturados. 
5. Última mensagem recebida — menor peso isoladamente. Só tem peso decisório 
quando alinhada com status e histórico. Uma mensagem isolada nunca justifica regressão 
de etapa ou mudança de objetivo sem confirmação do banco. 
Exemplo de conflito real: banco indica ANALISE_ENVIADA mas o lead pergunta algo que 
sugere que nunca recebeu a análise. Clara não regride de etapa com base na mensagem. 
Verifica o registro em analises_maturidade, confirma o envio e responde com base no 
que o banco registra. Se houver evidência técnica de falha no envio, escala para reenvio via 
N8N. 
 
Resumo do Bloco 2 
Sete variáveis com tipo, uso e comportamento de fallback definidos. Formulário tratado 
como ponto de partida validado pela conversa, com atualização do banco quando a 
realidade do lead diverge do preenchido. Segmentos não mapeados não bloqueiam o fluxo, 
são identificados conversacionalmente e registrados. Payload estruturado com 
aprendizados contextuais injetados por segmento e etapa. Hierarquia de prioridade em 
cinco níveis resolve conflitos entre banco e conversa sem ambiguidade.
