
import { useEffect, useMemo, useState } from 'react';
import type { Plan } from '@/connectors/planningCenter';

type IntegrationStatus = { state: 'pending'|'ok'|'error'; message?: string; detail?: string; path?: string; count?: number };

type DashboardProps = {
  host: string;
  setHost: (value: string) => void;
  port: number;
  setPort: (value: number) => void;
  libraryPath: string;
  statuses: { proPresenter: IntegrationStatus; planningCenter: IntegrationStatus; library: IntegrationStatus };
  refresh: () => void | Promise<void>;
  booting: boolean;
};

export default function Dashboard({ host, setHost, port, setPort, libraryPath, statuses, refresh, booting }: DashboardProps) {
  const [status, setStatus] = useState<string>('Idle');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [matches, setMatches] = useState<Record<string, { matched: boolean; matches?: string[] }> | null>(null);
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [matchStats, setMatchStats] = useState<{ libraries: number; names: number } | null>(null);
  const [notesStatus, setNotesStatus] = useState<string>('');
  const [notesSyncing, setNotesSyncing] = useState<boolean>(false);

  useEffect(() => { try { localStorage.setItem('pp-host', host); } catch {} }, [host]);
  useEffect(() => { try { localStorage.setItem('pp-port', String(port)); } catch {} }, [port]);

  async function run() {
    setStatus('Running…');
    const res = await window.api.runSundayPrep({});
    setStatus(res.ok ? res.message : 'Failed');
    // Store plan for preview if available
    // @ts-ignore: runtime contract includes optional plan
    if (res.plan) {
      try { (window as any).__lastPlan = res.plan; } catch {}
      setPlan(res.plan as Plan);
    }
  }

  useEffect(() => {
    async function checkMatches() {
      if (!plan) { setMatches(null); return; }
      const titles = plan.items.filter(it => !it.isHeader).map(it => it.title);
      try {
        const res = await window.api.ppMatch({ host, port, titles });
        setMatches(res.matches);
        setMatchStats(res.stats ?? null);
      } catch {
        setMatches(null);
      }
    }
    checkMatches();
  }, [plan, host, port]);

  const effectiveLibraryPath = useMemo(() => libraryPath || statuses.library.path || '', [libraryPath, statuses.library.path]);

  const renderStatusPill = (label: string, status: IntegrationStatus) => {
    const color = status.state === 'ok'
      ? 'bg-green-500/15 text-green-400 border-green-500/30'
      : status.state === 'error'
        ? 'bg-red-500/15 text-red-400 border-red-500/30'
        : 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30';
    const text = status.state === 'pending'
      ? 'Checking…'
      : status.message || (status.state === 'ok' ? 'OK' : 'Needs attention');
    return (
      <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800" key={label}>
        <div className="text-xs uppercase opacity-60">{label}</div>
        <div className={`mt-2 inline-flex items-center px-2 py-1 rounded-full border ${color}`}>
          <span className="text-sm">{text}</span>
        </div>
        {status.state === 'ok' && status.count !== undefined && label === 'Library' && (
          <div className="text-xs opacity-60 mt-1">Indexed {status.count} items</div>
        )}
        {status.state === 'error' && status.detail && (
          <div className="text-xs opacity-60 mt-1 truncate" title={status.detail}>{status.detail}</div>
        )}
        {status.state === 'ok' && label === 'Library' && status.path && (
          <div className="text-xs opacity-60 mt-1 truncate" title={status.path}>{status.path}</div>
        )}
      </div>
    );
  };

  const categoryPillClass = (category: string) => {
    switch (category) {
      case 'Song':
        return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
      case 'Message':
        return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
      case 'Videos':
        return 'bg-pink-500/15 text-pink-300 border-pink-500/30';
      case 'Pre Service':
        return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
      case 'Post Service':
        return 'bg-orange-500/15 text-orange-300 border-orange-500/30';
      case 'Transitions':
      default:
        return 'bg-teal-500/15 text-teal-300 border-teal-500/30';
    }
  };

  const fallbackCategory = (item: Plan['items'][number]): string | undefined => {
    const title = (item.title || '').trim();
    const normalized = title.toLowerCase();
    const isHeader = Boolean(item.isHeader);
    const contains = (...patterns: RegExp[]) => patterns.some(rx => rx.test(normalized));
    const containsAll = (...words: string[]) => words.every(w => normalized.includes(w));

    if (isHeader && /pre[-\s]?service/.test(normalized)) return 'Pre Service';
    if (isHeader && /post[-\s]?service/.test(normalized)) return 'Post Service';
    if (contains(/pre[-\s]?service/, /prelude/, /countdown/, /walk[-\s]?in/, /lobby/, /pre[-\s]?show/, /pre\s*service\s*loop/)) return 'Pre Service';
    if (contains(/post[-\s]?service/, /walk[-\s]?out/, /dismissal/, /outro/, /exit\b/)
      || (containsAll('bumper', 'ending'))
      || (containsAll('bumper', 'exit'))
      || (containsAll('ending', 'exit'))
    ) return 'Post Service';

    if (item.kind === 'song' || contains(/song/, /worship/, /praise/, /anthem/, /hymn/)) return 'Song';

    if (item.kind === 'video' || contains(/video/, /bumper/, /clip/, /lyric\s*video/, /church\s*news/)) return 'Videos';

    if (contains(/message/, /sermon/, /homily/, /teaching/, /talk/, /devotional/, /communion message/, /communion meditation/, /testimony/)) return 'Message';

    if (contains(/transition/, /prayer/, /welcome/, /host/, /announcement/, /announcements/, /giving/, /offering/, /tithes/, /response/, /benediction/)) return 'Transitions';

    return item.kind === 'announcement' ? 'Transitions' : 'Message';
  };

  return (
    <div className="space-y-4">
      <div className="card p-6">
        <div className="text-xl font-semibold mb-2">Environment Status</div>
        <div className="grid md:grid-cols-3 gap-3">
          {renderStatusPill('ProPresenter', statuses.proPresenter)}
          {renderStatusPill('Planning Center', statuses.planningCenter)}
          {renderStatusPill('Library', statuses.library)}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button className="btn" onClick={() => refresh()} disabled={booting}>{booting ? 'Checking…' : 'Re-run Checks'}</button>
          {booting && <span className="text-xs opacity-60">This may take a moment…</span>}
        </div>
      </div>

      <div className="card p-6">
        <div className="text-xl font-semibold mb-2">Next Service</div>
        <div className="text-sm opacity-80">Quickly prepare playlists & media from your plan.</div>
        <div className="mt-4 flex gap-3">
          <button className="btn" onClick={run}>Run Sunday Prep</button>
          <span className="pill">{status}</span>
        </div>
      </div>

      {plan && (
        <div className="card p-6">
          <div className="text-xl font-semibold mb-2">Plan Preview</div>
          <div className="text-sm opacity-80 mb-3">{plan.title} — {plan.date}{matchStats ? ` • scanned ${matchStats.libraries} libs / ${matchStats.names} names` : ''}</div>
          {(() => {
            const syncableItems = plan.items
              .slice()
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .map(it => ({ type: it.isHeader ? 'header' : 'presentation', title: (it.title || '').trim() }))
              .filter(it => it.title.length > 0);
            const disabled = syncableItems.length === 0;
            const doSync = async () => {
              try { (window as any).__lastSync = { host, port, items: syncableItems }; console.log('Sync candidates', { count: syncableItems.length, items: syncableItems }); } catch {}
              if (disabled) { setSyncStatus('No items to sync'); return; }
              setSyncStatus('Syncing…');
              try {
                const res = await (window as any).api.ppSyncPlaylist({ host, port, name: 'Sunday Service', items: syncableItems });
                setSyncStatus(res.ok ? (res.changed ? `Synced (${res.totalResolved}/${res.totalDesired})` : 'Up to date') : `Failed${res.error ? ' • '+res.error : ''}`);
              } catch (e: any) {
                setSyncStatus(e?.message || 'Failed');
              }
            };
            return (
              <div className="mb-3 flex items-center gap-3">
                <button
                  className="btn"
                  disabled={disabled}
                  title={disabled ? 'No items to sync' : 'Sync playlist to match plan order'}
                  onClick={doSync}
                >
                  Sync to ProPresenter
                </button>
                <button
                  className="btn"
                  disabled={disabled}
                  title={disabled ? 'No items to sync' : 'Re-run sync without fetching plan again'}
                  onClick={doSync}
                >
                  Re-sync
                </button>
                <span className={`pill ${syncStatus.startsWith('Synced') || syncStatus==='Up to date' ? 'bg-green-500/15 text-green-400 border-green-500/30' : (syncStatus.startsWith('Failed') ? 'bg-red-500/15 text-red-400 border-red-500/30' : (syncStatus==='No items to sync' ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' : ''))}`}>
                  {syncStatus || (disabled ? 'No items to sync' : 'Not synced')}
                </span>
              </div>
            );
          })()}
          <div className="border border-neutral-800 rounded-xl divide-y divide-neutral-800">
            {plan.items
              .slice()
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .map((it) => {
                const mmss = typeof it.lengthSeconds === 'number' && it.lengthSeconds > 0
                  ? `${Math.floor(it.lengthSeconds / 60)}:${String(Math.round(it.lengthSeconds % 60)).padStart(2, '0')}`
                  : '';
                if (it.isHeader) {
                  return (
                    <div key={it.id} className="px-3 py-2 bg-white/5">
                      <div className="text-xs uppercase tracking-widest opacity-70">{it.title}</div>
                    </div>
                  );
                }
                const m = matches?.[it.title]?.matched;
                const category = (it.category as string | undefined) ?? fallbackCategory(it);
                return (
                  <div key={it.id} className="flex items-center justify-between px-3 py-2 gap-3">
                    <div className="truncate font-medium">{it.title}</div>
                    <div className="flex items-center gap-2">
                      {category && <span className={`pill ${categoryPillClass(category)}`}>{category}</span>}
                      {mmss && <span className="pill">{mmss}</span>}
                      <span className={`pill ${m === true ? 'bg-green-500/15 text-green-400 border-green-500/30' : m === false ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' : ''}`}>
                        {m === true ? 'Matched' : m === false ? 'Not found' : '—'}
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
      {/* Operator notes overwrite from PCO descriptions */}
      <div className="card p-6">
        <div className="text-xl font-semibold mb-2">Operator Notes</div>
        <div className="text-sm opacity-80">Overwrite presentation operator notes from PCO item descriptions (requires library path).</div>
        <div className="mt-3 flex items-center gap-2">
          <input className="input" value={host} onChange={e => setHost(e.target.value)} />
          <input className="input w-24" type="number" value={port} onChange={e => {
            const v = parseInt(e.target.value || '1025', 10);
            setPort(Number.isNaN(v) ? 1025 : v);
          }} />
          <button
            className="btn"
            title="Closes ProPresenter, writes notes, then re-opens"
            disabled={notesSyncing}
            onClick={async () => {
              const root = effectiveLibraryPath;
              if (!root) { setNotesStatus('Set Library Path in Connections'); return; }
              if (!window.confirm('This will close and reopen ProPresenter to update operator notes. Continue?')) return;
              try {
                setNotesSyncing(true);
                setNotesStatus('Starting notes sync…');
                const res = await window.api.ppRunNotesSync({ host, port, libraryRoot: root });
                if (res?.ok) {
                  const summary = res.summary;
                  const parts: string[] = [];
                  if (summary) {
                    parts.push(`Updated ${summary.updated}`);
                    if (summary.noDesc) parts.push(`No desc ${summary.noDesc}`);
                    if (summary.missingPath) parts.push(`Missing files ${summary.missingPath}`);
                    if (summary.writeErrors) parts.push(`Write errors ${summary.writeErrors}`);
                  }
                  const categories = res.categories || {};
                  const catCounts = Object.values(categories).reduce<Record<string, number>>((acc, cat) => {
                    if (!cat) return acc;
                    acc[cat] = (acc[cat] ?? 0) + 1;
                    return acc;
                  }, {});
                  if (Object.keys(catCounts).length) {
                    parts.push(Object.entries(catCounts).map(([cat, count]) => `${cat}: ${count}`).join(', '));
                  } else if (plan) {
                    const planCounts = plan.items.reduce<Record<string, number>>((acc, item) => {
                      if (item.isHeader) return acc;
                      const cat = (item.category as string | undefined) ?? fallbackCategory(item);
                      if (!cat) return acc;
                      acc[cat] = (acc[cat] ?? 0) + 1;
                      return acc;
                    }, {});
                    if (Object.keys(planCounts).length) {
                      parts.push(Object.entries(planCounts).map(([cat, count]) => `${cat}: ${count}`).join(', '));
                    }
                  }
                  const base = parts.length ? parts.join(' • ') : 'Completed';
                  setNotesStatus(res.details ? `${base} • details logged` : base);
                  if (res.details) console.warn('Notes sync details', res.details);
                } else {
                  setNotesStatus(`Failed${res?.error ? ` • ${res.error}` : ''}`);
                }
              } catch (e: any) {
                setNotesStatus(e?.message || 'Failed');
              } finally {
                setNotesSyncing(false);
              }
            }}
          >
            {notesSyncing ? 'Syncing…' : 'Run Notes Sync'}
          </button>
        </div>
        {notesStatus && <div className="text-xs opacity-70 mt-2">{notesStatus}</div>}
      </div>
    </div>
  );
}
