import { useState } from 'react';
import { Keyboard, Moon, Shield, Sun } from 'lucide-react';
import { api } from '../lib/api';
import type { DlpSensitivity, SecuritySettings } from '../types';

interface SettingsAdminViewProps {
  settings: SecuritySettings;
  darkMode: boolean;
  onToggleTheme: () => void;
  onSettingsUpdated: (next: SecuritySettings) => void;
}

const SHORTCUTS = [
  { keys: 'Ctrl + Enter / Enter', action: 'Send message to selected AI' },
  { keys: 'Up / Down Arrow', action: 'Navigate previously sent messages' },
  { keys: 'Ctrl + Shift + L', action: 'Toggle Light / Dark theme' },
  { keys: 'Alt + 1 .. 4', action: 'Switch between Chat, AI Models, History, and Settings' },
];

export function SettingsAdminView({
  settings,
  darkMode,
  onToggleTheme,
  onSettingsUpdated,
}: SettingsAdminViewProps) {
  const [dlpEnabled, setDlpEnabled] = useState(settings.dlpEnabled);
  const [sensitivity, setSensitivity] = useState<DlpSensitivity>(settings.dlpSensitivity);
  const [injectionBlocking, setInjectionBlocking] = useState(settings.injectionBlockingEnabled);
  const [rateLimit, setRateLimit] = useState(settings.rateLimitPerMin);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyMessage, setPolicyMessage] = useState<string | null>(null);

  async function handleSavePolicy() {
    setSavingPolicy(true);
    setPolicyMessage(null);
    try {
      const res = await api.updateSettings({
        dlpEnabled,
        dlpSensitivity: sensitivity,
        injectionBlockingEnabled: injectionBlocking,
        rateLimitPerMin: rateLimit,
      });
      onSettingsUpdated(res.settings);
      setPolicyMessage('Settings saved.');
    } catch (err) {
      setPolicyMessage(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSavingPolicy(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Settings
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Customize appearance, sensitive-data protection rules, and keyboard shortcuts.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Appearance */}
          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Appearance
            </h2>

            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-medium text-slate-900 dark:text-slate-100">Theme</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Switch between light and dark mode.
                </div>
              </div>
              <button
                type="button"
                onClick={onToggleTheme}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                <span>{darkMode ? 'Light mode' : 'Dark mode'}</span>
              </button>
            </div>
          </section>

          {/* Sensitive Data Protection Policy */}
          <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Sensitive Data Filtering
              </h2>
            </div>

            <div className="flex items-center justify-between gap-4 py-1">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                Automatic PII Redaction (Fail-Closed)
              </span>
              <input
                type="checkbox"
                aria-label="Toggle automatic PII redaction"
                checked={dlpEnabled}
                onChange={(e) => setDlpEnabled(e.target.checked)}
                className="w-4 h-4 accent-blue-600"
              />
            </div>

            <div>
              <label htmlFor="dlp-sensitivity" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Detection Sensitivity
              </label>
              <select
                id="dlp-sensitivity"
                value={sensitivity}
                onChange={(e) => setSensitivity(e.target.value as DlpSensitivity)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              >
                <option value="strict">Strict (Hides contextual + standalone NIDs, phones, cards)</option>
                <option value="balanced">Balanced (Context-aware keywords + Luhn-verified cards)</option>
              </select>
            </div>

            <div className="flex items-center justify-between gap-4 py-1">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                Block Unsafe Prompt Injections
              </span>
              <input
                type="checkbox"
                aria-label="Toggle prompt injection blocking"
                checked={injectionBlocking}
                onChange={(e) => setInjectionBlocking(e.target.checked)}
                className="w-4 h-4 accent-blue-600"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <label htmlFor="rate-limit" className="font-medium text-slate-700 dark:text-slate-300">
                  Rate Limit (requests/minute)
                </label>
                <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">{rateLimit}/min</span>
              </div>
              <input
                id="rate-limit"
                type="range"
                min={5}
                max={120}
                step={5}
                value={rateLimit}
                onChange={(e) => setRateLimit(Number(e.target.value))}
                className="w-full accent-blue-600"
              />
            </div>

            {policyMessage && (
              <div className="text-xs font-medium text-blue-700 dark:text-blue-300">{policyMessage}</div>
            )}

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => void handleSavePolicy()}
                disabled={savingPolicy}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
              >
                {savingPolicy ? 'Saving...' : 'Save settings'}
              </button>
            </div>
          </section>
        </div>

        {/* Keyboard Shortcuts Reference */}
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <Keyboard className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Keyboard Shortcuts
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {SHORTCUTS.map((s) => (
              <div
                key={s.keys}
                className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-xs"
              >
                <span className="text-slate-700 dark:text-slate-300">{s.action}</span>
                <kbd className="px-2 py-1 font-mono text-[11px] rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 whitespace-nowrap shrink-0">
                  {s.keys}
                </kbd>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
