import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  ChevronDown,
  Lock,
  Plus,
  ShieldAlert,
  User,
} from 'lucide-react';
import { api, streamAiQuery } from '../lib/api';
import type {
  ChatMessageItem,
  NavPage,
  ProviderId,
  ProviderStatusInfo,
  SecuritySettings,
} from '../types';
import { AirLockLogo } from './AirLockLogo';

interface ChatWorkspaceProps {
  settings: SecuritySettings;
  providers: ProviderStatusInfo[];
  activeConversationId?: string;
  onConversationCreated?: (id: string) => void;
  onNewChat?: () => void;
  onSettingsUpdated: (settings: SecuritySettings, providers: ProviderStatusInfo[]) => void;
  onNavigate: (page: NavPage) => void;
}

const SAMPLE_PROMPTS = [
  {
    title: 'Summarize meeting notes',
    subtitle: 'Turn raw notes into concise action items',
    text: 'Summarize key decisions and next steps from a weekly product sync in bullet points.',
  },
  {
    title: 'Draft a client proposal',
    subtitle: 'Clear, structured project outline',
    text: 'Write a concise project proposal outline covering scope, timeline, and deliverables.',
  },
  {
    title: 'Explain a complex topic',
    subtitle: 'Plain-language breakdown with examples',
    text: 'Explain zero-trust security principles in plain language with three practical examples.',
  },
  {
    title: 'Review and polish writing',
    subtitle: 'Improve clarity, tone, and grammar',
    text: 'Help me rewrite an internal announcement so it sounds clear, concise, and professional.',
  },
];

