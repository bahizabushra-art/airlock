export type UserRole = 'admin' | 'analyst' | 'member';

export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'custom';

export type DlpSensitivity = 'strict' | 'balanced';

export type PiiCategory =
  | 'NID'
  | 'PHONE'
  | 'ACCOUNT'
  | 'MFS'
  | 'CARD'
  | 'EMAIL'
  | 'PASSPORT'
  | 'TIN'
  | 'SECRET'
  | 'PERSON'
  | 'ADDRESS';

export type AuditEventType =
  | 'PII_REDACTED'
  | 'INJECTION_BLOCKED'
  | 'FAIL_CLOSED_503'
  | 'RATE_LIMITED'
  | 'AUTH_LOGIN'
  | 'AUTH_FAILED'
  | 'MCP_TOOL_CALL'
  | 'DLP_MODE_CHANGED'
  | 'QUERY_PASSED';

export type AuditSeverity = 'info' | 'warning' | 'critical';

export interface RedactionMeta {
  placeholder: string;
  category: PiiCategory;
  language: 'bangla' | 'banglish' | 'english';
}

export interface DlpScanResult {
  sanitizedText: string;
  placeholderMap: Map<string, string>;
  redactions: RedactionMeta[];
  engineHealthy: boolean;
}

export interface InjectionScanResult {
  blocked: boolean;
  ruleName?: string;
  category?: string;
  confidence: number;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password_hash: string;
  two_factor_enabled: number;
  two_factor_code: string | null;
  active: number;
  created_at: string;
}

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
