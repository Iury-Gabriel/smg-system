import { useMemo } from 'react'
import ReactFlow, { Background, Controls, MiniMap, type Edge, type Node } from 'reactflow'
import 'reactflow/dist/style.css'

export interface ExecutionEvent {
  id: string
  stepKey: string
  title: string
  nodeType: string
  status: string
  payload: Record<string, unknown> | null
  createdAt: string
}

interface ExecutionFlowProps {
  events: ExecutionEvent[]
}

function getStatusColor(status: string) {
  if (status === 'success') return '#0f766e'
  if (status === 'warning') return '#b45309'
  if (status === 'error') return '#b91c1c'
  return '#1d4ed8'
}

export function ExecutionFlow({ events }: ExecutionFlowProps) {
  const flow = useMemo(() => {
    const nodes: Node[] = events.map((event, index) => {
      const color = getStatusColor(event.status)
      return {
        id: event.id,
        position: {
          x: index * 260,
          y: index % 2 === 0 ? 70 : 190,
        },
        data: {
          label: (
            <div className="flow-node">
              <div className="flow-node-title">{event.title}</div>
              <div className="flow-node-step">{event.stepKey}</div>
              <div className="flow-node-time">{new Date(event.createdAt).toLocaleString('pt-BR')}</div>
            </div>
          ),
        },
        style: {
          border: `2px solid ${color}`,
          borderRadius: '14px',
          minWidth: '220px',
          background: '#fff',
          boxShadow: '0 12px 24px rgba(15, 23, 42, 0.08)',
        },
      }
    })

    const edges: Edge[] = events.slice(1).map((event, index) => ({
      id: `e-${events[index].id}-${event.id}`,
      source: events[index].id,
      target: event.id,
      animated: true,
      style: {
        stroke: '#64748b',
        strokeWidth: 2,
      },
    }))

    return { nodes, edges }
  }, [events])

  if (!events.length) {
    return <div className="panel-empty">Nenhum evento encontrado para montar o fluxo.</div>
  }

  return (
    <div className="flow-wrapper">
      <ReactFlow nodes={flow.nodes} edges={flow.edges} fitView fitViewOptions={{ padding: 0.3 }}>
        <MiniMap />
        <Controls />
        <Background gap={22} size={1.1} />
      </ReactFlow>
    </div>
  )
}
