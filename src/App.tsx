import { useCallback, useEffect, useState } from 'react';
import {
  History,
  MessageSquare,
  Moon,
  Plus,
  Settings,
  Sun,
} from 'lucide-react';
import { AirLockLogo } from './components/AirLockLogo';
import { ChatWorkspace } from './components/ChatWorkspace';
import { HistoryView } from './components/HistoryView';
import { SettingsAdminView } from './components/SettingsAdminView';
import { api } from './lib/api';
import type {
  ConversationSummary,
  NavPage,
  ProviderStatusInfo,
  SecuritySettings,
} from './types';

const NAV_ITEMS: Array<{ id: NavPage; label: string; icon: typeof MessageSquare }> = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'history', label: 'History', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('airlock_theme');
    return saved ? saved === 'dark' : true;
  });

  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SecuritySettings | null>(null);
  const [providers, setProviders] = useState<ProviderStatusInfo[]>([]);
  const [activePage, setActivePage] = useState<NavPage>('chat');
  const [recentThreads, setRecentThreads] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | undefined>(undefined);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) root.classList.add('dark');
    else root.classList.remove('dark');
    localStorage.setItem('airlock_theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const loadRecentThreads = useCallback(async () => {
    try {
      const res = await api.getConversations();
      setRecentThreads(res.conversations.slice(0, 10));
    } catch {
      // Ignore transient errors
    }
  }, []);

  const hydrateWorkspace = useCallback(async () => {
    try {
      const res = await api.getProviders();
      setSettings(res.settings);
      setProviders(res.providers);
      await loadRecentThreads();
      setBootError(null);
    } catch (err) {
      setBootError(err instanceof Error ? err.message : 'Unable to connect to AirLock backend.');
    } finally {
      setBooting(false);
    }
  }, [loadRecentThreads]);

  useEffect(() => {
    void hydrateWorkspace();
  }, [hydrateWorkspace]);

  // Global keyboard shortcuts (Ctrl+Shift+L theme toggle, Alt+1..4 view navigation)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setDarkMode((d) => !d);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const idx = Number(e.key) - 1;
        if (idx >= 0 && idx < NAV_ITEMS.length) {
          e.preventDefault();
          setActivePage(NAV_ITEMS[idx].id);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function handleStartNewChat() {
    setSelectedConversationId(undefined);
    setActivePage('chat');
  }

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#090D16] text-slate-600 dark:text-slate-400 text-sm">
        Loading AirLock...
      </div>
    );
  }

  if (bootError || !settings) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-50 dark:bg-[#090D16] text-slate-700 dark:text-slate-300 text-sm p-6">
        <p>{bootError || 'Unable to initialize workspace.'}</p>
        <button
          type="button"
          onClick={() => void hydrateWorkspace()}
          className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  const currentNav = NAV_ITEMS.find((n) => n.id === activePage) || NAV_ITEMS[0];

  return (
    <div className="h-screen flex overflow-hidden bg-slate-50 dark:bg-[#090D16] text-slate-900 dark:text-slate-100">
      {/* Clean AI Chat Sidebar */}
      <aside
        aria-label="Workspace navigation"
        className="w-64 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E1420] flex flex-col justify-between shrink-0"
      >
        <div className="flex flex-col min-h-0 flex-1">
          <div className="px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <AirLockLogo className="w-6 h-6 shrink-0" />
              <span className="font-display text-base font-semibold tracking-tight whitespace-nowrap">
                AirLock
              </span>
            </div>
            <button
              type="button"
              onClick={handleStartNewChat}
              aria-label="Start new chat"
              title="New chat"
              className="p-1.5 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          <div className="p-3">
            <button
              type="button"
              onClick={handleStartNewChat}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New chat</span>
            </button>
          </div>

          {/* Recent Chat Threads & Navigation */}
          <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-4">
            {recentThreads.length > 0 && (
              <div>
                <div className="px-2 pb-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  Recent chats
                </div>
                <div className="space-y-0.5">
                  {recentThreads.map((thread) => {
                    const isCurrent = activePage === 'chat' && selectedConversationId === thread.id;
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        onClick={() => {
                          setSelectedConversationId(thread.id);
                          setActivePage('chat');
                        }}
                        className={`w-full text-left px-2.5 py-2 rounded-lg text-xs truncate transition-colors ${
                          isCurrent
                            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 font-medium'
                            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                        }`}
                      >
                        {thread.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <div className="px-2 pb-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                Menu
              </div>
              <nav className="space-y-0.5">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const isActive = activePage === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActivePage(item.id)}
                      aria-current={isActive ? 'page' : undefined}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                        isActive
                          ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>
          </div>
        </div>

        {/* Clean Theme Toggle Footer */}
        <div className="p-3.5 border-t border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            aria-label="Toggle theme"
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            <span>{darkMode ? 'Light theme' : 'Dark theme'}</span>
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <header className="px-6 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E1420] flex items-center justify-between gap-4 shrink-0">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
            {currentNav.label}
          </div>
        </header>

        <main className="flex-1 min-h-0 flex flex-col">
          {activePage === 'chat' && (
            <ChatWorkspace
              settings={settings}
              providers={providers}
              activeConversationId={selectedConversationId}
              onConversationCreated={(newId) => {
                setSelectedConversationId(newId);
                void loadRecentThreads();
              }}
              onNewChat={handleStartNewChat}
              onSettingsUpdated={(nextSettings, nextProviders) => {
                setSettings(nextSettings);
                setProviders(nextProviders);
              }}
              onNavigate={setActivePage}
            />
          )}
          {activePage === 'history' && <HistoryView />}
          {activePage === 'settings' && (
            <SettingsAdminView
              settings={settings}
              darkMode={darkMode}
              onToggleTheme={() => setDarkMode((d) => !d)}
              onSettingsUpdated={(next) => setSettings(next)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
