import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ExecutionFlow, type ExecutionEvent } from './components/ExecutionFlow'

const API_BASE = (import.meta.env.VITE_SMG_API_URL || 'http://localhost:3344/api').replace(/\/$/, '')

type TabKey = 'overview' | 'agents' | 'conversations' | 'executions' | 'scraping' | 'forms' | 'config'
type WorkflowKey = 'smg' | 'bsb'

const NAV_ITEMS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'overview', label: 'Visão geral', hint: 'Resumo rápido do painel' },
  { key: 'agents', label: 'Agentes', hint: 'Catálogo e status dos agentes' },
  { key: 'conversations', label: 'Conversas', hint: 'Histórico por lead e telefone' },
  { key: 'executions', label: 'Execuções IA', hint: 'Fluxos e eventos por rodada' },
  { key: 'scraping', label: 'Scraps e leads', hint: 'SMG/BSB no dia selecionado' },
  { key: 'forms', label: 'Formulários', hint: 'Respostas recebidas via diagnóstico' },
  { key: 'config', label: 'Config', hint: 'Parâmetros técnicos do agente' },
]

const WORKFLOW_OPTIONS: Array<{ value: WorkflowKey; label: string }> = [
  { value: 'smg', label: 'SMG' },
  { value: 'bsb', label: 'BSB' },
]

interface AgentProvider {
  provider: string
  configured: boolean
  credentials: Record<string, unknown>
}

interface AgentSummary {
  slug: string
  name: string
  description: string
  workflow: string
  defaultProvider: string
  webhooks: {
    meta?: string
    uazapi?: string
  }
  ai: {
    enabled: boolean
    useLangChain: boolean
    model: string
    bufferSeconds: number
    historyLimit: number
    apiKeyConfigured: boolean
    apiKeySource: string
  }
  wf2: {
    enabled: boolean
    formLink: string | null
  }
  providers: AgentProvider[]
}

interface ConversationSummary {
  conversationKey: string
  provider: string
  phoneNumber: string
  aiPaused: boolean
  pausedReason: string | null
  lastMessageAt: string | null
  totalMessages: number
  preview: {
    human: string | null
    ai: string | null
  }
  lead: {
    id: string
    nome: string
    empresa: string
    status: string
  } | null
}

interface ConversationMessage {
  id: string
  role: 'human' | 'ai'
  content: string
  createdAt: string
}

interface ConversationSimulationResult {
  workflow: string
  agentSlug: string
  generated: number
  turns: number
  warnings: string[]
  items: Array<{
    conversationKey: string
    phoneNumber: string
    scenario: string
    totalMessages: number
    lastMessageAt: string
  }>
}

interface ExecutionRunSummary {
  id: string
  provider: string | null
  conversationKey: string | null
  phoneNumber: string | null
  triggerSource: string
  status: string
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
  totalEvents: number
}

interface ExecutionRunDetail {
  id: string
  status: string
  triggerSource: string
  errorMessage: string | null
  events: ExecutionEvent[]
  inputPayload: Record<string, unknown> | null
  outputPayload: Record<string, unknown> | null
}

interface ScrapeExecutionSummary {
  id: string
  queueJobId: string | null
  startedAt: string
  finishedAt: string | null
  status: string
  totalCollected: number
  totalApproved: number
  totalDiscarded: number
  errorMessage: string | null
  details: Record<string, unknown> | null
}

interface WorkflowLeadSummary {
  id: string
  nome: string
  telefone: string | null
  empresa: string
  segmento: string
  status: string
  canalAquisicao: string
  pipelineOrigin: string
  criadoEm: string
  fonteOrigem: string
}

interface FormLinkedLeadSummary {
  id: string
  nome: string | null
  telefone: string | null
  empresa: string | null
  status: string | null
  pipelineOrigin: string | null
  canalAquisicao: string | null
  diagnosticoFormularioId: string | null
}

interface WorkflowFormSummary {
  id: string
  workflow: string
  token: string | null
  telefone: string | null
  segmento: string | null
  faturamentoMensal: string | null
  numFuncionarios: string | null
  ferramentas: unknown
  tentativaAnterior: string | null
  mudancaOperacao: string | null
  descricaoOperacao: string | null
  urgencia: string | null
  maiorDesafio: string | null
  motivacao: string | null
  expectativa: string | null
  rawData: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  lead: FormLinkedLeadSummary | null
}

interface DayRange {
  startMs: number
  endMs: number
}

interface AgentSetupField {
  id: string
  section: string
  label: string
  type: 'text' | 'password' | 'url' | 'boolean'
  required: boolean
  configured: boolean
  source: 'agent' | 'global' | 'none'
  value: string
  hasSecretValue: boolean
  envKey: string
}

interface AgentSetupData {
  agentSlug: string
  mode: {
    outboundMessagesEnabled: boolean
    wf2OutboundStartEnabled: boolean
  }
  summary: {
    total: number
    required: number
    missingRequired: number
  }
  fields: AgentSetupField[]
  missing: AgentSetupField[]
}

interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
}

const SETUP_SECTION_LABELS: Record<string, string> = {
  runtime: 'Runtime',
  ai: 'IA',
  wf2: 'WF2',
  meta: 'Meta',
  uazapi: 'Uazapi',
}

