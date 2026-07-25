export interface PiRpcCommand {
  type: string
  id?: string
  [key: string]: unknown
}

export interface PiRpcResponse {
  type: "response"
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

export interface PiEvent {
  type: string
  [key: string]: unknown
}

export type PiRpcMessage = PiRpcResponse | PiEvent
