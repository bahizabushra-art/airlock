import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import {
  type AuthenticatedRequest,
  rateLimitMiddleware,
  requireAdmin,
  requireAuth,
  signJwt,
} from './server/auth.ts';
import {
  db,
  decryptValue,
  encryptValue,
  getSecuritySettings,
  hashPassword,
  recordAuditLog,
  toPublicUser,
  updateSecuritySettings,
  verifyPassword,
} from './server/db.ts';
import {
  inspectAndRedact,
  reidentifyText,
  scanDatabaseForRawPii,
  StreamingReidentifier,
} from './server/dlp.ts';
import { scanPromptInjection } from './server/injection.ts';
import { handleMcpMessage, handleMcpSseConnect, processMcpJsonRpc } from './server/mcp.ts';
import { getProviderStatuses, streamSanitizedToProvider, testProviderConnectivity } from './server/providers.ts';
import type { ProviderId, UserRecord, UserRole } from './server/types.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Health check endpoint (Render / container orchestration)
  app.get('/health', (_req, res) => {
    const settings = getSecuritySettings();
    res.status(200).json({
      status: settings.dlpEnabled ? 'ok' : 'degraded',
      service: 'airlock-gateway',
      dlpEngine: settings.dlpEnabled ? 'online' : 'offline',
      mcpGateway: settings.mcpGatewayEnabled ? 'enabled' : 'disabled',
      timestamp: new Date().toISOString(),
    });
  });

  // =========================================================================
  // Authentication API
  // =========================================================================
  app.post('/api/auth/login', (req, res) => {
    const { email, password, twoFactorCode } = req.body as {
      email?: string;
      password?: string;
      twoFactorCode?: string;
    };

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const userRow = db
      .prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)')
      .get(email.trim()) as UserRecord | undefined;

    if (!userRow || !verifyPassword(password, userRow.password_hash)) {
      recordAuditLog({
        userId: userRow?.id ?? 'unknown',
        userEmail: email.trim().toLowerCase(),
        eventType: 'AUTH_FAILED',
        severity: 'warning',
        provider: 'airlock-auth',
        model: 'scrypt-jwt',
        entityTypes: ['INVALID_CREDENTIALS'],
        sanitizedSnippet: 'Failed login attempt rejected.',
        httpStatus: 401,
        source: 'auth',
      });
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    if (userRow.active !== 1) {
      res.status(403).json({ error: 'This account has been deactivated by an administrator.' });
      return;
    }

    if (userRow.two_factor_enabled === 1) {
      const expectedCode = userRow.two_factor_code ? decryptValue(userRow.two_factor_code) : '';
      if (!twoFactorCode) {
        res.status(200).json({ requires2FA: true, email: userRow.email });
        return;
      }
      if (twoFactorCode.trim() !== expectedCode) {
        res.status(401).json({ error: 'Invalid 2FA verification code.' });
        return;
      }
    }

    const publicUser = toPublicUser(userRow);
    const token = signJwt({ id: publicUser.id, email: publicUser.email, role: publicUser.role });

    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('airlock_token', token, {
      httpOnly: true,
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
      maxAge: 1000 * 60 * 60 * 12,
      path: '/',
    });

    recordAuditLog({
      userId: publicUser.id,
      userEmail: publicUser.email,
      eventType: 'AUTH_LOGIN',
      severity: 'info',
      provider: 'airlock-auth',
      model: 'scrypt-jwt',
      entityTypes: [],
      sanitizedSnippet: `Authenticated session started (${publicUser.role}).`,
      httpStatus: 200,
      source: 'auth',
    });

    res.status(200).json({ token, user: publicUser });
  });

  app.post('/api/auth/register', (req, res) => {
    const { email, name, password } = req.body as { email?: string; name?: string; password?: string };
    if (!email || !name || !password || password.length < 8) {
      res.status(400).json({ error: 'Valid name, email, and password (min 8 chars) are required.' });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail);
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const id = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const twoFaSecret = String(Math.floor(100000 + Math.random() * 900000));

    db.prepare(`
      INSERT INTO users (id, email, name, role, password_hash, two_factor_enabled, two_factor_code, active, created_at)
      VALUES (?, ?, ?, 'member', ?, 0, ?, 1, ?)
    `).run(id, cleanEmail, name.trim(), hashPassword(password), encryptValue(twoFaSecret), now);

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRecord;
    const publicUser = toPublicUser(userRow);
    const token = signJwt({ id: publicUser.id, email: publicUser.email, role: publicUser.role });

    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('airlock_token', token, {
      httpOnly: true,
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
      maxAge: 1000 * 60 * 60 * 12,
      path: '/',
    });

    res.status(201).json({ token, user: publicUser });
  });

  app.post('/api/auth/logout', (req, res) => {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.clearCookie('airlock_token', {
      path: '/',
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
    });
    res.status(200).json({ ok: true });
  });

  app.post('/api/auth/forgot-password', (req, res) => {
    const { email } = req.body as { email?: string };
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Enter a valid organizational email address.' });
      return;
    }
    res.status(200).json({
      ok: true,
      message:
        'In self-hosted deployments, password resets are issued by your organization AirLock administrator or via CLI. Contact your admin or use the workspace credentials listed on the sign-in panel.',
    });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    const settings = getSecuritySettings();
    res.status(200).json({
      user: req.user,
      settings,
      providers: getProviderStatuses(settings.customEndpointUrl),
    });
  });

  app.post('/api/auth/2fa', requireAuth, (req: AuthenticatedRequest, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as unknown as UserRecord;
    const currentCode = userRow.two_factor_code ? decryptValue(userRow.two_factor_code) : '482910';
    const nextEnabled = enabled ? 1 : 0;

    db.prepare('UPDATE users SET two_factor_enabled = ? WHERE id = ?').run(nextEnabled, req.user!.id);
    res.status(200).json({
      twoFactorEnabled: nextEnabled === 1,
      authenticatorCode: nextEnabled === 1 ? currentCode : null,
    });
  });

  // =========================================================================
  // AirLock Core AI Security Gateway (/api/ai/query)
  // =========================================================================
  // Ephemeral RAM-only cache per conversation for multi-turn re-identification (zero disk/DB persistence)
  const sessionPlaceholderCache = new Map<string, Map<string, string>>();

  app.post('/api/ai/query', requireAuth, rateLimitMiddleware, async (req: AuthenticatedRequest, res) => {
    const user = req.user!;
    const startMs = Date.now();
    const {
      prompt,
      conversationId,
      provider: reqProvider,
      model: reqModel,
      stream = true,
    } = req.body as {
      prompt?: string;
      conversationId?: string;
      provider?: ProviderId;
      model?: string;
      stream?: boolean;
    };

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'Prompt text is required.' });
      return;
    }

    const settings = getSecuritySettings();
    const provider = reqProvider || settings.activeProvider;
    const model = reqModel || settings.activeModel;

    // -----------------------------------------------------------------------
    // 1. FAIL-CLOSED LOCAL DLP INSPECTION (Bangla / Banglish / English)
    // -----------------------------------------------------------------------
    const existingSessionMap = conversationId ? sessionPlaceholderCache.get(conversationId) : undefined;
    let dlpResult;
    try {
      dlpResult = inspectAndRedact(
        prompt,
        {
          dlpEnabled: settings.dlpEnabled,
          sensitivity: settings.dlpSensitivity,
        },
        existingSessionMap
      );
    } catch (err) {
      recordAuditLog({
        userId: user.id,
        userEmail: user.email,
        eventType: 'FAIL_CLOSED_503',
        severity: 'critical',
        provider,
        model,
        entityTypes: ['DLP_UNAVAILABLE'],
        sanitizedSnippet: 'Gateway blocked request fail-closed because local DLP engine was offline or unreachable.',
        httpStatus: 503,
        source: 'chat',
      });
      res.status(503).json({
        error:
          err instanceof Error
            ? err.message
            : 'AirLock Fail-Closed (503): Local DLP inspection layer is unreachable. Request blocked.',
        code: 'FAIL_CLOSED_503',
      });
      return;
    }

    const placeholderMap = dlpResult.placeholderMap;

    try {
      // ---------------------------------------------------------------------
      // 2. LOCAL PROMPT-INJECTION DETECTION (Blocks with HTTP 400)
      // ---------------------------------------------------------------------
      const injection = scanPromptInjection(prompt, { enabled: settings.injectionBlockingEnabled });
      if (injection.blocked) {
        recordAuditLog({
          userId: user.id,
          userEmail: user.email,
          eventType: 'INJECTION_BLOCKED',
          severity: 'critical',
          provider,
          model,
          entityTypes: [injection.ruleName || 'PROMPT_INJECTION'],
          sanitizedSnippet: `Blocked (${injection.category}): ${dlpResult.sanitizedText.slice(0, 160)}`,
          httpStatus: 400,
          source: 'chat',
        });
        res.status(400).json({
          error: `Prompt blocked: malicious content detected (${injection.category}).`,
          code: 'INJECTION_BLOCKED',
          ruleName: injection.ruleName,
          category: injection.category,
        });
        return;
      }

      // ---------------------------------------------------------------------
      // 3. CONVERSATION & ZERO-PII PERSISTENCE (Only placeholders saved)
      // ---------------------------------------------------------------------
      const now = new Date().toISOString();
      let activeConvId = conversationId;
      if (activeConvId) {
        const existingConv = db
          .prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
          .get(activeConvId, user.id);
        if (!existingConv) activeConvId = undefined;
      }

      if (!activeConvId) {
        activeConvId = `conv_${crypto.randomUUID().slice(0, 10)}`;
        const title = dlpResult.sanitizedText.replace(/\s+/g, ' ').trim().slice(0, 56) || 'Secured Session';
        db.prepare(`
          INSERT INTO conversations (id, user_id, title, provider, model, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(activeConvId, user.id, title, provider, model, now, now);
      } else {
        db.prepare('UPDATE conversations SET updated_at = ?, provider = ?, model = ? WHERE id = ?').run(
          now,
          provider,
          model,
          activeConvId
        );
      }

      const priorMessages = db
        .prepare('SELECT role, sanitized_content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
        .all(activeConvId) as Array<{ role: 'user' | 'assistant'; sanitized_content: string }>;

      const categories = Array.from(new Set(dlpResult.redactions.map((r) => r.category)));

      const userMsgId = `msg_${crypto.randomUUID().slice(0, 10)}`;
      db.prepare(`
        INSERT INTO messages (
          id, conversation_id, user_id, role, sanitized_content,
          redaction_count, redacted_types_json, latency_ms, created_at
        ) VALUES (?, ?, ?, 'user', ?, ?, ?, 0, ?)
      `).run(
        userMsgId,
        activeConvId,
        user.id,
        dlpResult.sanitizedText,
        dlpResult.redactions.length,
        JSON.stringify(categories),
        now
      );

      recordAuditLog({
        userId: user.id,
        userEmail: user.email,
        eventType: dlpResult.redactions.length > 0 ? 'PII_REDACTED' : 'QUERY_PASSED',
        severity: dlpResult.redactions.length > 0 ? 'warning' : 'info',
        provider,
        model,
        entityTypes: categories,
        sanitizedSnippet: dlpResult.sanitizedText.slice(0, 240),
        httpStatus: 200,
        source: 'chat',
      });

      const historyForModel = priorMessages.map((m) => ({
        role: m.role,
        content: m.sanitized_content,
      }));

      if (placeholderMap.size > 0) {
        if (sessionPlaceholderCache.size >= 200) {
          const oldestKey = sessionPlaceholderCache.keys().next().value;
          if (oldestKey) sessionPlaceholderCache.delete(oldestKey);
        }
        sessionPlaceholderCache.set(activeConvId, new Map(placeholderMap));
      }

      const activeTokens = Array.from(placeholderMap.keys());
      const effectiveSystemInstruction =
        activeTokens.length > 0
          ? `You are a helpful AI assistant. The user message or conversation context contains privacy-protected tokens: ${activeTokens.join(', ')}. Each of those exact tokens represents a real, verified value temporarily masked for privacy. Treat ONLY those exact tokens as valid complete data, preserve them verbatim wherever relevant, and NEVER ask the user to replace, clarify, or provide unmasked values. Do NOT invent or output any other bracketed placeholder tokens that were not provided.`
          : 'You are a helpful AI assistant. Respond naturally, directly, and completely in the user language. Never invent or output bracketed placeholder tokens such as [NID_1], [PHONE_1], [EMAIL_1], or [ADDRESS_1].';

      // ---------------------------------------------------------------------
      // 4. CALL EXTERNAL AI WITH SANITIZED PROMPT & RE-IDENTIFY IN MEMORY
      // ---------------------------------------------------------------------
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        res.write(
          `event: meta\ndata: ${JSON.stringify({
            conversationId: activeConvId,
            userMessageId: userMsgId,
            sanitizedPrompt: dlpResult.sanitizedText,
            redactions: dlpResult.redactions,
            provider,
            model,
          })}\n\n`
        );

        const reidentifier = new StreamingReidentifier(placeholderMap);
        let sanitizedAssistantText = '';

        try {
          sanitizedAssistantText = await streamSanitizedToProvider({
            provider,
            model,
            sanitizedPrompt: dlpResult.sanitizedText,
            systemInstruction: effectiveSystemInstruction,
            history: historyForModel,
            customEndpointUrl: settings.customEndpointUrl,
            onChunk: (chunk) => {
              const reidentified = reidentifier.push(chunk);
              if (reidentified) {
                res.write(`event: delta\ndata: ${JSON.stringify({ text: reidentified })}\n\n`);
              }
            },
          });

          const tail = reidentifier.flush();
          if (tail) {
            res.write(`event: delta\ndata: ${JSON.stringify({ text: tail })}\n\n`);
          }

          const latencyMs = Date.now() - startMs;
          const assistantMsgId = `msg_${crypto.randomUUID().slice(0, 10)}`;
          // Persist ONLY the sanitized response (with placeholders, zero raw PII)
          db.prepare(`
            INSERT INTO messages (
              id, conversation_id, user_id, role, sanitized_content,
              redaction_count, redacted_types_json, latency_ms, created_at
            ) VALUES (?, ?, ?, 'assistant', ?, 0, '[]', ?, ?)
          `).run(assistantMsgId, activeConvId, user.id, sanitizedAssistantText, latencyMs, new Date().toISOString());

          res.write(
            `event: done\ndata: ${JSON.stringify({
              conversationId: activeConvId,
              messageId: assistantMsgId,
              sanitizedAnswer: sanitizedAssistantText,
              latencyMs,
              reidentifiedCount: placeholderMap.size,
            })}\n\n`
          );
          res.end();
        } catch (providerErr) {
          const msg = providerErr instanceof Error ? providerErr.message : 'Upstream provider error';
          res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
          res.end();
        }
        return;
      }

      // Non-streaming JSON mode (also used by automated tests)
      let sanitizedAssistantText = '';
      sanitizedAssistantText = await streamSanitizedToProvider({
        provider,
        model,
        sanitizedPrompt: dlpResult.sanitizedText,
        systemInstruction: effectiveSystemInstruction,
        history: historyForModel,
        customEndpointUrl: settings.customEndpointUrl,
        onChunk: () => {
          // Collected via return value
        },
      });

      const latencyMs = Date.now() - startMs;
      const assistantMsgId = `msg_${crypto.randomUUID().slice(0, 10)}`;
      db.prepare(`
        INSERT INTO messages (
          id, conversation_id, user_id, role, sanitized_content,
          redaction_count, redacted_types_json, latency_ms, created_at
        ) VALUES (?, ?, ?, 'assistant', ?, 0, '[]', ?, ?)
      `).run(assistantMsgId, activeConvId, user.id, sanitizedAssistantText, latencyMs, new Date().toISOString());

      const finalAnswer = reidentifyText(sanitizedAssistantText, placeholderMap);

      res.status(200).json({
        conversationId: activeConvId,
        messageId: assistantMsgId,
        answer: finalAnswer,
        sanitizedPrompt: dlpResult.sanitizedText,
        sanitizedAnswer: sanitizedAssistantText,
        redactions: dlpResult.redactions,
        latencyMs,
        provider,
        model,
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Upstream AI provider failure.',
      });
    } finally {
      // Ephemeral PII map is strictly purged from memory after request completes
      placeholderMap.clear();
    }
  });

  // =========================================================================
  // Conversation History API (Sanitized-only)
  // =========================================================================
  app.get('/api/conversations', requireAuth, (req: AuthenticatedRequest, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const rows = db
      .prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
               (SELECT COALESCE(SUM(m.redaction_count), 0) FROM messages m WHERE m.conversation_id = c.id) AS total_redactions,
               (SELECT m.sanitized_content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at ASC LIMIT 1) AS first_prompt
        FROM conversations c
        WHERE c.user_id = ?
        ORDER BY c.updated_at DESC
      `)
      .all(req.user!.id) as Array<Record<string, unknown>>;

    const filtered = query
      ? rows.filter((r) => {
          const title = String(r.title || '').toLowerCase();
          const firstPrompt = String(r.first_prompt || '').toLowerCase();
          return title.includes(query) || firstPrompt.includes(query);
        })
      : rows;

    res.status(200).json({ conversations: filtered });
  });

  app.get('/api/conversations/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const conv = db
      .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user!.id) as Record<string, unknown> | undefined;
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    const messages = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(req.params.id);

    res.status(200).json({ conversation: conv, messages });
  });

  app.delete('/api/conversations/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const convId = String(req.params.id);
    const info = db
      .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
      .run(convId, req.user!.id);
    if (Number(info.changes) === 0) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    sessionPlaceholderCache.delete(convId);
    res.status(200).json({ ok: true });
  });

  // =========================================================================
  // Provider & Settings API
  // =========================================================================
  app.get('/api/providers/status', requireAuth, (_req, res) => {
    const settings = getSecuritySettings();
    res.status(200).json({
      providers: getProviderStatuses(settings.customEndpointUrl),
      settings,
    });
  });

  app.post('/api/providers/test', requireAuth, async (req, res) => {
    const settings = getSecuritySettings();
    const { provider, model, customEndpointUrl } = req.body as {
      provider?: ProviderId;
      model?: string;
      customEndpointUrl?: string;
    };

    const result = await testProviderConnectivity(
      provider || settings.activeProvider,
      model || settings.activeModel,
      customEndpointUrl ?? settings.customEndpointUrl
    );
    res.status(result.ok ? 200 : 502).json(result);
  });

  app.get('/api/settings', requireAuth, (_req, res) => {
    res.status(200).json({ settings: getSecuritySettings() });
  });

  app.put('/api/settings', requireAuth, (req: AuthenticatedRequest, res) => {
    const prev = getSecuritySettings();
    const next = updateSecuritySettings(req.body);

    if (prev.dlpEnabled !== next.dlpEnabled) {
      recordAuditLog({
        userId: req.user!.id,
        userEmail: req.user!.email,
        eventType: 'DLP_MODE_CHANGED',
        severity: next.dlpEnabled ? 'info' : 'critical',
        provider: 'airlock-dlp',
        model: 'local-engine',
        entityTypes: [next.dlpEnabled ? 'DLP_ONLINE' : 'DLP_OFFLINE'],
        sanitizedSnippet: next.dlpEnabled
          ? 'Local DLP engine restored online.'
          : 'Local DLP engine set offline (Fail-Closed 503 mode active).',
        httpStatus: 200,
        source: 'admin',
      });
    }

    res.status(200).json({
      settings: next,
      providers: getProviderStatuses(next.customEndpointUrl),
    });
  });

  // =========================================================================
  // Security & Audit Center API
  // =========================================================================
  app.get('/api/audit-logs', requireAuth, (req, res) => {
    const typeFilter = typeof req.query.type === 'string' ? req.query.type : 'ALL';
    const severityFilter = typeof req.query.severity === 'string' ? req.query.severity : 'ALL';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

    const rows = db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 250')
      .all() as Array<Record<string, unknown>>;

    const filtered = rows.filter((row) => {
      if (typeFilter !== 'ALL' && row.event_type !== typeFilter) return false;
      if (severityFilter !== 'ALL' && row.severity !== severityFilter) return false;
      if (q) {
        const hay = `${row.user_email} ${row.event_type} ${row.sanitized_snippet} ${row.entity_types_json}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const summary = {
      total: rows.length,
      redactions: rows.filter((r) => r.event_type === 'PII_REDACTED').length,
      injectionsBlocked: rows.filter((r) => r.event_type === 'INJECTION_BLOCKED').length,
      failClosedBlocks: rows.filter((r) => r.event_type === 'FAIL_CLOSED_503').length,
      mcpCalls: rows.filter((r) => r.source === 'mcp').length,
    };

    res.status(200).json({ logs: filtered, summary });
  });

  app.get('/api/security/zero-pii-scan', requireAuth, (_req, res) => {
    const report = scanDatabaseForRawPii();
    res.status(200).json(report);
  });

  // Dry-run local DLP inspector endpoint (no LLM call; lets users preview redaction safely)
  app.post('/api/security/inspect-preview', requireAuth, (req, res) => {
    const { text } = req.body as { text?: string };
    const settings = getSecuritySettings();
    if (!text) {
      res.status(400).json({ error: 'Text is required.' });
      return;
    }
    try {
      const dlp = inspectAndRedact(text, {
        dlpEnabled: settings.dlpEnabled,
        sensitivity: settings.dlpSensitivity,
      });
      const inj = scanPromptInjection(text, { enabled: settings.injectionBlockingEnabled });
      dlp.placeholderMap.clear();
      res.status(200).json({
        sanitizedText: dlp.sanitizedText,
        redactions: dlp.redactions,
        injection: inj,
      });
    } catch (err) {
      res.status(503).json({
        error: err instanceof Error ? err.message : 'Fail-Closed (503): DLP engine offline.',
      });
    }
  });

  // =========================================================================
  // Enterprise Admin User Management
  // =========================================================================
  app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as unknown as UserRecord[];
    res.status(200).json({ users: rows.map(toPublicUser) });
  });

  app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
    const { email, name, password, role = 'member' } = req.body as {
      email?: string;
      name?: string;
      password?: string;
      role?: UserRole;
    };
    if (!email || !name || !password || password.length < 8) {
      res.status(400).json({ error: 'Name, valid email, and password (min 8 chars) required.' });
      return;
    }
    const cleanEmail = email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail);
    if (existing) {
      res.status(409).json({ error: 'User with this email already exists.' });
      return;
    }

    const id = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, email, name, role, password_hash, two_factor_enabled, two_factor_code, active, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)
    `).run(id, cleanEmail, name.trim(), role, hashPassword(password), encryptValue('614290'), now);

    const created = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRecord;
    res.status(201).json({ user: toPublicUser(created) });
  });

  app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req: AuthenticatedRequest, res) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as unknown as UserRecord | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const { role, active } = req.body as { role?: UserRole; active?: boolean };
    if (target.id === req.user!.id && active === false) {
      res.status(400).json({ error: 'You cannot deactivate your own active administrator account.' });
      return;
    }
    const nextRole = role ?? (target.role as UserRole);
    const nextActive = typeof active === 'boolean' ? (active ? 1 : 0) : target.active;
    db.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(nextRole, nextActive, target.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id) as unknown as UserRecord;
    res.status(200).json({ user: toPublicUser(updated) });
  });

  // =========================================================================
  // MCP (Model Context Protocol) Gateway Endpoints
  // =========================================================================
  app.get('/api/mcp/sse', handleMcpSseConnect);
  app.post('/api/mcp/message', handleMcpMessage);
  app.post('/api/mcp/test', requireAuth, (req: AuthenticatedRequest, res) => {
    const rpc = req.body as { jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown> };
    const { status, body } = processMcpJsonRpc(rpc, req.user!.email, req.user!.id);
    res.status(status).json(body);
  });

  return app;
}

async function startServer() {
  const app = createApp();

  if (IS_PROD) {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('/{*splat}', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AirLock Gateway listening on http://0.0.0.0:${PORT}`);
  });
}

// Start HTTP server unless imported directly by test runner
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]).endsWith('server.ts');
if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start AirLock server:', err);
    process.exit(1);
  });
}
