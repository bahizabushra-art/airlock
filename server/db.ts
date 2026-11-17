import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AuditEventType,
  AuditSeverity,
  DlpSensitivity,
  ProviderId,
  PublicUser,
  SecuritySettings,
  UserRecord,
  UserRole,
} from './types.ts';

const DB_PATH = process.env.AIRLOCK_DB_PATH || path.resolve(process.cwd(), 'airlock.db');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);

const DEFAULT_SYSTEM_POLICY_PROMPT =
  'You are a helpful AI assistant. Any bracketed token such as [NID_1], [PHONE_1], [ACCOUNT_1], [MFS_1], [EMAIL_1], [PERSON_1], or [ADDRESS_1] represents a real, verified value temporarily masked for privacy. Treat every bracketed token as valid complete data, preserve the exact bracketed token verbatim wherever you reference it, and NEVER ask the user to replace, clarify, or provide the unmasked value. Do not comment on the placeholder format.';

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    password_hash TEXT NOT NULL,
    two_factor_enabled INTEGER NOT NULL DEFAULT 0,
    two_factor_code TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    sanitized_content TEXT NOT NULL,
    redaction_count INTEGER NOT NULL DEFAULT 0,
    redacted_types_json TEXT NOT NULL DEFAULT '[]',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    entity_types_json TEXT NOT NULL DEFAULT '[]',
    sanitized_snippet TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'chat',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS security_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    dlp_enabled INTEGER NOT NULL DEFAULT 1,
    dlp_sensitivity TEXT NOT NULL DEFAULT 'strict',
    injection_blocking_enabled INTEGER NOT NULL DEFAULT 1,
    rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
    mcp_gateway_enabled INTEGER NOT NULL DEFAULT 1,
    active_provider TEXT NOT NULL DEFAULT 'gemini',
    active_model TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',
    custom_endpoint_url TEXT NOT NULL DEFAULT '',
    system_policy_prompt TEXT NOT NULL DEFAULT '${DEFAULT_SYSTEM_POLICY_PROMPT}'
  );
`);

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

// Encryption key derived from env or ephemeral local secret for non-PII operational metadata
const ENCRYPTION_KEY = crypto
  .createHash('sha256')
  .update(process.env.AIRLOCK_ENCRYPTION_KEY || process.env.JWT_SECRET || 'airlock-local-gateway-key-v1')
  .digest();

export function encryptValue(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptValue(ciphertext: string): string {
  const [ivHex, tagHex, dataHex] = ciphertext.split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

export function toPublicUser(row: UserRecord): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as UserRole,
    twoFactorEnabled: row.two_factor_enabled === 1,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export function getSecuritySettings(): SecuritySettings {
  const row = db.prepare('SELECT * FROM security_settings WHERE id = 1').get() as Record<string, unknown> | undefined;
  if (!row) {
    return {
      dlpEnabled: true,
      dlpSensitivity: 'strict',
      injectionBlockingEnabled: true,
      rateLimitPerMin: 60,
      mcpGatewayEnabled: true,
      activeProvider: 'gemini',
      activeModel: 'gemini-3.1-flash-lite',
      customEndpointUrl: '',
      systemPolicyPrompt: '',
    };
  }
  return {
    dlpEnabled: Number(row.dlp_enabled) === 1,
    dlpSensitivity: (row.dlp_sensitivity as DlpSensitivity) || 'strict',
    injectionBlockingEnabled: Number(row.injection_blocking_enabled) === 1,
    rateLimitPerMin: Number(row.rate_limit_per_min) || 60,
    mcpGatewayEnabled: Number(row.mcp_gateway_enabled) === 1,
    activeProvider: (row.active_provider as ProviderId) || 'gemini',
    activeModel: String(row.active_model || 'gemini-3.1-flash-lite'),
    customEndpointUrl: String(row.custom_endpoint_url || ''),
    systemPolicyPrompt: String(row.system_policy_prompt || ''),
  };
}

export function updateSecuritySettings(patch: Partial<SecuritySettings>): SecuritySettings {
  const current = getSecuritySettings();
  const next: SecuritySettings = {
    dlpEnabled: patch.dlpEnabled ?? current.dlpEnabled,
    dlpSensitivity: patch.dlpSensitivity ?? current.dlpSensitivity,
    injectionBlockingEnabled: patch.injectionBlockingEnabled ?? current.injectionBlockingEnabled,
    rateLimitPerMin: Math.max(5, Math.min(600, Number(patch.rateLimitPerMin ?? current.rateLimitPerMin))),
    mcpGatewayEnabled: patch.mcpGatewayEnabled ?? current.mcpGatewayEnabled,
    activeProvider: patch.activeProvider ?? current.activeProvider,
    activeModel: patch.activeModel ?? current.activeModel,
    customEndpointUrl: patch.customEndpointUrl ?? current.customEndpointUrl,
    systemPolicyPrompt: patch.systemPolicyPrompt ?? current.systemPolicyPrompt,
  };

  db.prepare(`
    UPDATE security_settings
    SET dlp_enabled = ?,
        dlp_sensitivity = ?,
        injection_blocking_enabled = ?,
        rate_limit_per_min = ?,
        mcp_gateway_enabled = ?,
        active_provider = ?,
        active_model = ?,
        custom_endpoint_url = ?,
        system_policy_prompt = ?
    WHERE id = 1
  `).run(
    next.dlpEnabled ? 1 : 0,
    next.dlpSensitivity,
    next.injectionBlockingEnabled ? 1 : 0,
    next.rateLimitPerMin,
    next.mcpGatewayEnabled ? 1 : 0,
    next.activeProvider,
    next.activeModel,
    next.customEndpointUrl,
    next.systemPolicyPrompt
  );

  return next;
}

export function recordAuditLog(params: {
  userId: string;
  userEmail: string;
  eventType: AuditEventType;
  severity: AuditSeverity;
  provider: string;
  model: string;
  entityTypes?: string[];
  sanitizedSnippet: string;
  httpStatus: number;
  source?: 'chat' | 'mcp' | 'auth' | 'admin';
}): void {
  const snippet = params.sanitizedSnippet.slice(0, 280);
  db.prepare(`
    INSERT INTO audit_logs (
      id, user_id, user_email, event_type, severity, provider, model,
      entity_types_json, sanitized_snippet, http_status, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    params.userId,
    params.userEmail,
    params.eventType,
    params.severity,
    params.provider,
    params.model,
    JSON.stringify(params.entityTypes ?? []),
    snippet,
    params.httpStatus,
    params.source ?? 'chat',
    new Date().toISOString()
  );
}

