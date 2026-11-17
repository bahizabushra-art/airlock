import { useEffect, useState } from 'react';
import { Copy, Download, Search, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { ConversationSummary, PersistedMessage } from '../types';

export function HistoryView() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailMessages, setDetailMessages] = useState<PersistedMessage[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function loadConversations(q = '') {
    setLoading(true);
    try {
      const res = await api.getConversations(q);
      setConversations(res.conversations);
      if (res.conversations.length > 0 && !selectedId) {
        await openDetail(res.conversations[0].id);
      }
    } finally {
      setLoading(false);
    }
  }

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const res = await api.getConversationDetail(id);
      setDetailMessages(res.messages);
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    void loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    await loadConversations(search);
  }

  async function handleDelete(id: string) {
    await api.deleteConversation(id);
    if (selectedId === id) {
      setSelectedId(null);
      setDetailMessages([]);
    }
    await loadConversations(search);
  }

  function handleCopyTranscript() {
    if (!selectedId) return;
    const text = detailMessages
      .map((m) => `[${m.created_at}] ${m.role.toUpperCase()}: ${m.sanitized_content}`)
      .join('\n\n');
    void navigator.clipboard.writeText(text);
    setCopiedId(selectedId);
    setTimeout(() => setCopiedId(null), 2000);
  }

  function handleExportJson() {
    const conv = conversations.find((c) => c.id === selectedId);
    if (!conv) return;
    const blob = new Blob(
      [JSON.stringify({ conversation: conv, sanitizedMessages: detailMessages }, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `airlock-sanitized-${conv.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const activeConv = conversations.find((c) => c.id === selectedId);

  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
      {/* Left Conversation List */}
      <aside className="w-full lg:w-96 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E1420] flex flex-col min-h-0">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800">
          <h1 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Sanitized Conversation History
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Only redacted placeholders are persisted. Raw PII is never stored.
          </p>

          <form onSubmit={handleSearchSubmit} className="mt-3 relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                void loadConversations(e.target.value);
              }}
              placeholder="Filter sanitized text or [NID_1]..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            />
          </form>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800">
          {loading ? (
            <div className="p-4 space-y-3">
              <div className="h-12 rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" />
              <div className="h-12 rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
              No sanitized conversations match your filter yet.
            </div>
          ) : (
            conversations.map((conv) => {
              const isSelected = conv.id === selectedId;
              return (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => void openDetail(conv.id)}
                  className={`w-full text-left p-4 transition-colors ${
                    isSelected
                      ? 'bg-blue-50/70 dark:bg-blue-950/30'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-900/60'
                  }`}
                >
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {conv.title}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    <span>{conv.model}</span>
                    <span aria-hidden="true">·</span>
                    <span>{conv.total_redactions} redacted</span>
                    <span aria-hidden="true">·</span>
                    <span>{new Date(conv.updated_at).toLocaleDateString()}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Right Sanitized Thread Viewer */}
      <section className="flex-1 min-w-0 overflow-y-auto p-6 lg:p-8">
        {!activeConv ? (
          <div className="h-full flex items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Select a conversation to inspect its zero-PII sanitized transcript.
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {activeConv.title}
                </h2>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  {activeConv.provider} / {activeConv.model} · {activeConv.message_count} turns ·{' '}
                  {new Date(activeConv.updated_at).toLocaleString()}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleCopyTranscript}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copiedId === activeConv.id ? 'Copied' : 'Copy'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleExportJson}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export JSON</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(activeConv.id)}
                  aria-label="Delete conversation"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 dark:border-red-900/70 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete</span>
                </button>
              </div>
            </div>

            {detailLoading ? (
              <div className="space-y-3">
                <div className="h-20 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
                <div className="h-24 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
              </div>
            ) : (
              <div className="space-y-4">
                {detailMessages.map((msg) => {
                  const types = JSON.parse(msg.redacted_types_json || '[]') as string[];
                  return (
                    <div
                      key={msg.id}
                      className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-semibold text-slate-900 dark:text-slate-100">
                          {msg.role === 'user' ? 'User (Sanitized)' : 'AirLock Assistant (Sanitized)'}
                        </span>
                        <span className="font-mono tabular-nums">
                          {new Date(msg.created_at).toLocaleTimeString()}
                          {msg.redaction_count > 0 && ` · ${msg.redaction_count} redacted (${types.join(', ')})`}
                        </span>
                      </div>
                      <p className="mt-2 text-sm font-mono whitespace-pre-wrap break-words text-slate-800 dark:text-slate-200">
                        {msg.sanitized_content}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
