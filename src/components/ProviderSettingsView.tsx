import { useState } from 'react';
import { CheckCircle2, Play, Server, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import type { ProviderId, ProviderStatusInfo, SecuritySettings } from '../types';

interface ProviderSettingsViewProps {
  settings: SecuritySettings;
  providers: ProviderStatusInfo[];
  onUpdated: (settings: SecuritySettings, providers: ProviderStatusInfo[]) => void;
}

export function ProviderSettingsView({ settings, providers, onUpdated }: ProviderSettingsViewProps) {
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(settings.activeProvider);
  const [selectedModel, setSelectedModel] = useState(settings.activeModel);
  const [customEndpointUrl, setCustomEndpointUrl] = useState(settings.customEndpointUrl);
  const [systemPolicyPrompt, setSystemPolicyPrompt] = useState(settings.systemPolicyPrompt);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; detail: string } | null>(null);

  const currentProviderObj = providers.find((p) => p.id === selectedProvider) || providers[0];

  function handleSelectProvider(id: ProviderId) {
    setSelectedProvider(id);
    const found = providers.find((p) => p.id === id);
    if (found && found.models.length > 0) {
      setSelectedModel(found.models[0].id);
    }
    setTestResult(null);
    setSaveNotice(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveNotice(null);
    try {
      const res = await api.updateSettings({
        activeProvider: selectedProvider,
        activeModel: selectedModel,
        customEndpointUrl,
        systemPolicyPrompt,
      });
      onUpdated(res.settings, res.providers);
      setSaveNotice(`Active gateway target saved: ${selectedProvider} / ${selectedModel}`);
    } catch (err) {
      setSaveNotice(err instanceof Error ? err.message : 'Failed to save provider settings.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testProvider({
        provider: selectedProvider,
        model: selectedModel,
        customEndpointUrl,
      });
      setTestResult(res);
    } catch (err) {
      setTestResult({
        ok: false,
        latencyMs: 0,
        detail: err instanceof Error ? err.message : 'Connection check failed.',
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-100">
            AI Providers &amp; Model Routing
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Configure which external or self-hosted model receives sanitized prompts. Provider credentials remain strictly in server environment variables and are never exposed to the browser.
          </p>
        </div>

        {/* Provider Selection Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {providers.map((provider) => {
            const isSelected = selectedProvider === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => handleSelectProvider(provider.id)}
                className={`text-left p-5 rounded-xl border transition-colors ${
                  isSelected
                    ? 'border-blue-600 dark:border-blue-500 bg-blue-50/40 dark:bg-blue-950/20'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <Server className="w-4 h-4 text-slate-700 dark:text-slate-300" />
                    <span className="font-display font-semibold text-sm text-slate-900 dark:text-slate-100">
                      {provider.name}
                    </span>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-medium ${
                      provider.configured
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {provider.configured ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Configured</span>
                      </>
                    ) : (
                      <>
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Env Missing</span>
                      </>
                    )}
                  </span>
                </div>

                <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">{provider.note}</p>
                <div className="mt-3 text-xs text-slate-500 dark:text-slate-400 font-mono">
                  Server variable: {provider.envVar}
                </div>
              </button>
            );
          })}
        </div>

        {/* Model & Gateway Policy Form */}
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label htmlFor="model-select" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Target Model
              </label>
              <select
                id="model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                {currentProviderObj?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.tier})
                  </option>
                ))}
              </select>
            </div>

            {selectedProvider === 'custom' && (
              <div>
                <label htmlFor="custom-url" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Self-Hosted OpenAI-Compatible Base URL
                </label>
                <input
                  id="custom-url"
                  type="url"
                  value={customEndpointUrl}
                  onChange={(e) => setCustomEndpointUrl(e.target.value)}
                  placeholder="http://127.0.0.1:11434/v1"
                  className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                />
              </div>
            )}
          </div>

          <div>
            <label htmlFor="policy-prompt" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Gateway System Guardrail Instruction
            </label>
            <textarea
              id="policy-prompt"
              rows={3}
              value={systemPolicyPrompt}
              onChange={(e) => setSystemPolicyPrompt(e.target.value)}
              className="w-full px-3.5 py-2.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            />
          </div>

          {testResult && (
            <div
              role="status"
              className={`p-3.5 rounded-lg border text-xs ${
                testResult.ok
                  ? 'border-emerald-300 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200'
                  : 'border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-900 dark:text-red-200'
              }`}
            >
              <div className="font-semibold">
                {testResult.ok ? `Connection verified (${testResult.latencyMs}ms)` : 'Connection check failed'}
              </div>
              <div className="mt-1 font-mono break-words">{testResult.detail}</div>
            </div>
          )}

          {saveNotice && (
            <div className="text-xs font-medium text-blue-700 dark:text-blue-300">{saveNotice}</div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => void handleTestConnection()}
              disabled={testing}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{testing ? 'Probing gateway...' : 'Test connection'}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors whitespace-nowrap"
            >
              {saving ? 'Saving...' : 'Save routing policy'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
