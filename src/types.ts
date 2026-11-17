export type UserRole = 'admin' | 'analyst' | 'member';
export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'custom';
export type DlpSensitivity = 'strict' | 'balanced';

export type NavPage = 'chat' | 'history' | 'settings';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  twoFactorEnabled: boolean;
  active: boolean;
  createdAt: string;
}

export interface SecuritySettings {
  dlpEnabled: boolean;
  dlpSensitivity: DlpSensitivity;
  injectionBlockingEnabled: boolean;
  rateLimitPerMin: number;
  mcpGatewayEnabled: boolean;
  activeProvider: ProviderId;
  activeModel: string;
  customEndpointUrl: string;
  systemPolicyPrompt: string;
}

export interface ProviderStatusInfo {
  id: ProviderId;
  name: string;
  configured: boolean;
  envVar: string;
  models: Array<{ id: string; label: string; tier: string }>;
  note: string;
}

export interface RedactionMeta {
  placeholder: string;
  category: string;
  language: 'bangla' | 'banglish' | 'english';
}

export interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sanitizedContent?: string;
  redactions?: RedactionMeta[];
  latencyMs?: number;
  createdAt: string;
  provider?: string;
  model?: string;
  isStreaming?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  provider: string;
  model: string;
  message_count: number;
  total_redactions: number;
  first_prompt: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersistedMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  sanitized_content: string;
  redaction_count: number;
  redacted_types_json: string;
  latency_ms: number;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  user_id: string;
  user_email: string;
  event_type: string;
  severity: 'info' | 'warning' | 'critical';
  provider: string;
  model: string;
  entity_types_json: string;
  sanitized_snippet: string;
  http_status: number;
  source: string;
  created_at: string;
}

export interface AuditSummary {
  total: number;
  redactions: number;
  injectionsBlocked: number;
  failClosedBlocks: number;
  mcpCalls: number;
}
