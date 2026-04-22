import { useMemo, useState, type FormEvent } from 'react'

interface DiagnosticoFormProps {
  apiBase: string
  workflow?: string
}

interface OptionItem {
  value: string
  label: string
}

interface FormValues {
  nomeCompleto: string
  whatsapp: string
  segmentoDescricao: string
  faturamentoMensal: string
  equipeFaixa: string
  ferramentas: string[]
  ferramentaOutra: string
  tentativaAnterior: string
  mudancaOperacao: string
  descricaoOperacao: string
  urgencia: string
  maiorDesafio: string
  motivacao: string
  expectativa: string
}

const FATURAMENTO_OPTIONS: OptionItem[] = [
  { value: 'ate_5', label: 'Ate R$ 5 mil' },
  { value: '5_20', label: 'De R$ 5 mil a R$ 20 mil' },
  { value: '20_50', label: 'De R$ 20 mil a R$ 50 mil' },
  { value: '50_150', label: 'De R$ 50 mil a R$ 150 mil' },
  { value: '150_500', label: 'De R$ 150 mil a R$ 500 mil' },
  { value: 'acima_500', label: 'Acima de R$ 500 mil' },
]

const EQUIPE_OPTIONS: OptionItem[] = [
  { value: 'solo', label: 'So eu' },
  { value: '2_5', label: '2 a 5 pessoas' },
  { value: '6_15', label: '6 a 15 pessoas' },
  { value: '16_30', label: '16 a 30 pessoas' },
  { value: '31_plus', label: 'Mais de 30 pessoas' },
]

const TENTATIVA_OPTIONS: OptionItem[] = [
  { value: 'sim_bom', label: 'Sim, e funcionou bem' },
  { value: 'sim_sem_resultado', label: 'Sim, mas nao teve o resultado esperado' },
  { value: 'tentamos_abandonamos', label: 'Tentamos mas abandonamos no meio do processo' },
  { value: 'nunca', label: 'Nunca tentamos' },
]

const URGENCIA_OPTIONS: OptionItem[] = [
  {
    value: 'agora',
    label: 'Preciso resolver agora, esta impactando o negocio diretamente',
  },
  { value: '3_meses', label: 'Nos proximos 3 meses' },
  { value: 'avaliando', label: 'Estou pesquisando e avaliando opcoes' },
  { value: 'sem_certeza', label: 'Ainda nao tenho certeza' },
]

const FERRAMENTA_OPTIONS = [
  'CRM',
  'WhatsApp Business',
  'Planilhas',
  'ERP',
  'Ferramenta de automacao (n8n, Make, Zapier)',
  'Ferramenta de gestao de projetos (Trello, Asana, Monday)',
  'Nenhuma ferramenta estruturada',
  'Outra',
]

const INITIAL_VALUES: FormValues = {
  nomeCompleto: '',
  whatsapp: '',
  segmentoDescricao: '',
  faturamentoMensal: '',
  equipeFaixa: '',
  ferramentas: [],
  ferramentaOutra: '',
  tentativaAnterior: '',
  mudancaOperacao: '',
  descricaoOperacao: '',
  urgencia: '',
  maiorDesafio: '',
  motivacao: '',
  expectativa: '',
}

function normalizePhoneE164(rawValue: string) {
  const digitsOnly = String(rawValue || '').replace(/[^\d]/g, '')
  if (!digitsOnly) return ''

  let digits = digitsOnly
  if (digits.startsWith('0')) {
    digits = digits.replace(/^0+/, '')
  }

  if (!digits.startsWith('55')) {
    digits = `55${digits}`
  }

  if (digits.length < 12 || digits.length > 13) {
    return ''
  }

  return `+${digits}`
}

function formatPhoneInput(rawValue: string) {
  const digits = String(rawValue || '').replace(/[^\d]/g, '').slice(0, 13)
  if (!digits) return ''

  const local = digits.startsWith('55') ? digits.slice(2) : digits
  const ddd = local.slice(0, 2)
  const partA = local.length > 10 ? local.slice(2, 7) : local.slice(2, 6)
  const partB = local.length > 10 ? local.slice(7, 11) : local.slice(6, 10)
  let output = ''
  if (ddd) output += `(${ddd}`
  if (ddd.length === 2) output += ') '
  if (partA) output += partA
  if (partB) output += `-${partB}`
  return output.trim()
}

function equipeFaixaToNumber(value: string) {
  const map: Record<string, number> = {
    solo: 1,
    '2_5': 4,
    '6_15': 10,
    '16_30': 22,
    '31_plus': 35,
  }
  return map[value] || null
}