function seedInitialData(): void {
  db.prepare('INSERT OR IGNORE INTO security_settings (id) VALUES (1)').run();
  const settingsRow = db.prepare('SELECT system_policy_prompt FROM security_settings WHERE id = 1').get() as
    | { system_policy_prompt?: string }
    | undefined;
  if (
    settingsRow &&
    (!settingsRow.system_policy_prompt ||
      !settingsRow.system_policy_prompt.includes('NEVER ask the user to replace'))
  ) {
    db.prepare('UPDATE security_settings SET system_policy_prompt = ? WHERE id = 1').run(
      DEFAULT_SYSTEM_POLICY_PROMPT
    );
  }

  const userCountRow = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (Number(userCountRow.cnt) === 0) {
    const now = new Date().toISOString();
    const adminId = 'usr_admin_01';
    const analystId = 'usr_analyst_01';

    db.prepare(`
      INSERT INTO users (id, email, name, role, password_hash, two_factor_enabled, two_factor_code, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(adminId, 'admin@airlock.local', 'Nadia Rahman', 'admin', hashPassword('AirLockAdmin!2026'), 0, encryptValue('482910'), 1, now);

    db.prepare(`
      INSERT INTO users (id, email, name, role, password_hash, two_factor_enabled, two_factor_code, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(analystId, 'analyst@airlock.local', 'Tariq Hasan', 'analyst', hashPassword('AirLockUser!2026'), 0, encryptValue('193045'), 1, now);

    // Seed sanitized-only conversation history (zero raw PII stored)
    const convId = 'conv_seed_01';
    const t1 = new Date(Date.now() - 1000 * 60 * 42).toISOString();
    const t2 = new Date(Date.now() - 1000 * 60 * 41).toISOString();
    db.prepare(`
      INSERT INTO conversations (id, user_id, title, provider, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(convId, adminId, 'KYB Verification Summary ([NID_1])', 'gemini', 'gemini-4-hydrogen', t1, t2);

    db.prepare(`
      INSERT INTO messages (id, conversation_id, user_id, role, sanitized_content, redaction_count, redacted_types_json, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg_seed_01',
      convId,
      adminId,
      'user',
      'Amar client [PERSON_1] er NID [NID_1] ar bKash [MFS_1] compliance checklist e format koro.',
      3,
      JSON.stringify(['PERSON', 'NID', 'MFS']),
      0,
      t1
    );

    db.prepare(`
      INSERT INTO messages (id, conversation_id, user_id, role, sanitized_content, redaction_count, redacted_types_json, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'msg_seed_02',
      convId,
      adminId,
      'assistant',
      'Compliance Checklist Entry:\n- Applicant Name: [PERSON_1]\n- National ID Reference: [NID_1]\n- Verified MFS Wallet: [MFS_1]\n\nAll sensitive identifiers remained redacted across the external model call and were re-identified locally in memory.',
      0,
      '[]',
      412,
      t2
    );

    // Seed sanitized-only audit log entries
    recordAuditLog({
      userId: adminId,
      userEmail: 'admin@airlock.local',
      eventType: 'PII_REDACTED',
      severity: 'info',
      provider: 'gemini',
      model: 'gemini-4-hydrogen',
      entityTypes: ['PERSON', 'NID', 'MFS'],
      sanitizedSnippet: 'Amar client [PERSON_1] er NID [NID_1] ar bKash [MFS_1] compliance checklist e format koro.',
      httpStatus: 200,
      source: 'chat',
    });

    recordAuditLog({
      userId: analystId,
      userEmail: 'analyst@airlock.local',
      eventType: 'INJECTION_BLOCKED',
      severity: 'critical',
      provider: 'gemini',
      model: 'gemini-4-hydrogen',
      entityTypes: ['PROMPT_OVERRIDE'],
      sanitizedSnippet: 'Blocked instruction override attempt targeting system policy extraction.',
      httpStatus: 400,
      source: 'chat',
    });

    recordAuditLog({
      userId: analystId,
      userEmail: 'analyst@airlock.local',
      eventType: 'MCP_TOOL_CALL',
      severity: 'warning',
      provider: 'mcp-gateway',
      model: 'airlock_inspect_text',
      entityTypes: ['PHONE', 'EMAIL'],
      sanitizedSnippet: 'Cursor agent file read inspected: Contact [EMAIL_1] / [PHONE_1] redacted prior to context injection.',
      httpStatus: 200,
      source: 'mcp',
    });
  }
}

seedInitialData();
