import type { AgentAdapter } from "./agent-adapter.ts"

export interface AgentAdapterCreateInput {
  id: string
  displayName: string
  cliPath: string
  provider?: string
  model?: string
  systemPrompt?: string
  tools?: string[]
}

export type AgentAdapterFactory = (input: AgentAdapterCreateInput) => AgentAdapter

export class AgentAdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()
  private factories = new Map<string, AgentAdapterFactory>()
  private defaultId: string | null = null

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Agent adapter already registered: ${adapter.id}`)
    }
    this.adapters.set(adapter.id, adapter)
    if (this.defaultId === null) {
      this.defaultId = adapter.id
    }
  }

  registerFactory(type: string, factory: AgentAdapterFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`Agent adapter factory already registered: ${type}`)
    }
    this.factories.set(type, factory)
  }

  create(type: string, input: AgentAdapterCreateInput): AgentAdapter {
    const factory = this.factories.get(type)
    if (!factory) throw new Error(`Agent adapter type not found: ${type}`)
    return factory(input)
  }

  hasFactory(type: string): boolean {
    return this.factories.has(type)
  }

  get(id: string): AgentAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      throw new Error(`Agent adapter not found: ${id}`)
    }
    return adapter
  }

  list(): AgentAdapter[] {
    return Array.from(this.adapters.values())
  }

  getDefault(): AgentAdapter {
    if (!this.defaultId) {
      throw new Error("No agent adapter registered")
    }
    return this.get(this.defaultId)
  }

  setDefault(id: string): void {
    if (!this.adapters.has(id)) {
      throw new Error(`Agent adapter not found: ${id}`)
    }
    this.defaultId = id
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  unregister(id: string): boolean {
    if (!this.adapters.has(id)) return false
    this.adapters.delete(id)
    if (this.defaultId === id) {
      const remaining = Array.from(this.adapters.keys())
      this.defaultId = remaining.length > 0 ? remaining[0]! : null
    }
    return true
  }
}