export function ChatWorkspace({
  settings,
  providers,
  activeConversationId,
  onConversationCreated,
  onNewChat,
  onSettingsUpdated,
  onNavigate,
}: ChatWorkspaceProps) {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(activeConversationId);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [gatewayError, setGatewayError] = useState<{ message: string; status?: number; code?: string } | null>(null);

  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number>(-1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const skipNextLoadIdRef = useRef<string | null>(null);

  useEffect(() => {
    setConversationId(activeConversationId);
    setGatewayError(null);

    if (!activeConversationId) {
      setMessages([]);
      return;
    }

    if (activeConversationId === skipNextLoadIdRef.current) {
      skipNextLoadIdRef.current = null;
      return;
    }

    let cancelled = false;
    setLoadingThread(true);
    api
      .getConversationDetail(activeConversationId)
      .then((res) => {
        if (cancelled) return;
        setMessages(
          res.messages.map((m) => {
            const types = JSON.parse(m.redacted_types_json || '[]') as string[];
            return {
              id: m.id,
              role: m.role,
              content: m.sanitized_content,
              sanitizedContent: m.sanitized_content,
              redactions: types.map((cat, idx) => ({
                placeholder: `[${cat}_${idx + 1}]`,
                category: cat,
                language: 'english',
              })),
              latencyMs: m.latency_ms,
              createdAt: m.created_at,
              provider: res.conversation.provider,
              model: res.conversation.model,
            };
          })
        );
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingThread(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  const activeProviderMeta = providers.find((p) => p.id === settings.activeProvider);
  const activeModelMeta = activeProviderMeta?.models.find((m) => m.id === settings.activeModel);

  async function handleModelChange(combinedValue: string) {
    const [providerId, ...modelParts] = combinedValue.split('::');
    const modelId = modelParts.join('::');
    if (!providerId || !modelId) return;

    setSwitchingModel(true);
    setGatewayError(null);
    try {
      const res = await api.updateSettings({
        activeProvider: providerId as ProviderId,
        activeModel: modelId,
      });
      onSettingsUpdated(res.settings, res.providers);
    } catch (err) {
      setGatewayError({
        message: err instanceof Error ? err.message : 'Unable to switch AI model.',
      });
    } finally {
      setSwitchingModel(false);
    }
  }

  function startNewChat() {
    setMessages([]);
    setConversationId(undefined);
    setGatewayError(null);
    onNewChat?.();
    composerRef.current?.focus();
  }

  async function handleSend(customPrompt?: string) {
    const text = (customPrompt ?? prompt).trim();
    if (!text || sending) return;

    setGatewayError(null);
    setSending(true);
    if (!customPrompt) setPrompt('');

    setPromptHistory((prev) => [text, ...prev.filter((item) => item !== text)].slice(0, 30));
    setHistoryCursor(-1);

    const userMsgId = `local_u_${Date.now()}`;
    const assistantMsgId = `local_a_${Date.now() + 1}`;
    const nowIso = new Date().toISOString();

    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        role: 'user',
        content: text,
        createdAt: nowIso,
      },
      {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        createdAt: nowIso,
        provider: settings.activeProvider,
        model: settings.activeModel,
        isStreaming: true,
      },
    ]);

    try {
      await streamAiQuery(
        {
          prompt: text,
          conversationId,
          provider: settings.activeProvider,
          model: settings.activeModel,
        },
        {
          onMeta: (meta) => {
            if (!conversationId) {
              skipNextLoadIdRef.current = meta.conversationId;
              setConversationId(meta.conversationId);
              onConversationCreated?.(meta.conversationId);
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === userMsgId
                  ? {
                      ...m,
                      sanitizedContent: meta.sanitizedPrompt,
                      redactions: meta.redactions,
                    }
                  : m
              )
            );
          },
          onDelta: (delta) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsgId ? { ...m, content: m.content + delta } : m))
            );
          },
          onDone: (done) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      content: m.content || '(Empty response)',
                      sanitizedContent: done.sanitizedAnswer,
                      latencyMs: done.latencyMs,
                      isStreaming: false,
                    }
                  : m
              )
            );
          },
        }
      );
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      setMessages((prev) => prev.filter((m) => m.id !== userMsgId && m.id !== assistantMsgId));
      setGatewayError({
        message: e.message,
        status: e.status,
        code: e.code,
      });
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
      return;
    }

    if (e.key === 'ArrowUp' && promptHistory.length > 0 && (!prompt || historyCursor >= 0)) {
      const textarea = composerRef.current;
      if (textarea && textarea.selectionStart === 0) {
        e.preventDefault();
        const nextIdx = Math.min(promptHistory.length - 1, historyCursor + 1);
        setHistoryCursor(nextIdx);
        setPrompt(promptHistory[nextIdx]);
      }
    } else if (e.key === 'ArrowDown' && historyCursor >= 0) {
      e.preventDefault();
      const nextIdx = historyCursor - 1;
      setHistoryCursor(nextIdx);
      setPrompt(nextIdx >= 0 ? promptHistory[nextIdx] : '');
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Minimal Model Picker Top Bar */}
      <div className="px-6 py-2.5 flex items-center justify-between gap-3 border-b border-slate-200/70 dark:border-slate-800/70 bg-white/70 dark:bg-[#0E1420]/70">
        <div className="flex items-center gap-2 min-w-0">
          <label htmlFor="chat-model-picker" className="sr-only">
            Select AI model
          </label>
          <div className="relative inline-flex items-center">
            <select
              id="chat-model-picker"
              disabled={switchingModel || sending}
              value={`${settings.activeProvider}::${settings.activeModel}`}
              onChange={(e) => void handleModelChange(e.target.value)}
              className="appearance-none pl-3 pr-8 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 cursor-pointer"
            >
              {providers.map((p) => (
                <optgroup
                  key={p.id}
                  label={`${p.name}${p.configured ? '' : ' (API key not set)'}`}
                >
                  {p.models.map((m) => (
                    <option key={`${p.id}::${m.id}`} value={`${p.id}::${m.id}`}>
                      {p.name} · {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-slate-500 pointer-events-none absolute right-2.5" />
          </div>

          {!activeProviderMeta?.configured && (
            <span className="text-xs text-amber-700 dark:text-amber-400 whitespace-nowrap">
              API key not set
            </span>
          )}
        </div>

        {messages.length > 0 && (
          <button
            type="button"
            onClick={startNewChat}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New chat</span>
          </button>
        )}
      </div>

      {/* Scrollable Chat Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-8">
        {loadingThread ? (
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="h-14 rounded-2xl bg-slate-200/70 dark:bg-slate-800/60 animate-pulse w-2/3 ml-auto" />
            <div className="h-24 rounded-2xl bg-slate-200/70 dark:bg-slate-800/60 animate-pulse w-3/4" />
          </div>
        ) : messages.length === 0 && !gatewayError ? (
          <div className="max-w-2xl mx-auto pt-8 pb-4">
            <div className="flex flex-col items-center text-center">
              <AirLockLogo className="w-10 h-10 mb-4" />
              <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                How can I help you today?
              </h1>
              <p className="mt-2.5 text-sm text-slate-600 dark:text-slate-400 max-w-lg leading-relaxed">
                Choose your preferred AI model above and start chatting.
              </p>
            </div>

            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {SAMPLE_PROMPTS.map((item) => (
                <button
                  key={item.title}
                  type="button"
                  onClick={() => {
                    setPrompt(item.text);
                    composerRef.current?.focus();
                  }}
                  className="text-left p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] hover:border-blue-400 dark:hover:border-blue-600 transition-colors"
                >
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {item.title}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {item.subtitle}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {gatewayError && (
          <div
            role="alert"
            className="max-w-3xl mx-auto mb-6 p-4 rounded-2xl border border-red-300 dark:border-red-900/80 bg-red-50 dark:bg-red-950/30 text-sm text-red-900 dark:text-red-200"
          >
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-semibold">
                  {gatewayError.status === 503
                    ? 'Message paused: protection layer is turned off'
                    : gatewayError.status === 400
                      ? 'Message blocked by safety filter'
                      : gatewayError.status === 429
                        ? 'Too many requests — please wait a moment'
                        : 'Unable to reach selected AI model'}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-red-800 dark:text-red-300">
                  {gatewayError.message}
                </p>
                <button
                  type="button"
                  onClick={() => setGatewayError(null)}
                  className="mt-2.5 text-xs font-medium text-red-700 dark:text-red-300 hover:underline"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="max-w-3xl mx-auto space-y-6">
          {messages.map((msg) => {
            const uniqueCategories = Array.from(
              new Set((msg.redactions || []).map((r) => r.category))
            );
            return (
              <article
                key={msg.id}
                aria-label={msg.role === 'user' ? 'Your message' : 'AI response'}
                className={`flex gap-3.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.role === 'assistant' && (
                  <div className="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  </div>
                )}

                <div className={`max-w-[82%] flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                      {msg.model || settings.activeModel}
                    </div>
                  )}

                  <div
                    className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-blue-600 text-white'
                        : 'bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100'
                    }`}
                  >
                    <div className="whitespace-pre-wrap break-words">
                      {msg.content || (msg.isStreaming ? 'Thinking...' : '')}
                    </div>
                  </div>

                  {msg.role === 'user' && msg.redactions && msg.redactions.length > 0 && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                      <Lock className="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <span>
                        Sensitive data protected ({uniqueCategories.join(', ')}) before sending
                      </span>
                    </div>
                  )}
                </div>

                {msg.role === 'user' && (
                  <div className="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0 mt-0.5">
                    <User className="w-4 h-4 text-slate-700 dark:text-slate-300" />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>

      {/* Clean Modern AI Chat Composer */}
      <div className="px-4 sm:px-6 pb-5 pt-2">
        <div className="max-w-3xl mx-auto">
          {!settings.dlpEnabled && (
            <div className="mb-2.5 flex items-center justify-between gap-2 text-xs text-amber-800 dark:text-amber-300 px-1">
              <span className="inline-flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>Sensitive data filtering is paused in Settings. Sending is blocked for safety.</span>
              </span>
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="font-medium underline whitespace-nowrap"
              >
                Open Settings
              </button>
            </div>
          )}

          <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] shadow-xs focus-within:ring-2 focus-within:ring-blue-600 focus-within:border-transparent transition-shadow">
            <textarea
              ref={composerRef}
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              aria-label="Chat message input"
              className="w-full resize-none bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none px-4 pt-3.5 pb-2 max-h-44"
            />

            <div className="px-3 pb-2.5 flex items-center justify-end">
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={sending || !prompt.trim()}
                aria-label="Send message"
                className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white transition-colors shrink-0"
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