async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const payload = await response.json()
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || `Falha ao carregar ${path}`)
  }
  return payload.data as T
}

function trimPreview(text: string | null, max = 80) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value) return '-'
  if (value.length <= max) return value
  return `${value.slice(0, max)}...`
}

function formatDateTime(value: string | null) {
  if (!value) return '-'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '-'
  return parsed.toLocaleString('pt-BR')
}

function getTodayDateInputValue() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildDayRange(dateInput: string): DayRange | null {
  if (!dateInput) return null

  const parts = dateInput.split('-').map((chunk) => Number(chunk))
  if (parts.length !== 3 || parts.some((value) => Number.isNaN(value) || value <= 0)) {
    return null
  }

  const [year, month, day] = parts
  const start = new Date(year, month - 1, day, 0, 0, 0, 0)
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0)
  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
  }
}

function isDateInsideRange(value: string | null, range: DayRange | null) {
  if (!range) return true
  if (!value) return false
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return false
  return timestamp >= range.startMs && timestamp < range.endMs
}

export default function App() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [selectedAgentSlug, setSelectedAgentSlug] = useState('')
  const [selectedTab, setSelectedTab] = useState<TabKey>('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [selectedConversationKey, setSelectedConversationKey] = useState('')
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [simulationRunning, setSimulationRunning] = useState(false)
  const [simulationMessage, setSimulationMessage] = useState('')
  const [simulationError, setSimulationError] = useState('')

  const [runs, setRuns] = useState<ExecutionRunSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [runDetail, setRunDetail] = useState<ExecutionRunDetail | null>(null)

  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowKey>('smg')
  const [selectedDate, setSelectedDate] = useState('')
  const [workflowExecutions, setWorkflowExecutions] = useState<ScrapeExecutionSummary[]>([])
  const [workflowLeads, setWorkflowLeads] = useState<WorkflowLeadSummary[]>([])
  const [workflowForms, setWorkflowForms] = useState<WorkflowFormSummary[]>([])
  const [selectedFormId, setSelectedFormId] = useState('')
  const [formsLoading, setFormsLoading] = useState(false)
  const [formsError, setFormsError] = useState('')
  const [formsSearchInput, setFormsSearchInput] = useState('')
  const [formsSearchQuery, setFormsSearchQuery] = useState('')
  const [formsRefreshToken, setFormsRefreshToken] = useState(0)
  const [scrapeLoading, setScrapeLoading] = useState(false)
  const [scrapeError, setScrapeError] = useState('')
  const [scrapeRefreshToken, setScrapeRefreshToken] = useState(0)

  const [agentSetup, setAgentSetup] = useState<AgentSetupData | null>(null)
  const [setupFormValues, setSetupFormValues] = useState<Record<string, string>>({})
  const [setupLoading, setSetupLoading] = useState(false)
  const [setupSaving, setSetupSaving] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [setupMessage, setSetupMessage] = useState('')

  const selectedAgent = useMemo(
    () => agents.find((item) => item.slug === selectedAgentSlug) || null,
    [agents, selectedAgentSlug]
  )
  const selectedNavItem = useMemo(
    () => NAV_ITEMS.find((item) => item.key === selectedTab) || NAV_ITEMS[0],
    [selectedTab]
  )
  const totalAiEnabled = useMemo(() => agents.filter((agent) => agent.ai.enabled).length, [agents])
  const totalConfiguredProviders = useMemo(
    () => agents.reduce((acc, agent) => acc + agent.providers.filter((provider) => provider.configured).length, 0),
    [agents]
  )

  const selectedDayRange = useMemo(() => buildDayRange(selectedDate), [selectedDate])
  const hasDateFilter = Boolean(selectedDate)
  const selectedForm = useMemo(
    () => workflowForms.find((item) => item.id === selectedFormId) || null,
    [workflowForms, selectedFormId]
  )

  const executionsOfDay = useMemo(
    () => workflowExecutions.filter((execution) => isDateInsideRange(execution.startedAt, selectedDayRange)),
    [workflowExecutions, selectedDayRange]
  )

  const leadsOfDay = useMemo(
    () => workflowLeads.filter((lead) => isDateInsideRange(lead.criadoEm, selectedDayRange)),
    [workflowLeads, selectedDayRange]
  )

  const executionTotals = useMemo(
    () =>
      executionsOfDay.reduce(
        (acc, execution) => {
          acc.collected += Number(execution.totalCollected || 0)
          acc.approved += Number(execution.totalApproved || 0)
          acc.discarded += Number(execution.totalDiscarded || 0)
          return acc
        },
        { collected: 0, approved: 0, discarded: 0 }
      ),
    [executionsOfDay]
  )

  const setupFieldsBySection = useMemo(() => {
    const map = new Map<string, AgentSetupField[]>()
    for (const field of agentSetup?.fields || []) {
      const list = map.get(field.section) || []
      list.push(field)
      map.set(field.section, list)
    }
    return [...map.entries()]
  }, [agentSetup])

  const loadConversationsForAgent = async (agentSlugInput: string) => {
    if (!agentSlugInput) return
    try {
      const data = await apiRequest<{ items: ConversationSummary[] }>(`/agents/${agentSlugInput}/conversations?limit=40`)
      const items = data.items || []
      setConversations(items)
      setSelectedConversationKey((current) => {
        if (!current) return items[0]?.conversationKey || ''
        return items.some((item) => item.conversationKey === current) ? current : items[0]?.conversationKey || ''
      })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Erro ao carregar conversas')
    }
  }

  const loadRunsForAgent = async (agentSlugInput: string) => {
    if (!agentSlugInput) return
    try {
      const data = await apiRequest<{ items: ExecutionRunSummary[] }>(`/agents/${agentSlugInput}/executions?limit=50`)
      const items = data.items || []
      setRuns(items)
      setSelectedRunId((current) => {
        if (!current) return items[0]?.id || ''
        return items.some((item) => item.id === current) ? current : items[0]?.id || ''
      })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Erro ao carregar execucoes')
    }
  }

  useEffect(() => {
    const loadAgents = async () => {
      setLoading(true)
      setError('')
      try {
        const data = await apiRequest<AgentSummary[]>('/agents')
        setAgents(data)
        if (data.length) {
          setSelectedAgentSlug((current) => current || data[0].slug)
        }
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Erro ao carregar agentes')
      } finally {
        setLoading(false)
      }
    }
    loadAgents()
  }, [])

  useEffect(() => {
    if (!selectedAgentSlug) return

    setSimulationMessage('')
    setSimulationError('')
    loadConversationsForAgent(selectedAgentSlug)
    loadRunsForAgent(selectedAgentSlug)
  }, [selectedAgentSlug])

  useEffect(() => {
    if (!selectedAgentSlug) {
      setAgentSetup(null)
      setSetupFormValues({})
      return
    }

    let isCancelled = false

    const loadAgentSetup = async () => {
      setSetupLoading(true)
      setSetupError('')
      try {
        const data = await apiRequest<AgentSetupData>(`/agents/${selectedAgentSlug}/setup`)
        if (isCancelled) return
        setAgentSetup(data)
        const initialValues: Record<string, string> = {}
        for (const field of data.fields || []) {
          initialValues[field.id] = field.type === 'boolean' ? String(field.value || 'false') : String(field.value || '')
        }
        setSetupFormValues(initialValues)
      } catch (requestError) {
        if (isCancelled) return
        setSetupError(requestError instanceof Error ? requestError.message : 'Erro ao carregar setup do agente')
      } finally {
        if (!isCancelled) {
          setSetupLoading(false)
        }
      }
    }

    loadAgentSetup()

    return () => {
      isCancelled = true
    }
  }, [selectedAgentSlug])

  useEffect(() => {
    if (!selectedAgentSlug || !selectedConversationKey) {
      setMessages([])
      return
    }

    const loadMessages = async () => {
      try {
        const encoded = encodeURIComponent(selectedConversationKey)
        const data = await apiRequest<{ messages: ConversationMessage[] }>(
          `/agents/${selectedAgentSlug}/conversations/${encoded}/messages?limit=200`
        )
        setMessages(data.messages || [])
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Erro ao carregar mensagens')
      }
    }

    loadMessages()
  }, [selectedAgentSlug, selectedConversationKey])

  useEffect(() => {
    if (!selectedAgentSlug || !selectedRunId) {
      setRunDetail(null)
      return
    }

    const loadRunDetail = async () => {
      try {
        const data = await apiRequest<ExecutionRunDetail>(`/agents/${selectedAgentSlug}/executions/${selectedRunId}`)
        setRunDetail(data)
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Erro ao carregar detalhes da execução')
      }
    }

    loadRunDetail()
  }, [selectedAgentSlug, selectedRunId])

  useEffect(() => {
    if (selectedTab !== 'scraping') return

    let isCancelled = false

    const loadWorkflowDashboard = async () => {
      setScrapeLoading(true)
      setScrapeError('')
      try {
        const [executionsData, leadsData] = await Promise.all([
          apiRequest<ScrapeExecutionSummary[]>(`/scrape/executions?workflow=${selectedWorkflow}&limit=200`),
          apiRequest<WorkflowLeadSummary[]>(`/leads?workflow=${selectedWorkflow}&limit=500`),
        ])

        if (isCancelled) return
        setWorkflowExecutions(executionsData || [])
        setWorkflowLeads(leadsData || [])
      } catch (requestError) {
        if (isCancelled) return
        setScrapeError(requestError instanceof Error ? requestError.message : 'Erro ao carregar scraps e leads')
      } finally {
        if (!isCancelled) {
          setScrapeLoading(false)
        }
      }
    }

    loadWorkflowDashboard()

    return () => {
      isCancelled = true
    }
  }, [selectedTab, selectedWorkflow, scrapeRefreshToken])

  useEffect(() => {
    if (selectedTab !== 'forms') return

    let isCancelled = false

    const loadFormsDashboard = async () => {
      setFormsLoading(true)
      setFormsError('')
      try {
        const encodedQuery = encodeURIComponent(formsSearchQuery)
        const response = await apiRequest<WorkflowFormSummary[]>(
          `/wf2/forms?workflow=${selectedWorkflow}&limit=200&q=${encodedQuery}`
        )

        if (isCancelled) return
        const items = response || []
        setWorkflowForms(items)
        setSelectedFormId((current) => {
          if (!items.length) return ''
          if (current && items.some((item) => item.id === current)) return current
          return items[0].id
        })
      } catch (requestError) {
        if (isCancelled) return
        setWorkflowForms([])
        setSelectedFormId('')
        setFormsError(requestError instanceof Error ? requestError.message : 'Erro ao carregar respostas de formulário')
      } finally {
        if (!isCancelled) {
          setFormsLoading(false)
        }
      }
    }

    loadFormsDashboard()

    return () => {
      isCancelled = true
    }
  }, [selectedTab, selectedWorkflow, formsSearchQuery, formsRefreshToken])

  const reloadAgentSetup = async () => {
    if (!selectedAgentSlug) return
    setSetupLoading(true)
    setSetupError('')
    try {
      const data = await apiRequest<AgentSetupData>(`/agents/${selectedAgentSlug}/setup`)
      setAgentSetup(data)
      const initialValues: Record<string, string> = {}
      for (const field of data.fields || []) {
        initialValues[field.id] = field.type === 'boolean' ? String(field.value || 'false') : String(field.value || '')
      }
      setSetupFormValues(initialValues)
    } catch (requestError) {
      setSetupError(requestError instanceof Error ? requestError.message : 'Erro ao recarregar setup')
    } finally {
      setSetupLoading(false)
    }
  }

  const handleSetupFieldChange = (fieldId: string, value: string) => {
    setSetupFormValues((current) => ({
      ...current,
      [fieldId]: value,
    }))
  }

  const handleSetupSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedAgentSlug || !agentSetup) return

    setSetupSaving(true)
    setSetupError('')
    setSetupMessage('')

    try {
      const valuesToSave: Record<string, string> = {}
      for (const field of agentSetup.fields) {
        const currentValue = setupFormValues[field.id]
        if (field.type === 'password') {
          const trimmed = String(currentValue || '').trim()
          if (trimmed) {
            valuesToSave[field.id] = trimmed
          }
          continue
        }
        valuesToSave[field.id] = String(currentValue || '')
      }

      const data = await apiRequest<{ setup: AgentSetupData; agent: AgentSummary }>(`/agents/${selectedAgentSlug}/setup`, {
        method: 'PATCH',
        body: {
          values: valuesToSave,
        },
      })

      setAgentSetup(data.setup)
      setAgents((current) =>
        current.map((agent) => {
          if (agent.slug !== data.agent.slug) return agent
          return data.agent
        })
      )

      const nextValues: Record<string, string> = {}
      for (const field of data.setup.fields) {
        if (field.type === 'password') {
          nextValues[field.id] = ''
          continue
        }
        nextValues[field.id] = String(field.value || '')
      }
      setSetupFormValues(nextValues)
      setSetupMessage('Configurações salvas com sucesso. Se necessário, reinicie o backend para refletir em todos os módulos.')
    } catch (requestError) {
      setSetupError(requestError instanceof Error ? requestError.message : 'Erro ao salvar configurações do agente')
    } finally {
      setSetupSaving(false)
    }
  }

  const handleRunConversationSimulation = async () => {
    if (!selectedAgentSlug) return
    setSimulationRunning(true)
    setSimulationMessage('')
    setSimulationError('')
    try {
      const data = await apiRequest<ConversationSimulationResult>(`/agents/${selectedAgentSlug}/conversations/simulate`, {
        method: 'POST',
        body: {
          count: 10,
          turns: 3,
        },
      })
      await loadConversationsForAgent(selectedAgentSlug)
      setSimulationMessage(
        `Simulacao concluida: ${data.generated} conversas (${data.turns} turnos por conversa) foram adicionadas.`
      )
      if (data.warnings?.length) {
        setSimulationError(data.warnings.join(' '))
      }
    } catch (requestError) {
      setSimulationError(requestError instanceof Error ? requestError.message : 'Erro ao rodar simulacao de conversas')
    } finally {
      setSimulationRunning(false)
    }
  }

  const handleFormsSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormsSearchQuery(formsSearchInput.trim())
  }

  const requiresAgent = selectedTab === 'conversations' || selectedTab === 'executions' || selectedTab === 'config'

  if (loading) {
    return <div className="screen-center">Carregando painel SMG...</div>
  }

  return (
    <div className="app-shell">
      <aside className="nav-sidebar">
        <div className="brand-panel">
          <p className="brand-kicker">SMG Console</p>
          <h1 className="title">Central de Operação</h1>
          <p className="muted">Base API: {API_BASE}</p>
        </div>

        <nav className="menu-group">
          <div className="section-title">Menus</div>
          <div className="menu-list">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={selectedTab === item.key ? 'nav-item active' : 'nav-item'}
                onClick={() => setSelectedTab(item.key)}
              >
                <div className="nav-item-title">{item.label}</div>
                <div className="nav-item-hint">{item.hint}</div>
              </button>
            ))}
          </div>
        </nav>

        <div className="sidebar-summary">
          <div className="section-title">Resumo</div>
          <div className="sidebar-pill">Agentes: {agents.length}</div>
          <div className="sidebar-pill">IA ativa: {totalAiEnabled}</div>
          <div className="sidebar-pill">Providers OK: {totalConfiguredProviders}</div>
        </div>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <div className="section-kicker">Painel lateral</div>
            <h2>{selectedNavItem.label}</h2>
            <p className="muted">{selectedNavItem.hint}</p>
          </div>
          <div className="agent-picker">
            <label htmlFor="active-agent">Agente ativo</label>
            <select
              id="active-agent"
              value={selectedAgentSlug}
              disabled={!agents.length}
              onChange={(event) => {
                setSelectedAgentSlug(event.target.value)
                setSelectedConversationKey('')
                setSelectedRunId('')
              }}
            >
              {agents.map((agent) => (
                <option key={agent.slug} value={agent.slug}>
                  {agent.name} ({agent.slug})
                </option>
              ))}
            </select>
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        {selectedTab === 'overview' ? (
          <div className="overview-layout">
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">Total de agentes</div>
                <div className="stat-value">{agents.length}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">IA habilitada</div>
                <div className="stat-value">{totalAiEnabled}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Conversas carregadas</div>
                <div className="stat-value">{conversations.length}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Execuções carregadas</div>
                <div className="stat-value">{runs.length}</div>
              </div>
            </div>

            <div className="panel-grid">
              <section className="panel-left">
                <h3>Agentes em destaque</h3>
                <div className="list-scroll">
                  {agents.map((agent) => (
                    <button
                      key={agent.slug}
                      type="button"
                      className={`list-item ${selectedAgentSlug === agent.slug ? 'is-active' : ''}`}
                      onClick={() => setSelectedAgentSlug(agent.slug)}
                    >
                      <div className="list-title">{agent.name}</div>
                      <div className="list-meta">slug: {agent.slug}</div>
                      <div className="list-meta">workflow: {agent.workflow}</div>
                      <div className="list-meta">IA: {agent.ai.enabled ? 'ativa' : 'desativada'}</div>
                    </button>
                  ))}
                </div>
              </section>
              <section className="panel-right">
                <h3>Resumo do agente selecionado</h3>
                {selectedAgent ? (
                  <div className="config-panel">
                    <section>
                      <h3>Identificação</h3>
                      <pre>{JSON.stringify({ slug: selectedAgent.slug, name: selectedAgent.name, workflow: selectedAgent.workflow }, null, 2)}</pre>
                    </section>
                    <section>
                      <h3>Webhooks</h3>
                      <pre>{JSON.stringify(selectedAgent.webhooks, null, 2)}</pre>
                    </section>
                    <section>
                      <h3>Última execução carregada</h3>
                      <pre>{JSON.stringify(runs[0] || {}, null, 2)}</pre>
                    </section>
                  </div>
                ) : (
                  <div className="panel-empty">Selecione um agente para ver o resumo.</div>
                )}
              </section>
            </div>
          </div>
        ) : null}

        {selectedTab === 'agents' ? (
          <div className="agents-layout">
            <section className="panel-right">
              <h3>Agentes ({agents.length})</h3>
              <div className="agents-grid">
                {agents.map((agent) => (
                  <button
                    key={agent.slug}
                    type="button"
                    className={`agent-card ${selectedAgentSlug === agent.slug ? 'is-active' : ''}`}
                    onClick={() => {
                      setSelectedAgentSlug(agent.slug)
                      setSelectedConversationKey('')
                      setSelectedRunId('')
                    }}
                  >
                    <div className="agent-name">{agent.name}</div>
                    <div className="agent-meta">slug: {agent.slug}</div>
                    <div className="agent-meta">workflow: {agent.workflow}</div>
                    <div className="agent-meta">IA: {agent.ai.enabled ? 'ativa' : 'desativada'}</div>
                  </button>
                ))}
              </div>
            </section>

            <section className="panel-right">
              <h3>Setup do agente selecionado</h3>
              {!selectedAgent ? <div className="panel-empty">Nenhum agente encontrado.</div> : null}

              {selectedAgent ? (
                <section className="webhook-panel">
                  <h4>Webhooks da IA</h4>
                  <div className="webhook-item">
                    <span>Meta</span>
                    <code>{selectedAgent.webhooks.meta || 'Não configurado'}</code>
                  </div>
                  <div className="webhook-item">
                    <span>Uazapi</span>
                    <code>{selectedAgent.webhooks.uazapi || 'Não configurado'}</code>
                  </div>
                </section>
              ) : null}

              {selectedAgent && setupLoading ? <div className="panel-empty">Carregando diagnóstico de setup...</div> : null}
              {selectedAgent && setupError ? <div className="error-banner">{setupError}</div> : null}
              {selectedAgent && setupMessage ? <div className="success-banner">{setupMessage}</div> : null}

              {selectedAgent && agentSetup ? (
                <div className="setup-layout">
                  <section className="setup-summary">
                    <div className="setup-summary-row">
                      <strong>Pendências obrigatórias</strong>
                      <span className={agentSetup.summary.missingRequired ? 'status-badge danger' : 'status-badge success'}>
                        {agentSetup.summary.missingRequired}
                      </span>
                    </div>
                    <div className="setup-summary-row">
                      <span>Modo outbound</span>
                      <span className={agentSetup.mode.outboundMessagesEnabled ? 'status-badge success' : 'status-badge muted'}>
                        {agentSetup.mode.outboundMessagesEnabled ? 'Ativo' : 'Desativado'}
                      </span>
                    </div>
                    <div className="setup-summary-row">
                      <span>WF2 outbound.start</span>
                      <span className={agentSetup.mode.wf2OutboundStartEnabled ? 'status-badge success' : 'status-badge muted'}>
                        {agentSetup.mode.wf2OutboundStartEnabled ? 'Ativo' : 'Desativado'}
                      </span>
                    </div>
                    <button type="button" className="tab" onClick={() => reloadAgentSetup()}>
                      Recarregar diagnóstico
                    </button>
                  </section>

                  <section className="setup-missing">
                    <h4>Faltando configurar</h4>
                    {agentSetup.missing.length ? (
                      <div className="setup-missing-list">
                        {agentSetup.missing.map((field) => (
                          <div key={field.id} className="setup-missing-item">
                            <span>{field.label}</span>
                            <span className="setup-hint">
                              {SETUP_SECTION_LABELS[field.section] || field.section} | {field.envKey}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="panel-empty">Nenhuma pendência obrigatória.</div>
                    )}
                  </section>

                  <form className="setup-form" onSubmit={handleSetupSave}>
                    {setupFieldsBySection.map(([section, fields]) => (
                      <fieldset key={section} className="setup-fieldset">
                        <legend>{SETUP_SECTION_LABELS[section] || section}</legend>
                        <div className="setup-field-grid">
                          {fields.map((field) => (
                            <label key={field.id} className="setup-field">
                              <span>
                                {field.label} {field.required ? '*' : ''}
                                {field.hasSecretValue ? <em className="setup-hint"> já configurado</em> : null}
                              </span>
                              {field.type === 'boolean' ? (
                                <select
                                  value={setupFormValues[field.id] ?? 'false'}
                                  onChange={(event) => handleSetupFieldChange(field.id, event.target.value)}
                                >
                                  <option value="true">true</option>
                                  <option value="false">false</option>
                                </select>
                              ) : (
                                <input
                                  type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
                                  placeholder={field.type === 'password' ? 'Digite para atualizar' : field.envKey}
                                  value={setupFormValues[field.id] ?? ''}
                                  onChange={(event) => handleSetupFieldChange(field.id, event.target.value)}
                                />
                              )}
                              <span className={`setup-hint ${field.configured ? 'ok' : 'warn'}`}>
                                {field.configured ? 'Configurado' : field.required ? 'Obrigatório pendente' : 'Opcional'}
                                {' | '}
                                fonte: {field.source}
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}

                    <div className="setup-actions">
                      <button type="submit" className="tab active" disabled={setupSaving}>
                        {setupSaving ? 'Salvando...' : 'Salvar configurações'}
                      </button>
                    </div>
                  </form>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {requiresAgent && !selectedAgent ? <div className="panel-empty">Selecione um agente para continuar.</div> : null}

        {selectedTab === 'conversations' && selectedAgent ? (
          <div className="panel-grid">
            <section className="panel-left">
              <div className="panel-header-actions">
                <h3>Conversas ({conversations.length})</h3>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="tab active"
                    disabled={simulationRunning}
                    onClick={() => handleRunConversationSimulation()}
                  >
                    {simulationRunning ? 'Simulando...' : 'Simular 10 conversas'}
                  </button>
                  <button
                    type="button"
                    className="tab"
                    disabled={simulationRunning}
                    onClick={() => loadConversationsForAgent(selectedAgentSlug)}
                  >
                    Atualizar
                  </button>
                </div>
              </div>
              {simulationMessage ? <div className="success-banner">{simulationMessage}</div> : null}
              {simulationError ? <div className="error-banner">{simulationError}</div> : null}
              <div className="list-scroll">
                {conversations.map((conversation) => (
                  <button
                    key={conversation.conversationKey}
                    type="button"
                    className={`list-item ${selectedConversationKey === conversation.conversationKey ? 'is-active' : ''}`}
                    onClick={() => setSelectedConversationKey(conversation.conversationKey)}
                  >
                    <div className="list-title">{conversation.phoneNumber || conversation.conversationKey}</div>
                    <div className="list-meta">{conversation.provider} | {conversation.totalMessages} mensagens</div>
                    <div className="list-meta">Lead: {conversation.lead?.status || 'não vinculado'}</div>
                    <div className="list-preview">H: {trimPreview(conversation.preview.human)}</div>
                    <div className="list-preview">IA: {trimPreview(conversation.preview.ai)}</div>
                  </button>
                ))}
              </div>
            </section>

            <section className="panel-right">
              <h3>Mensagens ({messages.length})</h3>
              <div className="chat-box">
                {messages.map((message) => (
                  <div key={message.id} className={`msg-row ${message.role === 'ai' ? 'from-ai' : 'from-human'}`}>
                    <div className="msg-bubble">
                      <div className="msg-role">{message.role === 'ai' ? 'IA' : 'Lead'}</div>
                      <div>{message.content}</div>
                      <div className="msg-time">{new Date(message.createdAt).toLocaleString('pt-BR')}</div>
                    </div>
                  </div>
                ))}
                {!messages.length ? <div className="panel-empty">Sem mensagens nesta conversa.</div> : null}
              </div>
            </section>
          </div>
        ) : null}

        {selectedTab === 'executions' && selectedAgent ? (
          <div className="panel-grid">
            <section className="panel-left">
              <h3>Execuções ({runs.length})</h3>
              <div className="list-scroll">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    className={`list-item ${selectedRunId === run.id ? 'is-active' : ''}`}
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    <div className="list-title">{run.triggerSource}</div>
                    <div className="list-meta">status: {run.status}</div>
                    <div className="list-meta">eventos: {run.totalEvents}</div>
                    <div className="list-meta">{new Date(run.startedAt).toLocaleString('pt-BR')}</div>
                  </button>
                ))}
              </div>
            </section>

            <section className="panel-right">
              <h3>Fluxo da execução</h3>
              <ExecutionFlow events={runDetail?.events || []} />
              <div className="payload-grid">
                <div>
                  <h4>Input</h4>
                  <pre>{JSON.stringify(runDetail?.inputPayload || {}, null, 2)}</pre>
                </div>
                <div>
                  <h4>Output</h4>
                  <pre>{JSON.stringify(runDetail?.outputPayload || {}, null, 2)}</pre>
                </div>
              </div>
            </section>
          </div>
        ) : null}

        {selectedTab === 'scraping' ? (
          <div className="scrape-dashboard">
            <div className="scrape-toolbar">
              <div className="workflow-tabs">
                {WORKFLOW_OPTIONS.map((workflow) => (
                  <button
                    key={workflow.value}
                    type="button"
                    className={selectedWorkflow === workflow.value ? 'tab active' : 'tab'}
                    onClick={() => setSelectedWorkflow(workflow.value)}
                  >
                    {workflow.label}
                  </button>
                ))}
              </div>

              <div className="scrape-controls">
                <label htmlFor="scrape-day">Dia</label>
                <input
                  id="scrape-day"
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                />
                <button type="button" className="tab" onClick={() => setSelectedDate(getTodayDateInputValue())}>
                  Hoje
                </button>
                <button type="button" className="tab" onClick={() => setSelectedDate('')}>
                  Limpar
                </button>
                <button type="button" className="tab" onClick={() => setScrapeRefreshToken((value) => value + 1)}>
                  Atualizar
                </button>
              </div>
            </div>

            {scrapeError ? <div className="error-banner">{scrapeError}</div> : null}
            <p className="muted">
              {hasDateFilter
                ? `Filtro ativo: ${new Date(`${selectedDate}T00:00:00`).toLocaleDateString('pt-BR')}`
                : 'Sem filtro de dia (mostrando todos os registros carregados).'}{' '}
              Totais carregados: {workflowExecutions.length} execuções e {workflowLeads.length} leads.
            </p>

            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">{hasDateFilter ? 'Execuções no dia' : 'Execuções totais'}</div>
                <div className="stat-value">{executionsOfDay.length}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">{hasDateFilter ? 'Leads no dia' : 'Leads totais'}</div>
                <div className="stat-value">{leadsOfDay.length}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">{hasDateFilter ? 'Coletados no dia' : 'Coletados totais'}</div>
                <div className="stat-value">{executionTotals.collected}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Aprovados x descartados</div>
                <div className="stat-value">
                  {executionTotals.approved} / {executionTotals.discarded}
                </div>
              </div>
            </div>

            <div className="panel-grid">
              <section className="panel-left">
                <h3>{hasDateFilter ? 'Execuções de scrap no dia' : 'Execuções de scrap'} ({executionsOfDay.length})</h3>
                <div className="list-scroll">
                  {executionsOfDay.map((execution) => (
                    <article key={execution.id} className="list-item">
                      <div className="list-title">
                        {execution.status.toUpperCase()} | {formatDateTime(execution.startedAt)}
                      </div>
                      <div className="list-meta">Coletados: {execution.totalCollected}</div>
                      <div className="list-meta">Aprovados: {execution.totalApproved}</div>
                      <div className="list-meta">Descartados: {execution.totalDiscarded}</div>
                      <div className="list-meta">Finalizado: {formatDateTime(execution.finishedAt)}</div>
                      {execution.errorMessage ? <div className="list-meta error-text">{execution.errorMessage}</div> : null}
                    </article>
                  ))}
                  {!executionsOfDay.length ? (
                    <div className="panel-empty">
                      {hasDateFilter
                        ? `Nenhuma execução de scrap no dia selecionado para ${selectedWorkflow.toUpperCase()}.`
                        : `Nenhuma execução de scrap encontrada para ${selectedWorkflow.toUpperCase()}.`}
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="panel-right">
                <h3>{hasDateFilter ? 'Leads do dia' : 'Leads'} ({leadsOfDay.length})</h3>
                <div className="list-scroll">
                  {leadsOfDay.map((lead) => (
                    <article key={lead.id} className="list-item">
                      <div className="list-title">{lead.empresa}</div>
                      <div className="list-meta">{lead.nome || 'Sem nome'}</div>
                      <div className="list-meta">Telefone: {lead.telefone || '-'}</div>
                      <div className="list-meta">Segmento: {lead.segmento}</div>
                      <div className="list-meta">Status: {lead.status}</div>
                      <div className="list-meta">Origem: {lead.fonteOrigem}</div>
                      <div className="list-meta">Criado em: {formatDateTime(lead.criadoEm)}</div>
                    </article>
                  ))}
                  {!leadsOfDay.length ? (
                    <div className="panel-empty">
                      {hasDateFilter
                        ? `Nenhum lead encontrado no dia selecionado para ${selectedWorkflow.toUpperCase()}.`
                        : `Nenhum lead encontrado para ${selectedWorkflow.toUpperCase()}.`}
                    </div>
                  ) : null}
                </div>
              </section>
            </div>

            {scrapeLoading ? <div className="panel-empty">Atualizando dados de scraps e leads...</div> : null}
          </div>
        ) : null}

        {selectedTab === 'forms' ? (
          <div className="forms-dashboard">
            <div className="scrape-toolbar">
              <div className="workflow-tabs">
                {WORKFLOW_OPTIONS.map((workflow) => (
                  <button
                    key={workflow.value}
                    type="button"
                    className={selectedWorkflow === workflow.value ? 'tab active' : 'tab'}
                    onClick={() => setSelectedWorkflow(workflow.value)}
                  >
                    {workflow.label}
                  </button>
                ))}
              </div>

              <form className="forms-search" onSubmit={handleFormsSearch}>
                <input
                  type="search"
                  value={formsSearchInput}
                  onChange={(event) => setFormsSearchInput(event.target.value)}
                  placeholder="Buscar por telefone, token ou segmento"
                />
                <button type="submit" className="tab">
                  Buscar
                </button>
                <button
                  type="button"
                  className="tab"
                  onClick={() => {
                    setFormsSearchInput('')
                    setFormsSearchQuery('')
                  }}
                >
                  Limpar
                </button>
                <button type="button" className="tab" onClick={() => setFormsRefreshToken((value) => value + 1)}>
                  Atualizar
                </button>
              </form>
            </div>

            {formsError ? <div className="error-banner">{formsError}</div> : null}
            <p className="muted">
              Total carregado em {selectedWorkflow.toUpperCase()}: {workflowForms.length} formulário(s).
            </p>

            <div className="panel-grid">
              <section className="panel-left">
                <h3>Respostas ({workflowForms.length})</h3>
                <div className="list-scroll">
                  {workflowForms.map((form) => (
                    <button
                      key={form.id}
                      type="button"
                      className={`list-item ${selectedFormId === form.id ? 'is-active' : ''}`}
                      onClick={() => setSelectedFormId(form.id)}
                    >
                      <div className="list-title">{form.telefone || form.token || form.id}</div>
                      <div className="list-meta">Segmento: {form.segmento || '-'}</div>
                      <div className="list-meta">Criado em: {formatDateTime(form.createdAt)}</div>
                      <div className="list-meta">Lead: {form.lead?.status || 'não vinculado'}</div>
                    </button>
                  ))}
                  {!workflowForms.length ? <div className="panel-empty">Nenhuma resposta encontrada.</div> : null}
                </div>
              </section>

              <section className="panel-right">
                <h3>Detalhes do formulário</h3>
                {selectedForm ? (
                  <div className="config-panel">
                    <section>
                      <h3>Identificação</h3>
                      <pre>
                        {JSON.stringify(
                          {
                            id: selectedForm.id,
                            workflow: selectedForm.workflow,
                            token: selectedForm.token,
                            telefone: selectedForm.telefone,
                            createdAt: selectedForm.createdAt,
                            updatedAt: selectedForm.updatedAt,
                          },
                          null,
                          2
                        )}
                      </pre>
                    </section>
                    <section>
                      <h3>Respostas principais</h3>
                      <pre>
                        {JSON.stringify(
                          {
                            segmento: selectedForm.segmento,
                            faturamentoMensal: selectedForm.faturamentoMensal,
                            numFuncionarios: selectedForm.numFuncionarios,
                            ferramentas: selectedForm.ferramentas,
                            tentativaAnterior: selectedForm.tentativaAnterior,
                            mudancaOperacao: selectedForm.mudancaOperacao,
                            descricaoOperacao: selectedForm.descricaoOperacao,
                            urgencia: selectedForm.urgencia,
                            maiorDesafio: selectedForm.maiorDesafio,
                            motivacao: selectedForm.motivacao,
                            expectativa: selectedForm.expectativa,
                          },
                          null,
                          2
                        )}
                      </pre>
                    </section>
                    <section>
                      <h3>Lead vinculado</h3>
                      <pre>{JSON.stringify(selectedForm.lead || {}, null, 2)}</pre>
                    </section>
                    <section>
                      <h3>Payload bruto</h3>
                      <pre>{JSON.stringify(selectedForm.rawData || {}, null, 2)}</pre>
                    </section>
                  </div>
                ) : (
                  <div className="panel-empty">Selecione uma resposta para visualizar os detalhes.</div>
                )}
              </section>
            </div>

            {formsLoading ? <div className="panel-empty">Atualizando respostas de formulário...</div> : null}
          </div>
        ) : null}

        {selectedTab === 'config' && selectedAgent ? (
          <div className="config-panel">
            <section>
              <h3>Config IA</h3>
              <pre>{JSON.stringify(selectedAgent.ai, null, 2)}</pre>
            </section>
            <section>
              <h3>Config WF2</h3>
              <pre>{JSON.stringify(selectedAgent.wf2, null, 2)}</pre>
            </section>
            <section>
              <h3>Providers</h3>
              <pre>{JSON.stringify(selectedAgent.providers, null, 2)}</pre>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  )
}

