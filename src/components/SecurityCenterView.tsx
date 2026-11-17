import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../lib/api';
import type { AuditLogEntry, AuditSummary, SecuritySettings } from '../types';

interface SecurityCenterViewProps {
  settings: SecuritySettings;
  onSettingsUpdated: (next: SecuritySettings) => void;
}

const EVENT_TYPES = [
  { id: 'ALL', label: 'All events' },
  { id: 'PII_REDACTED', label: 'PII Redacted' },
  { id: 'INJECTION_BLOCKED', label: 'Injection Blocked' },
  { id: 'FAIL_CLOSED_503', label: 'Fail-Closed 503' },
  { id: 'MCP_TOOL_CALL', label: 'MCP Tool Call' },
  { id: 'RATE_LIMITED', label: 'Rate Limited' },
];

export function SecurityCenterView({ settings, onSettingsUpdated }: SecurityCenterViewProps) {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [summary, setSummary] = useState<AuditSummary>({
    total: 0,
    redactions: 0,
    injectionsBlocked: 0,
    failClosedBlocks: 0,
    mcpCalls: 0,
  });
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [togglingDlp, setTogglingDlp] = useState(false);

  const [zeroScan, setZeroScan] = useState<{
    clean: boolean;
    scannedMessages: number;
    scannedAuditLogs: number;
    findingsCount: number;
  } | null>(null);
  const [scanningDb, setScanningDb] = useState(false);

  const [dryRunInput, setDryRunInput] = useState('Amar NID 1234567890 ar bKash 01812345678 verify koro');
  const [dryRunResult, setDryRunResult] = useState<{
    sanitizedText?: string;
    redactions?: Array<{ placeholder: string; category: string; language: string }>;
    injection?: { blocked: boolean; category?: string };
    error?: string;
  } | null>(null);

  async function loadAudit(nextType = typeFilter, nextQuery = search) {
    setLoading(true);
    try {
      const res = await api.getAuditLogs({ type: nextType, q: nextQuery });
      setLogs(res.logs);
      setSummary(res.summary);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleToggleDlp() {
    setTogglingDlp(true);
    try {
      const res = await api.updateSettings({ dlpEnabled: !settings.dlpEnabled });
      onSettingsUpdated(res.settings);
      await loadAudit();
    } finally {
      setTogglingDlp(false);
    }
  }

  async function handleZeroPiiScan() {
    setScanningDb(true);
    try {
      const res = await api.runZeroPiiScan();
      setZeroScan(res);
    } finally {
      setScanningDb(false);
    }
  }

  async function handleDryRun() {
    setDryRunResult(null);
    try {
      const res = await api.inspectPreview(dryRunInput);
      setDryRunResult(res);
    } catch (err) {
      setDryRunResult({ error: err instanceof Error ? err.message : 'Fail-Closed 503' });
    }
  }

  function handleExportCsv() {
    const header = 'timestamp,event_type,severity,source,user_email,provider,model,http_status,entities,sanitized_snippet\n';
    const rows = logs
      .map((l) => {
        const snippet = `"${String(l.sanitized_snippet || '').replaceAll('"', '""')}"`;
        const entities = `"${String(l.entity_types_json || '[]').replaceAll('"', '""')}"`;
        return `${l.created_at},${l.event_type},${l.severity},${l.source},${l.user_email},${l.provider},${l.model},${l.http_status},${entities},${snippet}`;
      })
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `airlock-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-100">
              Security &amp; Audit Center
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Sanitized audit trail of DLP redactions, blocked prompt injections, and fail-closed enforcement events.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void loadAudit()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* Summary Metrics Row */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
            <div className="text-xs text-slate-500 dark:text-slate-400">Audit Events</div>
            <div className="mt-1 font-display text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {summary.total}
            </div>
          </div>
          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
            <div className="text-xs text-slate-500 dark:text-slate-400">PII Redactions</div>
            <div className="mt-1 font-display text-2xl font-semibold tabular-nums text-amber-700 dark:text-amber-400">
              {summary.redactions}
            </div>
          </div>
          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
            <div className="text-xs text-slate-500 dark:text-slate-400">Injections Blocked</div>
            <div className="mt-1 font-display text-2xl font-semibold tabular-nums text-red-700 dark:text-red-400">
              {summary.injectionsBlocked}
            </div>
          </div>
          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
            <div className="text-xs text-slate-500 dark:text-slate-400">Fail-Closed 503</div>
            <div className="mt-1 font-display text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {summary.failClosedBlocks}
            </div>
          </div>
          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
            <div className="text-xs text-slate-500 dark:text-slate-400">MCP Guarded Calls</div>
            <div className="mt-1 font-display text-2xl font-semibold tabular-nums text-blue-700 dark:text-blue-400">
              {summary.mcpCalls}
            </div>
          </div>
        </div>

        {/* Interactive Security Controls: Fail-Closed Simulator + Zero-PII DB Scanner + Dry-Run Inspector */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <section className="lg:col-span-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-5">
            <div>
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Fail-Closed DLP Control
                </h2>
                <span
                  className={`inline-flex items-center gap-1 text-xs font-medium ${
                    settings.dlpEnabled
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-red-700 dark:text-red-400'
                  }`}
                >
                  {settings.dlpEnabled ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
                  <span>{settings.dlpEnabled ? 'Engine Online' : 'Simulated Offline (503)'}</span>
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Simulate a local DLP service crash to verify AirLock&apos;s fail-closed policy. When offline, all AI chat and MCP requests immediately return HTTP 503 without calling external providers.
              </p>
              <button
                type="button"
                onClick={() => void handleToggleDlp()}
                disabled={togglingDlp}
                className={`mt-4 w-full py-2 px-4 text-xs font-medium rounded-lg border transition-colors ${
                  settings.dlpEnabled
                    ? 'border-red-300 dark:border-red-900 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30'
                    : 'border-emerald-300 dark:border-emerald-900 bg-emerald-600 text-white hover:bg-emerald-700'
                }`}
              >
                {settings.dlpEnabled ? 'Simulate DLP Engine Crash (Trigger 503)' : 'Restore Local DLP Engine'}
              </button>
            </div>

            <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  SQLite Zero-PII Audit Scan
                </span>
                <button
                  type="button"
                  onClick={() => void handleZeroPiiScan()}
                  disabled={scanningDb}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  <Database className="w-3.5 h-3.5" />
                  <span>{scanningDb ? 'Scanning...' : 'Scan database'}</span>
                </button>
              </div>
              {zeroScan && (
                <div className="mt-2.5 text-xs flex items-center gap-2 text-slate-700 dark:text-slate-300 font-mono tabular-nums">
                  {zeroScan.clean ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                  )}
                  <span>
                    {zeroScan.clean ? 'CLEAN: 0 raw PII findings' : `${zeroScan.findingsCount} findings`} ({zeroScan.scannedMessages} msgs · {zeroScan.scannedAuditLogs} logs)
                  </span>
                </div>
              )}
            </div>
          </section>

          <section className="lg:col-span-7 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Local DLP &amp; Injection Dry-Run Inspector
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Test Bangla, Banglish, or English strings locally without calling an external LLM.
            </p>
            <textarea
              rows={2}
              value={dryRunInput}
              onChange={(e) => setDryRunInput(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleDryRun()}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
              >
                Run local inspection
              </button>
            </div>

            {dryRunResult && (
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs space-y-1.5">
                {dryRunResult.error ? (
                  <div className="text-red-700 dark:text-red-400 font-medium">{dryRunResult.error}</div>
                ) : (
                  <>
                    <div className="text-slate-500 dark:text-slate-400">
                      Sanitized Output:{' '}
                      <span className="font-mono text-slate-900 dark:text-slate-100">
                        {dryRunResult.sanitizedText}
                      </span>
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 font-mono">
                      Redactions: {dryRunResult.redactions?.map((r) => `${r.placeholder}(${r.category})`).join(', ') || 'None'} · Injection Blocked:{' '}
                      {dryRunResult.injection?.blocked ? `YES (${dryRunResult.injection.category})` : 'NO'}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        </div>

        {/* Audit Log Table */}
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg">
              {EVENT_TYPES.map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => {
                    setTypeFilter(ev.id);
                    void loadAudit(ev.id, search);
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    typeFilter === ev.id
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {ev.label}
                </button>
              ))}
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  void loadAudit(typeFilter, e.target.value);
                }}
                placeholder="Search sanitized logs..."
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-900/50">
                  <th className="py-2.5 px-4 font-medium">Timestamp</th>
                  <th className="py-2.5 px-4 font-medium">Event</th>
                  <th className="py-2.5 px-4 font-medium">Actor</th>
                  <th className="py-2.5 px-4 font-medium">Entities</th>
                  <th className="py-2.5 px-4 font-medium">Sanitized Snippet</th>
                  <th className="py-2.5 px-4 font-medium text-right">HTTP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-8 px-4 text-center text-slate-500">
                      Loading audit records...
                    </td>
                  </tr>
                ) : logs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 px-4 text-center text-slate-500">
                      No audit events match the active filter.
                    </td>
                  </tr>
                ) : (
                  logs.map((row) => {
                    const entities = JSON.parse(row.entity_types_json || '[]') as string[];
                    const severityColor =
                      row.severity === 'critical'
                        ? 'text-red-700 dark:text-red-400 font-semibold'
                        : row.severity === 'warning'
                          ? 'text-amber-700 dark:text-amber-400 font-medium'
                          : 'text-slate-700 dark:text-slate-300';
                    return (
                      <tr key={row.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-900/40">
                        <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {new Date(row.created_at).toLocaleString()}
                        </td>
                        <td className={`py-2.5 px-4 whitespace-nowrap ${severityColor}`}>
                          {row.event_type} · {row.source}
                        </td>
                        <td className="py-2.5 px-4 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {row.user_email}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          {entities.length > 0 ? entities.join(', ') : '—'}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-800 dark:text-slate-200 max-w-md truncate">
                          {row.sanitized_snippet}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {row.http_status}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
