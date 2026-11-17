import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { db, getSecuritySettings, recordAuditLog } from './db.ts';
import { inspectAndRedact } from './dlp.ts';
import { scanPromptInjection } from './injection.ts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const sseClients = new Map<string, Response>();

export function handleMcpSseConnect(req: Request, res: Response): void {
  const settings = getSecuritySettings();
  if (!settings.mcpGatewayEnabled) {
    res.status(503).json({ error: 'MCP Gateway is disabled by administrator policy.' });
    return;
  }

  const sessionId = crypto.randomUUID();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.set(sessionId, res);

  // Per MCP SSE spec, emit endpoint event telling client where to POST JSON-RPC messages
  res.write(`event: endpoint\ndata: /api/mcp/message?sessionId=${sessionId}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 20_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(sessionId);
  });
}

export function processMcpJsonRpc(
  rpc: JsonRpcRequest,
  actorEmail = 'mcp-agent@airlock.local',
  actorId = 'mcp_agent'
): { status: number; body: Record<string, unknown> } {
  const settings = getSecuritySettings();
  const rpcId = rpc.id ?? null;

  if (!settings.mcpGatewayEnabled) {
    return {
      status: 503,
      body: {
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32003, message: 'AirLock MCP Gateway is currently disabled.' },
      },
    };
  }

  if (rpc.method === 'initialize') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'airlock-mcp-guardrail',
            version: '1.0.0',
          },
        },
      },
    };
  }

  if (rpc.method === 'tools/list') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          tools: [
            {
              name: 'airlock_inspect_text',
              description:
                'Inspects text or file snippets through AirLock local Bangla/Banglish/English DLP and prompt-injection scanner before an IDE agent sends context externally.',
              inputSchema: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Raw text or file content to inspect and sanitize.' },
                },
                required: ['text'],
              },
            },
            {
              name: 'airlock_safe_prompt',
              description:
                'Sanitizes an agent prompt, blocks prompt injections, and returns placeholder-safe text plus detected entity categories.',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', description: 'Agent prompt to inspect and redact.' },
                },
                required: ['prompt'],
              },
            },
            {
              name: 'airlock_audit_summary',
              description:
                'Returns sanitized recent security audit summary counts without exposing any sensitive content.',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
          ],
        },
      },
    };
  }

  if (rpc.method === 'tools/call') {
    const toolName = String(rpc.params?.name || '');
    const args = (rpc.params?.arguments || {}) as Record<string, unknown>;

    if (toolName === 'airlock_audit_summary') {
      const counts = db
        .prepare(`
          SELECT event_type, COUNT(*) as count
          FROM audit_logs
          GROUP BY event_type
        `)
        .all() as Array<{ event_type: string; count: number }>;

      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ dlpEnabled: settings.dlpEnabled, counts }, null, 2) }],
          },
        },
      };
    }

    if (toolName === 'airlock_inspect_text' || toolName === 'airlock_safe_prompt') {
      const inputText = String(args.text ?? args.prompt ?? '');
      if (!inputText.trim()) {
        return {
          status: 400,
          body: {
            jsonrpc: '2.0',
            id: rpcId,
            error: { code: -32602, message: 'Missing required text/prompt argument.' },
          },
        };
      }

      // 1. Fail-closed DLP check
      let dlpRes;
      try {
        dlpRes = inspectAndRedact(inputText, {
          dlpEnabled: settings.dlpEnabled,
          sensitivity: settings.dlpSensitivity,
        });
      } catch {
        recordAuditLog({
          userId: actorId,
          userEmail: actorEmail,
          eventType: 'FAIL_CLOSED_503',
          severity: 'critical',
          provider: 'mcp-gateway',
          model: toolName,
          entityTypes: ['DLP_OFFLINE'],
          sanitizedSnippet: 'MCP tool call blocked fail-closed: local DLP engine unavailable.',
          httpStatus: 503,
          source: 'mcp',
        });
        return {
          status: 503,
          body: {
            jsonrpc: '2.0',
            id: rpcId,
            error: {
              code: -32000,
              message: 'Fail-Closed (503): Local AirLock DLP engine is unavailable. MCP tool call blocked.',
            },
          },
        };
      }

      // 2. Prompt-injection scan
      const inj = scanPromptInjection(inputText, { enabled: settings.injectionBlockingEnabled });
      if (inj.blocked) {
        recordAuditLog({
          userId: actorId,
          userEmail: actorEmail,
          eventType: 'INJECTION_BLOCKED',
          severity: 'critical',
          provider: 'mcp-gateway',
          model: toolName,
          entityTypes: [inj.ruleName || 'PROMPT_INJECTION'],
          sanitizedSnippet: `Blocked MCP injection (${inj.category}): ${dlpRes.sanitizedText.slice(0, 140)}`,
          httpStatus: 400,
          source: 'mcp',
        });
        return {
          status: 400,
          body: {
            jsonrpc: '2.0',
            id: rpcId,
            error: {
              code: -32001,
              message: `Prompt blocked (400): malicious instruction detected (${inj.category}).`,
            },
          },
        };
      }

      const categories = Array.from(new Set(dlpRes.redactions.map((r) => r.category)));
      recordAuditLog({
        userId: actorId,
        userEmail: actorEmail,
        eventType: 'MCP_TOOL_CALL',
        severity: categories.length > 0 ? 'warning' : 'info',
        provider: 'mcp-gateway',
        model: toolName,
        entityTypes: categories,
        sanitizedSnippet: dlpRes.sanitizedText.slice(0, 220),
        httpStatus: 200,
        source: 'mcp',
      });

      // Ephemeral map cleared immediately — MCP agent receives ONLY sanitized text
      dlpRes.placeholderMap.clear();

      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    sanitizedText: dlpRes.sanitizedText,
                    redactionsCount: dlpRes.redactions.length,
                    categories,
                    blocked: false,
                  },
                  null,
                  2
                ),
              },
            ],
          },
        },
      };
    }

    return {
      status: 404,
      body: {
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32601, message: `Unknown MCP tool: ${toolName}` },
      },
    };
  }

  return {
    status: 400,
    body: {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32601, message: `Unsupported MCP method: ${rpc.method}` },
    },
  };
}

export function handleMcpMessage(req: Request, res: Response): void {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  const rpc = req.body as JsonRpcRequest;
  const { status, body } = processMcpJsonRpc(rpc);

  if (sessionId && sseClients.has(sessionId)) {
    const client = sseClients.get(sessionId)!;
    client.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
  }

  res.status(status).json(body);
}
