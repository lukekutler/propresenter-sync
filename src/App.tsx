import { useCallback, useEffect, useRef, useState } from 'react';
import Dashboard from './components/Dashboard';
import Connections from './components/Connections';
import Logs from './components/Logs';

type IntegrationStatus = { state: 'pending'|'ok'|'error'; message?: string; detail?: string };
type LibraryStatus = IntegrationStatus & { path?: string; count?: number };

function getStoredHost(): string {
  try { return localStorage.getItem('pp.host') || '192.168.86.151'; } catch { return '192.168.86.151'; }
}

function getStoredPort(): number {
  try {
    const raw = localStorage.getItem('pp.port');
    return raw ? Number(raw) : 1025;
  } catch {
    return 1025;
  }
}

function getStoredLibraryPath(): string {
  try { return localStorage.getItem('pp.libraryPath') || ''; } catch { return ''; }
}

export default function App() {
  const [tab, setTab] = useState<'dashboard'|'connections'|'logs'>('dashboard');
  const [ppHost, setPpHost] = useState<string>(() => getStoredHost());
  const [ppPort, setPpPort] = useState<number>(() => getStoredPort());
  const [libraryPath, setLibraryPath] = useState<string>(() => getStoredLibraryPath());
  const [booting, setBooting] = useState<boolean>(false);
  const bootReportedRef = useRef<boolean>(false);
  const [statuses, setStatuses] = useState<{ proPresenter: IntegrationStatus; planningCenter: IntegrationStatus; library: LibraryStatus }>(() => ({
    proPresenter: { state: 'pending' },
    planningCenter: { state: 'pending' },
    library: { state: 'pending', path: getStoredLibraryPath() || undefined },
  }));

  useEffect(() => { try { localStorage.setItem('pp.host', ppHost); } catch {} }, [ppHost]);
  useEffect(() => { try { localStorage.setItem('pp.port', String(ppPort)); } catch {} }, [ppPort]);
  useEffect(() => {
    try {
      if (libraryPath) localStorage.setItem('pp.libraryPath', libraryPath);
      else localStorage.removeItem('pp.libraryPath');
    } catch {}
  }, [libraryPath]);

  const refreshIntegrations = useCallback(async () => {
    if (typeof window === 'undefined') return;

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const waitForProPresenterRunning = async (timeoutMs = 20000, pollMs = 500) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const res = await window.api.ppIsRunning?.();
          if (res?.running) return true;
        } catch {}
        await sleep(pollMs);
      }
      return false;
    };

    setBooting(true);
    setStatuses((prev) => ({
      proPresenter: { state: 'pending', message: prev.proPresenter.message },
      planningCenter: { state: 'pending', message: prev.planningCenter.message },
      library: { state: 'pending', path: libraryPath || prev.library.path },
    }));

    const host = ppHost;
    const port = ppPort;

    const proReady = await waitForProPresenterRunning();

    if (proReady) {
      try {
        const res = await window.api.testProPresenter({ host, port });
        if (res.reachable && res.authenticated) {
          setStatuses((prev) => ({
            ...prev,
            proPresenter: { state: 'ok', message: `Connected${res.latencyMs ? ` • ${res.latencyMs}ms` : ''}` },
          }));
        } else if (res.reachable) {
          setStatuses((prev) => ({
            ...prev,
            proPresenter: { state: 'error', message: 'API reachable but not authenticated', detail: res.error || `Status ${res.statusCode ?? '??'}` },
          }));
        } else {
          setStatuses((prev) => ({
            ...prev,
            proPresenter: { state: 'error', message: res.error || 'Host unreachable' },
          }));
        }
      } catch (e: any) {
        setStatuses((prev) => ({
          ...prev,
          proPresenter: { state: 'error', message: 'Connection failed', detail: e?.message || String(e) },
        }));
      }
    } else {
      setStatuses((prev) => ({
        ...prev,
        proPresenter: { state: 'error', message: 'ProPresenter not running' },
      }));
    }

    try {
      const res = await window.api.pcoTest();
      if (res.ok) {
        setStatuses((prev) => ({
          ...prev,
          planningCenter: { state: 'ok', message: 'Connected' },
        }));
      } else {
        setStatuses((prev) => ({
          ...prev,
          planningCenter: { state: 'error', message: res.error || 'Authentication failed', detail: res.statusCode ? `Status ${res.statusCode}` : undefined },
        }));
      }
    } catch (e: any) {
      setStatuses((prev) => ({
        ...prev,
        planningCenter: { state: 'error', message: 'Connection failed', detail: e?.message || String(e) },
      }));
    }

    let effectiveLibrary = libraryPath;
    if (!effectiveLibrary) {
      try {
        const found = await window.api.ppFindLibraryRoot();
        if (found?.ok && found.best?.path) {
          effectiveLibrary = found.best.path;
          setLibraryPath(found.best.path);
        }
      } catch {}
    }

    if (effectiveLibrary) {
      setStatuses((prev) => ({ ...prev, library: { ...prev.library, state: 'pending', path: effectiveLibrary } }));
      try {
        const idx = await window.api.ppIndexPresentationsUuid({ root: effectiveLibrary });
        if (idx?.ok) {
          setStatuses((prev) => ({
            ...prev,
            library: { state: 'ok', path: effectiveLibrary, count: idx.count, message: `Indexed ${idx.count} items` },
          }));
        } else {
          const detail = idx?.err || idx?.out || idx?.error || 'Index failed';
          setStatuses((prev) => ({
            ...prev,
            library: { state: 'error', path: effectiveLibrary, detail, message: 'Index failed' },
          }));
        }
      } catch (e: any) {
        setStatuses((prev) => ({
          ...prev,
          library: { state: 'error', path: effectiveLibrary, detail: e?.message || String(e), message: 'Index failed' },
        }));
      }
    } else {
      setStatuses((prev) => ({
        ...prev,
        library: { state: 'error', path: undefined, message: 'Library not detected' },
      }));
    }

    setBooting(false);

    if (!bootReportedRef.current) {
      bootReportedRef.current = true;
      try {
        await window.api.appBootComplete?.();
      } catch {}
    }
  }, [ppHost, ppPort, libraryPath]);

  useEffect(() => {
    const timer = setTimeout(() => { void refreshIntegrations(); }, 2000);
    return () => clearTimeout(timer);
  }, [refreshIntegrations]);

  return (
    <div className="min-h-screen flex">
      <aside className="w-64 border-r border-neutral-800 p-4 space-y-3">
        <div className="text-2xl font-semibold">ProPresenter Sync</div>
        <nav className="flex flex-col gap-2">
          <button className={`btn ${tab==='dashboard'?'bg-white/15':''}`} onClick={() => setTab('dashboard')}>Dashboard</button>
          <button className={`btn ${tab==='connections'?'bg-white/15':''}`} onClick={() => setTab('connections')}>Connections</button>
          <button className={`btn ${tab==='logs'?'bg-white/15':''}`} onClick={() => setTab('logs')}>Logs</button>
        </nav>
      </aside>
      <main className="flex-1 p-6 space-y-6">
        {tab === 'dashboard' && (
          <Dashboard
            host={ppHost}
            setHost={setPpHost}
            port={ppPort}
            setPort={setPpPort}
            libraryPath={libraryPath}
            statuses={statuses}
            refresh={refreshIntegrations}
            booting={booting}
          />
        )}
        {tab === 'connections' && (
          <Connections
            host={ppHost}
            setHost={setPpHost}
            port={ppPort}
            setPort={setPpPort}
            libraryPath={libraryPath}
            setLibraryPath={setLibraryPath}
            refresh={refreshIntegrations}
            statuses={statuses}
            booting={booting}
          />
        )}
        {tab === 'logs' && <Logs />}
      </main>
    </div>
  );
}