function inferSegmentoEnum(rawSegmento: string) {
  const normalized = String(rawSegmento || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  if (!normalized) return 'outro'

  if (normalized.includes('dent')) return 'dentista'
  if (normalized.includes('nutri')) return 'nutricionista'
  if (normalized.includes('fisio')) return 'fisioterapeuta'
  if (normalized.includes('dermato')) return 'dermatologista'
  if (normalized.includes('ortoped')) return 'ortopedista'
  if (normalized.includes('barbear')) return 'barbearia'
  if (normalized.includes('estetic')) return 'estetica'
  if (normalized.includes('corret') || normalized.includes('imob')) return 'corretor'
  if (normalized.includes('restaur') || normalized.includes('lanchonete') || normalized.includes('pizzaria')) return 'restaurante'
  return 'outro'
}

function toPayloadValue(optionList: OptionItem[], selectedValue: string) {
  return optionList.find((item) => item.value === selectedValue)?.label || selectedValue
}

export function DiagnosticoForm({ apiBase, workflow = 'smg' }: DiagnosticoFormProps) {
  const [step, setStep] = useState(1)
  const [values, setValues] = useState<FormValues>(INITIAL_VALUES)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitSuccess, setSubmitSuccess] = useState('')

  const progressPercent = step === 1 ? 33 : step === 2 ? 67 : 100

  const stepTitle = useMemo(() => {
    if (step === 1) return 'Primeiro, nos conte um pouco sobre voce e sua empresa.'
    if (step === 2) return 'Agora queremos entender como sua operacao funciona hoje.'
    return 'Por fim, queremos entender o momento que voce esta vivendo.'
  }, [step])

  const ferramentaOptionsWithState = useMemo(
    () =>
      FERRAMENTA_OPTIONS.map((label) => ({
        label,
        selected: values.ferramentas.includes(label),
      })),
    [values.ferramentas]
  )

  function updateField<K extends keyof FormValues>(field: K, value: FormValues[K]) {
    setValues((current) => ({
      ...current,
      [field]: value,
    }))
    setErrors((current) => {
      if (!current[field]) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  function toggleFerramenta(label: string) {
    setValues((current) => {
      const selected = current.ferramentas.includes(label)
      if (selected) {
        return {
          ...current,
          ferramentas: current.ferramentas.filter((item) => item !== label),
          ...(label === 'Outra' ? { ferramentaOutra: '' } : {}),
        }
      }

      if (label === 'Nenhuma ferramenta estruturada') {
        return {
          ...current,
          ferramentas: [label],
          ferramentaOutra: '',
        }
      }

      const base = current.ferramentas.filter((item) => item !== 'Nenhuma ferramenta estruturada')
      return {
        ...current,
        ferramentas: [...base, label],
      }
    })
    setErrors((current) => {
      const next = { ...current }
      delete next.ferramentas
      delete next.ferramentaOutra
      return next
    })
  }

  function validateStep(currentStep: number) {
    const nextErrors: Record<string, string> = {}
    if (currentStep === 1) {
      if (!values.nomeCompleto.trim()) nextErrors.nomeCompleto = 'Informe seu nome completo.'
      if (!values.whatsapp.trim()) nextErrors.whatsapp = 'Informe seu WhatsApp.'
      if (!normalizePhoneE164(values.whatsapp)) nextErrors.whatsapp = 'Informe um WhatsApp valido com DDD.'
      if (!values.segmentoDescricao.trim()) nextErrors.segmentoDescricao = 'Descreva seu segmento.'
      if (!values.faturamentoMensal) nextErrors.faturamentoMensal = 'Selecione o faturamento.'
      if (!values.equipeFaixa) nextErrors.equipeFaixa = 'Selecione o tamanho da equipe.'
    }

    if (currentStep === 2) {
      if (values.ferramentas.length === 0) nextErrors.ferramentas = 'Selecione ao menos uma ferramenta.'
      if (values.ferramentas.includes('Outra') && !values.ferramentaOutra.trim()) {
        nextErrors.ferramentaOutra = 'Descreva a ferramenta "Outra".'
      }
      if (!values.tentativaAnterior) nextErrors.tentativaAnterior = 'Selecione uma opcao.'
      if (!values.mudancaOperacao.trim()) nextErrors.mudancaOperacao = 'Descreva o que voce mudaria.'
      if (!values.descricaoOperacao.trim()) nextErrors.descricaoOperacao = 'Descreva sua operacao atual.'
    }

    if (currentStep === 3) {
      if (!values.urgencia) nextErrors.urgencia = 'Selecione a urgencia.'
      if (!values.maiorDesafio.trim()) nextErrors.maiorDesafio = 'Informe o maior desafio.'
      if (!values.motivacao.trim()) nextErrors.motivacao = 'Informe o que motivou sua busca.'
      if (!values.expectativa.trim()) nextErrors.expectativa = 'Informe sua expectativa.'
    }

    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  function handleStepNext() {
    if (!validateStep(step)) return
    setStep((current) => Math.min(3, current + 1))
  }

  function handleStepBack() {
    setErrors({})
    setStep((current) => Math.max(1, current - 1))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitError('')
    setSubmitSuccess('')

    const validCurrent = validateStep(3)
    if (!validCurrent) return

    const normalizedPhone = normalizePhoneE164(values.whatsapp)
    if (!normalizedPhone) {
      setErrors((current) => ({
        ...current,
        whatsapp: 'Informe um WhatsApp valido com DDD.',
      }))
      setStep(1)
      return
    }

    const ferramentaExtra = values.ferramentas.includes('Outra') && values.ferramentaOutra.trim()
      ? [`Outra: ${values.ferramentaOutra.trim()}`]
      : []
    const ferramentasText = [...values.ferramentas.filter((item) => item !== 'Outra'), ...ferramentaExtra].join(', ')

    const payload = {
      workflow,
      phoneNumber: normalizedPhone,
      form: {
        nome: values.nomeCompleto.trim(),
        segmento: inferSegmentoEnum(values.segmentoDescricao),
        segmentoDescricao: values.segmentoDescricao.trim(),
        faturamentoMensal: toPayloadValue(FATURAMENTO_OPTIONS, values.faturamentoMensal),
        numFuncionarios: equipeFaixaToNumber(values.equipeFaixa),
        equipeFaixa: toPayloadValue(EQUIPE_OPTIONS, values.equipeFaixa),
        ferramentas: ferramentasText,
        tentativaAnterior: toPayloadValue(TENTATIVA_OPTIONS, values.tentativaAnterior),
        mudancaOperacao: values.mudancaOperacao.trim(),
        descricaoOperacao: values.descricaoOperacao.trim(),
        urgencia: toPayloadValue(URGENCIA_OPTIONS, values.urgencia),
        maiorDesafio: values.maiorDesafio.trim(),
        motivacao: values.motivacao.trim(),
        expectativa: values.expectativa.trim(),
      },
      lead: {
        nome: values.nomeCompleto.trim(),
        agentSlug: 'default-sdr',
        pipelineOrigin: 'diagnostico_site',
        canalAquisicao: 'inbound_site',
      },
    }

    try {
      setIsSubmitting(true)
      const response = await fetch(`${apiBase}/wf2/forms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await response.json()
      if (!response.ok || json?.success === false) {
        throw new Error(json?.error || 'Nao foi possivel enviar o formulario.')
      }

      const tokenText = String(json?.data?.token || '').trim()
      setSubmitSuccess(
        tokenText
          ? `Formulario enviado com sucesso. Protocolo: ${tokenText}.`
          : 'Formulario enviado com sucesso.'
      )
      setValues(INITIAL_VALUES)
      setStep(1)
      setErrors({})
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Falha ao enviar formulario.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="diag-page">
      <section className="diag-card">
        <header className="diag-header">
          <div className="diag-progress-top">
            <span>{`Etapa ${step} de 3`}</span>
            <span>{`${progressPercent}%`}</span>
          </div>
          <div className="diag-progress-track">
            <div className="diag-progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <h1>{stepTitle}</h1>
        </header>

        <form className="diag-form" onSubmit={handleSubmit} noValidate>
          {step === 1 ? (
            <>
              <label className="diag-field">
                <span>Nome completo *</span>
                <input
                  value={values.nomeCompleto}
                  onChange={(event) => updateField('nomeCompleto', event.target.value)}
                  placeholder="Seu nome"
                />
                {errors.nomeCompleto ? <small>{errors.nomeCompleto}</small> : null}
              </label>

              <label className="diag-field">
                <span>WhatsApp *</span>
                <input
                  value={values.whatsapp}
                  onChange={(event) => updateField('whatsapp', formatPhoneInput(event.target.value))}
                  placeholder="(11) 99999-9999"
                />
                {errors.whatsapp ? <small>{errors.whatsapp}</small> : null}
              </label>

              <label className="diag-field">
                <span>Qual e o segmento da sua empresa e como ela atua? *</span>
                <textarea
                  rows={4}
                  value={values.segmentoDescricao}
                  onChange={(event) => updateField('segmentoDescricao', event.target.value)}
                  placeholder="Descreva seu segmento e operacao"
                />
                {errors.segmentoDescricao ? <small>{errors.segmentoDescricao}</small> : null}
              </label>

              <label className="diag-field">
                <span>Qual e o faturamento mensal aproximado da sua empresa? *</span>
                <select
                  value={values.faturamentoMensal}
                  onChange={(event) => updateField('faturamentoMensal', event.target.value)}
                >
                  <option value="">Selecione</option>
                  {FATURAMENTO_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                {errors.faturamentoMensal ? <small>{errors.faturamentoMensal}</small> : null}
              </label>

              <label className="diag-field">
                <span>Quantas pessoas trabalham na sua empresa hoje? *</span>
                <select
                  value={values.equipeFaixa}
                  onChange={(event) => updateField('equipeFaixa', event.target.value)}
                >
                  <option value="">Selecione</option>
                  {EQUIPE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                {errors.equipeFaixa ? <small>{errors.equipeFaixa}</small> : null}
              </label>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <fieldset className="diag-fieldset">
                <legend>Quais ferramentas sua empresa usa atualmente? *</legend>
                <div className="diag-chip-grid">
                  {ferramentaOptionsWithState.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className={item.selected ? 'diag-chip is-selected' : 'diag-chip'}
                      onClick={() => toggleFerramenta(item.label)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {errors.ferramentas ? <small>{errors.ferramentas}</small> : null}
              </fieldset>

              {values.ferramentas.includes('Outra') ? (
                <label className="diag-field">
                  <span>Qual outra ferramenta voce usa? *</span>
                  <input
                    value={values.ferramentaOutra}
                    onChange={(event) => updateField('ferramentaOutra', event.target.value)}
                    placeholder="Exemplo: sistema interno"
                  />
                  {errors.ferramentaOutra ? <small>{errors.ferramentaOutra}</small> : null}
                </label>
              ) : null}

              <label className="diag-field">
                <span>Sua empresa ja tentou implementar alguma solucao de automacao ou sistema antes? *</span>
                <select
                  value={values.tentativaAnterior}
                  onChange={(event) => updateField('tentativaAnterior', event.target.value)}
                >
                  <option value="">Selecione</option>
                  {TENTATIVA_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                {errors.tentativaAnterior ? <small>{errors.tentativaAnterior}</small> : null}
              </label>

              <label className="diag-field">
                <span>Se voce pudesse mudar uma coisa na sua operacao hoje, o que seria? *</span>
                <textarea
                  rows={4}
                  value={values.mudancaOperacao}
                  onChange={(event) => updateField('mudancaOperacao', event.target.value)}
                  placeholder="Descreva"
                />
                {errors.mudancaOperacao ? <small>{errors.mudancaOperacao}</small> : null}
              </label>

              <label className="diag-field">
                <span>Como voce descreveria o funcionamento da sua operacao hoje? O que funciona bem e o que nao funciona? *</span>
                <textarea
                  rows={4}
                  value={values.descricaoOperacao}
                  onChange={(event) => updateField('descricaoOperacao', event.target.value)}
                  placeholder="Descreva"
                />
                {errors.descricaoOperacao ? <small>{errors.descricaoOperacao}</small> : null}
              </label>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <label className="diag-field">
                <span>Qual e a urgencia para resolver esse problema? *</span>
                <select value={values.urgencia} onChange={(event) => updateField('urgencia', event.target.value)}>
                  <option value="">Selecione</option>
                  {URGENCIA_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                {errors.urgencia ? <small>{errors.urgencia}</small> : null}
              </label>

              <label className="diag-field">
                <span>Qual e o maior desafio da sua empresa hoje? *</span>
                <textarea
                  rows={4}
                  value={values.maiorDesafio}
                  onChange={(event) => updateField('maiorDesafio', event.target.value)}
                />
                {errors.maiorDesafio ? <small>{errors.maiorDesafio}</small> : null}
              </label>

              <label className="diag-field">
                <span>O que te motivou a buscar uma solucao agora? *</span>
                <textarea
                  rows={4}
                  value={values.motivacao}
                  onChange={(event) => updateField('motivacao', event.target.value)}
                />
                {errors.motivacao ? <small>{errors.motivacao}</small> : null}
              </label>

              <label className="diag-field">
                <span>O que voce espera que mude no seu negocio apos estruturar a operacao? *</span>
                <textarea
                  rows={4}
                  value={values.expectativa}
                  onChange={(event) => updateField('expectativa', event.target.value)}
                />
                {errors.expectativa ? <small>{errors.expectativa}</small> : null}
              </label>
            </>
          ) : null}

          {submitError ? <p className="diag-banner diag-error">{submitError}</p> : null}
          {submitSuccess ? <p className="diag-banner diag-success">{submitSuccess}</p> : null}

          <footer className="diag-actions">
            {step > 1 ? (
              <button type="button" className="diag-btn is-secondary" onClick={handleStepBack}>
                Voltar
              </button>
            ) : (
              <span />
            )}

            {step < 3 ? (
              <button type="button" className="diag-btn is-primary" onClick={handleStepNext}>
                Continuar
              </button>
            ) : (
              <button type="submit" className="diag-btn is-primary" disabled={isSubmitting}>
                {isSubmitting ? 'Enviando...' : 'Enviar formulario'}
              </button>
            )}
          </footer>
        </form>
      </section>
    </main>
  )
}

