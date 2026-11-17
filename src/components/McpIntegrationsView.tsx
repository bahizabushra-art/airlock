import { useState } from 'react';
import { Check, Copy, Play, Terminal } from 'lucide-react';
import { api } from '../lib/api';
import type { SecuritySettings } from '../types';

interface McpIntegrationsViewProps {
  settings: SecuritySettings;
  onSettingsUpdated: (next: SecuritySettings) => void;
}

export function McpIntegrationsView({ settings, onSettingsUpdated }: McpIntegrationsViewProps) {
  const [toggling, setToggling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toolName, setToolName] = useState<'airlock_inspect_text' | 'airlock_safe_prompt' | 'airlock_audit_summary'>(
    'airlock_inspect_text'
  );
  const [samplePayload, setSamplePayload] = useState(
    'Reading config: customer NID 1234567890, contact rahim@example.com, phone +8801711223344'
  );
  const [rpcOutput, setRpcOutput] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  const cursorConfig = JSON.stringify(
    {
      mcpServers: {
        'airlock-guardrail': {
          url: `${origin}/api/mcp/sse`,
          transport: 'sse',
        },
      },
    },
    null,
    2
  );

  async function handleToggleMcp() {
    setToggling(true);
    try {
      const res = await api.updateSettings({ mcpGatewayEnabled: !settings.mcpGatewayEnabled });
      onSettingsUpdated(res.settings);
    } finally {
      setToggling(false);
    }
  }

  function handleCopyConfig() {
    void navigator.clipboard.writeText(cursorConfig);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRunTool(method: 'tools/list' | 'tools/call') {
    setRunning(true);
    setRpcOutput(null);
    try {
      const rpc =
        method === 'tools/list'
          ? { jsonrpc: '2.0' as const, id: Date.now(), method: 'tools/list' }
          : {
              jsonrpc: '2.0' as const,
              id: Date.now(),
              method: 'tools/call',
              params: {
                name: toolName,
                arguments:
                  toolName === 'airlock_audit_summary'
                    ? {}
                    : toolName === 'airlock_safe_prompt'
                      ? { prompt: samplePayload }
                      : { text: samplePayload },
              },
            };

      const res = await api.testMcpRpc(rpc);
      setRpcOutput(JSON.stringify(res, null, 2));
    } catch (err) {
      setRpcOutput(
        JSON.stringify(
          { error: err instanceof Error ? err.message : 'MCP RPC invocation failed' },
          null,
          2
        )
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-100">
              MCP Agent Gateway
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Route Cursor, Claude Code, and IDE agent tool calls through AirLock&apos;s fail-closed DLP and prompt-injection guardrail over HTTP SSE.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleToggleMcp()}
            disabled={toggling}
            className={`px-4 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              settings.mcpGatewayEnabled
                ? 'border-emerald-300 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300'
            }`}
          >
            {settings.mcpGatewayEnabled ? 'MCP Gateway Enabled (Click to Disable)' : 'Enable MCP Gateway'}
          </button>
        </div>

        {/* Configuration Snippet */}
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Cursor &amp; Claude Code Configuration
              </h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Add to <span className="font-mono">~/.cursor/mcp.json</span> or your Claude Code MCP servers manifest.
              </p>
            </div>
            <button
              type="button"
              onClick={handleCopyConfig}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy JSON'}</span>
            </button>
          </div>

          <pre className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-mono text-slate-800 dark:text-slate-200 overflow-x-auto">
            {cursorConfig}
          </pre>

          <div className="text-xs text-slate-600 dark:text-slate-400 space-y-1">
            <div>
              SSE Transport: <span className="font-mono text-slate-900 dark:text-slate-200">GET {origin}/api/mcp/sse</span>
            </div>
            <div>
              JSON-RPC Endpoint: <span className="font-mono text-slate-900 dark:text-slate-200">POST {origin}/api/mcp/message</span>
            </div>
          </div>
        </section>

        {/* Live MCP Tool Call Sandbox */}
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Live MCP JSON-RPC Inspector
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="mcp-tool" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                MCP Tool
              </label>
              <select
                id="mcp-tool"
                value={toolName}
                onChange={(e) => setToolName(e.target.value as typeof toolName)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="airlock_inspect_text">airlock_inspect_text</option>
                <option value="airlock_safe_prompt">airlock_safe_prompt</option>
                <option value="airlock_audit_summary">airlock_audit_summary</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label htmlFor="mcp-payload" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Tool Input Argument
              </label>
              <input
                id="mcp-payload"
                type="text"
                disabled={toolName === 'airlock_audit_summary'}
                value={samplePayload}
                onChange={(e) => setSamplePayload(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 disabled:opacity-50"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void handleRunTool('tools/list')}
              disabled={running}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              Call tools/list
            </button>
            <button
              type="button"
              onClick={() => void handleRunTool('tools/call')}
              disabled={running}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{running ? 'Invoking...' : 'Invoke tools/call'}</span>
            </button>
          </div>

          {rpcOutput && (
            <pre className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs font-mono text-slate-800 dark:text-slate-200 overflow-x-auto max-h-72">
              {rpcOutput}
            </pre>
          )}
        </section>
      </div>
    </div>
  );
}
