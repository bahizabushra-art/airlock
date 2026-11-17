import type {
  AuditLogEntry,
  AuditSummary,
  ConversationSummary,
  PersistedMessage,
  ProviderId,
  ProviderStatusInfo,
  PublicUser,
  RedactionMeta,
  SecuritySettings,
  UserRole,
} from '../types';

const TOKEN_STORAGE_KEY = 'airlock_session_token';
let memoryToken: string | null = null;

export function getStoredToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return memoryToken;
  }
}

export function setStoredToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage access restrictions; memoryToken remains active
  }
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) {
    if (res.status === 401) {
      setStoredToken(null);
    }
    const err = new Error(data.error || `Request failed (${res.status})`) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

export const api = {
  login: async (payload: { email: string; password: string; twoFactorCode?: string }) => {
    const res = await requestJson<{ token?: string; user?: PublicUser; requires2FA?: boolean; email?: string }>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    if (res.token) setStoredToken(res.token);
    return res;
  },

  register: async (payload: { name: string; email: string; password: string }) => {
    const res = await requestJson<{ token: string; user: PublicUser }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.token) setStoredToken(res.token);
    return res;
  },

  logout: async () => {
    setStoredToken(null);
    return requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },

  forgotPassword: (email: string) =>
    requestJson<{ ok: boolean; message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  me: () =>
    requestJson<{ user: PublicUser; settings: SecuritySettings; providers: ProviderStatusInfo[] }>('/api/auth/me'),

  toggle2FA: (enabled: boolean) =>
    requestJson<{ twoFactorEnabled: boolean; authenticatorCode: string | null }>('/api/auth/2fa', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  getProviders: () =>
    requestJson<{ providers: ProviderStatusInfo[]; settings: SecuritySettings }>('/api/providers/status'),

  testProvider: (payload: { provider: ProviderId; model: string; customEndpointUrl?: string }) =>
    requestJson<{ ok: boolean; latencyMs: number; detail: string }>('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateSettings: (patch: Partial<SecuritySettings>) =>
    requestJson<{ settings: SecuritySettings; providers: ProviderStatusInfo[] }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  getConversations: (q = '') =>
    requestJson<{ conversations: ConversationSummary[] }>(
      `/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`
    ),

  getConversationDetail: (id: string) =>
    requestJson<{ conversation: ConversationSummary; messages: PersistedMessage[] }>(`/api/conversations/${id}`),

  deleteConversation: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),

  getAuditLogs: (params: { type?: string; severity?: string; q?: string } = {}) => {
    const sp = new URLSearchParams();
    if (params.type && params.type !== 'ALL') sp.set('type', params.type);
    if (params.severity && params.severity !== 'ALL') sp.set('severity', params.severity);
    if (params.q) sp.set('q', params.q);
    const qs = sp.toString();
    return requestJson<{ logs: AuditLogEntry[]; summary: AuditSummary }>(
      `/api/audit-logs${qs ? `?${qs}` : ''}`
    );
  },

  runZeroPiiScan: () =>
    requestJson<{ clean: boolean; scannedMessages: number; scannedAuditLogs: number; findingsCount: number }>(
      '/api/security/zero-pii-scan'
    ),

  inspectPreview: (text: string) =>
    requestJson<{
      sanitizedText: string;
      redactions: RedactionMeta[];
      injection: { blocked: boolean; ruleName?: string; category?: string; confidence: number };
    }>('/api/security/inspect-preview', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  getAdminUsers: () => requestJson<{ users: PublicUser[] }>('/api/admin/users'),

  createAdminUser: (payload: { name: string; email: string; password: string; role: UserRole }) =>
    requestJson<{ user: PublicUser }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateAdminUser: (id: string, patch: { role?: UserRole; active?: boolean }) =>
    requestJson<{ user: PublicUser }>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  testMcpRpc: (rpc: { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> }) =>
    requestJson<Record<string, unknown>>('/api/mcp/test', {
      method: 'POST',
      body: JSON.stringify(rpc),
    }),
};

export interface StreamQueryCallbacks {
  onMeta: (meta: {
    conversationId: string;
    userMessageId: string;
    sanitizedPrompt: string;
    redactions: RedactionMeta[];
    provider: string;
    model: string;
  }) => void;
  onDelta: (text: string) => void;
  onDone: (done: {
    conversationId: string;
    messageId: string;
    sanitizedAnswer: string;
    latencyMs: number;
    reidentifiedCount: number;
  }) => void;
}

export async function streamAiQuery(
  payload: { prompt: string; conversationId?: string; provider?: ProviderId; model?: string },
  callbacks: StreamQueryCallbacks
): Promise<void> {
  const token = getStoredToken();
  const res = await fetch('/api/ai/query', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ ...payload, stream: true }),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    const err = new Error(errBody.error || `Gateway blocked request (HTTP ${res.status})`) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    err.code = errBody.code;
    throw err;
  }

  if (!res.body) {
    throw new Error('Streaming response body unavailable.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      const lines = block.split('\n');
      let eventType = 'message';
      let dataLine = '';

      for (const line of lines) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        if (line.startsWith('data:')) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;

      const parsed = JSON.parse(dataLine);
      if (eventType === 'meta') callbacks.onMeta(parsed);
      else if (eventType === 'delta') callbacks.onDelta(parsed.text || '');
      else if (eventType === 'done') callbacks.onDone(parsed);
      else if (eventType === 'error') throw new Error(parsed.error || 'Provider stream error');
    }
  }
}
