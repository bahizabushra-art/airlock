import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, Lock, Moon, ShieldCheck, Sun } from 'lucide-react';
import { api } from '../lib/api';
import type { PublicUser } from '../types';
import { AirLockLogo } from './AirLockLogo';

interface LoginViewProps {
  darkMode: boolean;
  onToggleTheme: () => void;
  onAuthenticated: (user: PublicUser) => void;
}

export function LoginView({ darkMode, onToggleTheme, onAuthenticated }: LoginViewProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('admin@airlock.local');
  const [password, setPassword] = useState('AirLockAdmin!2026');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [requires2FA, setRequires2FA] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfoMsg(null);
    setLoading(true);

    try {
      if (mode === 'forgot') {
        const res = await api.forgotPassword(email);
        setInfoMsg(res.message);
        return;
      }

      if (mode === 'register') {
        const res = await api.register({ name, email, password });
        onAuthenticated(res.user);
        return;
      }

      const res = await api.login({
        email,
        password,
        twoFactorCode: requires2FA ? twoFactorCode : undefined,
      });

      if (res.requires2FA) {
        setRequires2FA(true);
        setInfoMsg('Two-factor authentication is enabled on this account. Enter your 6-digit code.');
        return;
      }

      if (res.user) {
        onAuthenticated(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-[#090D16] text-slate-900 dark:text-slate-100">
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E1420]">
        <div className="flex items-center gap-2.5">
          <AirLockLogo className="w-7 h-7" />
          <span className="font-display text-lg font-semibold tracking-tight whitespace-nowrap shrink-0">
            AirLock
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label="Toggle color theme"
          className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          <span>{darkMode ? 'Light theme' : 'Dark theme'}</span>
        </button>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left Distraction-Free Auth Card */}
          <section className="lg:col-span-7 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-8 flex flex-col justify-between">
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                {mode === 'login' && 'Sign in to AirLock Gateway'}
                {mode === 'register' && 'Create workspace account'}
                {mode === 'forgot' && 'Account recovery'}
              </h1>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
                {mode === 'login' && 'Authenticate to route AI prompts through local Bangla, Banglish, and English DLP inspection.'}
                {mode === 'register' && 'Provision a new member seat with fail-closed gateway protection.'}
                {mode === 'forgot' && 'Request recovery guidance from your self-hosted AirLock administrator.'}
              </p>

              {error && (
                <div
                  role="alert"
                  className="mt-5 p-3.5 rounded-lg border border-red-300 dark:border-red-900/70 bg-red-50 dark:bg-red-950/40 text-sm text-red-800 dark:text-red-200"
                >
                  {error}
                </div>
              )}

              {infoMsg && (
                <div
                  role="status"
                  className="mt-5 p-3.5 rounded-lg border border-blue-200 dark:border-blue-900/70 bg-blue-50 dark:bg-blue-950/40 text-sm text-blue-900 dark:text-blue-200"
                >
                  {infoMsg}
                </div>
              )}

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                {mode === 'register' && (
                  <div>
                    <label htmlFor="auth-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Full name
                    </label>
                    <input
                      id="auth-name"
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Farhana Karim"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                    />
                  </div>
                )}

                <div>
                  <label htmlFor="auth-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Work email
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setRequires2FA(false);
                    }}
                    placeholder="you@organization.com"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                  />
                </div>

                {mode !== 'forgot' && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label htmlFor="auth-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                        Password
                      </label>
                      {mode === 'login' && (
                        <button
                          type="button"
                          onClick={() => {
                            setMode('forgot');
                            setError(null);
                            setInfoMsg(null);
                          }}
                          className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          Forgot password?
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <input
                        id="auth-password"
                        type={showPassword ? 'text' : 'password'}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Minimum 8 characters"
                        className="w-full px-3.5 py-2.5 pr-10 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                )}

                {mode === 'login' && requires2FA && (
                  <div>
                    <label htmlFor="auth-2fa" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      2FA Verification Code
                    </label>
                    <input
                      id="auth-2fa"
                      type="text"
                      inputMode="numeric"
                      required
                      value={twoFactorCode}
                      onChange={(e) => setTwoFactorCode(e.target.value)}
                      placeholder="6-digit code"
                      className="w-full px-3.5 py-2.5 text-sm font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white transition-colors whitespace-nowrap"
                >
                  {loading
                    ? 'Verifying...'
                    : mode === 'login'
                      ? requires2FA
                        ? 'Verify 2FA & Sign in'
                        : 'Sign in'
                      : mode === 'register'
                        ? 'Create account'
                        : 'Request recovery instructions'}
                </button>
              </form>
            </div>

            <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400">
              {mode === 'login' ? (
                <span>
                  New team member?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setMode('register');
                      setError(null);
                      setInfoMsg(null);
                    }}
                    className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    Register seat
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                    setInfoMsg(null);
                  }}
                  className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Back to sign in
                </button>
              )}
              <span>Protected by local scrypt + JWT</span>
            </div>
          </section>

          {/* Right Security Model & Demo Credentials Summary */}
          <aside className="lg:col-span-5 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-7 flex flex-col justify-between space-y-6">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Fail-Closed Gateway Architecture
              </h2>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                All prompts pass through AirLock&apos;s local Bangla, Banglish, and English inspection layer before reaching external models. Sensitive identifiers are replaced with transient placeholders and never written to disk.
              </p>

              <div className="mt-5 space-y-3 text-xs text-slate-700 dark:text-slate-300">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <span>Zero-persistence policy: only sanitized placeholders are saved in history and audit logs.</span>
                </div>
                <div className="flex items-start gap-2.5">
                  <Lock className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <span>Fail-closed enforcement: if local DLP is offline, traffic halts with HTTP 503.</span>
                </div>
                <div className="flex items-start gap-2.5">
                  <KeyRound className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <span>Provider keys remain strictly server-side behind authenticated gateway routes.</span>
                </div>
              </div>
            </div>

            <div className="pt-5 border-t border-slate-200 dark:border-slate-800">
              <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2.5">
                Workspace evaluation accounts
              </p>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setEmail('admin@airlock.local');
                    setPassword('AirLockAdmin!2026');
                    setRequires2FA(false);
                    setError(null);
                  }}
                  className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/70 transition-colors"
                >
                  <div className="flex items-center justify-between text-xs font-medium text-slate-900 dark:text-slate-100">
                    <span>Nadia Rahman · Admin</span>
                    <span className="text-blue-600 dark:text-blue-400">Use credentials</span>
                  </div>
                  <div className="mt-0.5 text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                    admin@airlock.local
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setEmail('analyst@airlock.local');
                    setPassword('AirLockUser!2026');
                    setRequires2FA(false);
                    setError(null);
                  }}
                  className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/70 transition-colors"
                >
                  <div className="flex items-center justify-between text-xs font-medium text-slate-900 dark:text-slate-100">
                    <span>Tariq Hasan · Security Analyst</span>
                    <span className="text-blue-600 dark:text-blue-400">Use credentials</span>
                  </div>
                  <div className="mt-0.5 text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                    analyst@airlock.local
                  </div>
                </button>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
