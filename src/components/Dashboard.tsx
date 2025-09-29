
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  const [planState, setPlanState] = useState<'idle' | 'syncing' | 'ready' | 'error'>('idle');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [matches, setMatches] = useState<Record<string, { matched: boolean; matches?: string[] }> | null>(null);
  const [matchStats, setMatchStats] = useState<{ libraries: number; names: number } | null>(null);
  const [actionStatus, setActionStatus] = useState<string>('');
  const [syncingAction, setSyncingAction] = useState<string | null>(null);
  type PresentationSyncResult = Awaited<ReturnType<typeof window.api.ppRunPresentationSync>>;
  const syncableItems = useMemo(() => {
    if (!plan) return [] as { type: 'header' | 'presentation'; title: string }[];
    return plan.items
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(it => {
        const type: 'header' | 'presentation' = it.isHeader ? 'header' : 'presentation';
        return { type, title: (it.title || '').trim() };
      })
      .filter(it => it.title.length > 0);
  }, [plan]);

  const normalizeCategoryName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const getItemIdsForCategories = useCallback((cats: string[]) => {
    if (!plan) return [] as string[];
    const normalized = cats.map(cat => normalizeCategoryName(cat)).filter(Boolean);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of plan.items) {
      if (item.isHeader) continue;
      const id = String(item.id || '').trim();
      if (!id || seen.has(id)) continue;
      const category = ((item.category as string | undefined) ?? fallbackCategory(item) ?? '');
      const normalizedCategory = normalizeCategoryName(category);
      if (!normalizedCategory) continue;
      if (normalized.includes(normalizedCategory)) {
        ids.push(id);
        seen.add(id);
      }
    }
    return ids;
  }, [plan]);

  useEffect(() => { try { localStorage.setItem('pp-host', host); } catch {} }, [host]);
  useEffect(() => { try { localStorage.setItem('pp-port', String(port)); } catch {} }, [port]);

  async function run() {
    setStatus('Running…');
    setPlanState('syncing');
    try {
      const res = await window.api.runSundayPrep({});
      if (res.ok) {
        setStatus(res.message);
        setPlanState('ready');
      } else {
        setStatus(res.message || 'Failed');
        setPlanState('error');
      }
      // Store plan for preview if available
      // @ts-ignore: runtime contract includes optional plan
      if (res.plan) {
        try { (window as any).__lastPlan = res.plan; } catch {}
        setPlan(res.plan as Plan);
      }
    } catch (e: any) {
      setStatus(e?.message || 'Failed');
      setPlanState('error');
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

  const describePresentationSync = (res: PresentationSyncResult | undefined | null, extra?: string) => {
    if (!res) return 'Failed';
    if (!res.ok) return `Failed${res.error ? ` • ${res.error}` : ''}`;
    const parts: string[] = [];
    const summary = res.summary;
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
    if (extra) parts.push(extra);
    const base = parts.length ? parts.join(' • ') : 'Completed';
    if (res.details) {
      console.warn('Presentation sync details', res.details);
      return `${base} • details logged`;
    }
    return base;
  };

  const callPresentationSync = useCallback(async (
    payload: Parameters<typeof window.api.ppRunPresentationSync>[0],
  ) => {
    const apiClient = window.api as typeof window.api & {
      ppRunNotesSync?: typeof window.api.ppRunPresentationSync;
    };
    const fn = apiClient.ppRunPresentationSync ?? apiClient.ppRunNotesSync;
    if (!fn) throw new Error('Presentation sync bridge unavailable');
    return await fn(payload);
  }, []);

  const syncPrePost = useCallback(async (options?: { partOfBatch?: boolean; skipConfirm?: boolean }) => {
    const partOfBatch = options?.partOfBatch ?? false;
    const skipConfirm = options?.skipConfirm ?? false;
    if (!partOfBatch && syncingAction) return false;
    if (!plan) {
      setActionStatus('Load the plan first (Sync PCO Plan).');
      return false;
    }
    const root = effectiveLibraryPath;
    if (!root) {
      setActionStatus('Set Library Path in Connections');
      return false;
    }
    if (!skipConfirm && !window.confirm('This will close and reopen ProPresenter to update presentations. Continue?')) {
      return false;
    }
    if (!partOfBatch) setSyncingAction('prepost');
    setActionStatus('Syncing pre/post service…');
    try {
      const itemIds = getItemIdsForCategories(['Pre Service', 'Post Service']);
      if (!itemIds.length) {
        setActionStatus('No pre/post service items found in plan');
        return false;
      }
      const res = await callPresentationSync({ host, port, libraryRoot: root, categories: ['Pre Service', 'Post Service'], itemIds });
      setActionStatus(describePresentationSync(res));
      return Boolean(res?.ok);
    } catch (e: any) {
      setActionStatus(e?.message || 'Failed');
      return false;
    } finally {
      if (!partOfBatch) setSyncingAction(null);
    }
  }, [syncingAction, plan, effectiveLibraryPath, host, port, callPresentationSync, describePresentationSync, getItemIdsForCategories]);

  const syncSongs = useCallback(async (options?: { partOfBatch?: boolean; skipConfirm?: boolean }) => {
    const partOfBatch = options?.partOfBatch ?? false;
    const skipConfirm = options?.skipConfirm ?? false;
    if (!partOfBatch && syncingAction) return false;
    if (!plan) {
      setActionStatus('Load the plan first (Sync PCO Plan).');
      return false;
    }
    const root = effectiveLibraryPath;
    if (!root) {
      setActionStatus('Set Library Path in Connections');
      return false;
    }
    if (!skipConfirm && !window.confirm('This will close and reopen ProPresenter to update presentations. Continue?')) {
      return false;
    }
    if (!partOfBatch) setSyncingAction('songs');
    setActionStatus('Syncing songs…');
    try {
      const itemIds = getItemIdsForCategories(['Song']);
      if (!itemIds.length) {
        setActionStatus('No song items found in plan');
        return false;
      }
      const res = await callPresentationSync({ host, port, libraryRoot: root, categories: ['Song'], itemIds });
      setActionStatus(describePresentationSync(res));
      return Boolean(res?.ok);
    } catch (e: any) {
      setActionStatus(e?.message || 'Failed');
      return false;
    } finally {
      if (!partOfBatch) setSyncingAction(null);
    }
  }, [syncingAction, plan, effectiveLibraryPath, host, port, callPresentationSync, describePresentationSync, getItemIdsForCategories]);

  const syncVideos = useCallback(async (options?: { partOfBatch?: boolean; skipConfirm?: boolean }) => {
    const partOfBatch = options?.partOfBatch ?? false;
    const skipConfirm = options?.skipConfirm ?? false;
    if (!partOfBatch && syncingAction) return false;
    if (!plan) {
      setActionStatus('Load the plan first (Sync PCO Plan).');
      return false;
    }
    const root = effectiveLibraryPath;
    if (!root) {
      setActionStatus('Set Library Path in Connections');
      return false;
    }
    if (!skipConfirm && !window.confirm('This will close and reopen ProPresenter to update presentations. Continue?')) {
      return false;
    }
    if (!partOfBatch) setSyncingAction('videos');
    setActionStatus('Syncing videos…');
    try {
      const itemIds = getItemIdsForCategories(['Videos']);
      if (!itemIds.length) {
        setActionStatus('No video items found in plan');
        return false;
      }
      const res = await callPresentationSync({ host, port, libraryRoot: root, categories: ['Videos'], itemIds });
      setActionStatus(describePresentationSync(res));
      return Boolean(res?.ok);
    } catch (e: any) {
      setActionStatus(e?.message || 'Failed');
      return false;
    } finally {
      if (!partOfBatch) setSyncingAction(null);
    }
  }, [syncingAction, plan, effectiveLibraryPath, host, port, callPresentationSync, describePresentationSync, getItemIdsForCategories]);

  const syncMessage = useCallback(async (options?: { partOfBatch?: boolean; skipConfirm?: boolean }) => {
    const partOfBatch = options?.partOfBatch ?? false;
    const skipConfirm = options?.skipConfirm ?? false;
    if (!partOfBatch && syncingAction) return false;
    if (!plan) {
      setActionStatus('Load the plan first (Sync PCO Plan).');
      return false;
    }
    const root = effectiveLibraryPath;
    if (!root) {
      setActionStatus('Set Library Path in Connections');
      return false;
    }
    if (!skipConfirm && !window.confirm('This will close and reopen ProPresenter to update presentations. Continue?')) {
      return false;
    }
    if (!partOfBatch) setSyncingAction('message');
    setActionStatus('Syncing message…');
    try {
      const itemIds = getItemIdsForCategories(['Message']);
      if (!itemIds.length) {
        setActionStatus('No message items found in plan');
        return false;
      }
      const res = await callPresentationSync({ host, port, libraryRoot: root, categories: ['Message'], itemIds });
      setActionStatus(describePresentationSync(res));
      return Boolean(res?.ok);
    } catch (e: any) {
      setActionStatus(e?.message || 'Failed');
      return false;
    } finally {
      if (!partOfBatch) setSyncingAction(null);
    }
  }, [syncingAction, plan, effectiveLibraryPath, host, port, callPresentationSync, describePresentationSync, getItemIdsForCategories]);

  const syncTransitions = useCallback(async (options?: { partOfBatch?: boolean; skipConfirm?: boolean }) => {
    const partOfBatch = options?.partOfBatch ?? false;
    const skipConfirm = options?.skipConfirm ?? false;
    if (!partOfBatch && syncingAction) return false;
    if (!plan) {
      setActionStatus('Load the plan first (Sync PCO Plan).');
      return false;
    }
    const root = effectiveLibraryPath;
    if (!root) {
      setActionStatus('Set Library Path in Connections');
      return false;
    }
    if (!skipConfirm && !window.confirm('This will close and reopen ProPresenter to update presentations. Continue?')) {
      return false;
    }
    if (!partOfBatch) setSyncingAction('transitions');
    setActionStatus('Syncing transitions…');
    try {
      const itemIds = getItemIdsForCategories(['Transitions']);
      if (!itemIds.length) {
        setActionStatus('No transition items found in plan');
        return false;
      }
      const res = await callPresentationSync({ host, port, libraryRoot: root, categories: ['Transitions'], itemIds });
      setActionStatus(describePresentationSync(res));
      return Boolean(res?.ok);
    } catch (e: any) {
      setActionStatus(e?.message || 'Failed');
      return false;
    } finally {
      if (!partOfBatch) setSyncingAction(null);
    }
  }, [syncingAction, plan, effectiveLibraryPath, host, port, callPresentationSync, describePresentationSync, getItemIdsForCategories]);

  const syncPlaylist = useCallback(async (options?: { partOfBatch?: boolean }) => {
    const partOfBatch = options?.partOfBatch ?? false;
    if (!partOfBatch && syncingAction) return false;
    const items = syncableItems;
    if (!items.length) {
      setActionStatus('No items to sync');
      return false;
    }
    try { (window as any).__lastSync = { host, port, items }; console.log('Sync candidates', { count: items.length, items }); } catch {}
    if (!partOfBatch) setSyncingAction('playlist');
    setActionStatus('Syncing playlist…');
    try {
      const res = await window.api.ppSyncPlaylist({ host, port, name: 'Sunday Service', items });
      if (res.ok) {
        const message = res.changed
          ? `Playlist synced (${res.totalResolved}/${res.totalDesired})`
          : 'Playlist up to date';
        setActionStatus(message);
        return true;
      }
      setActionStatus(`Playlist sync failed${res.error ? ` • ${res.error}` : ''}`);
      return false;
    } catch (e: any) {
      setActionStatus(e?.message || 'Failed');
      return false;
    } finally {
      if (!partOfBatch) setSyncingAction(null);
    }
  }, [host, port, syncableItems, syncingAction]);

  const syncAll = useCallback(async () => {
    if (syncingAction) return;
    setSyncingAction('all');
    setActionStatus('Running full sync…');
    let hadFailure = false;
    try {
      const prePostOk = await syncPrePost({ partOfBatch: true, skipConfirm: true });
      if (!prePostOk) hadFailure = true;
      const songsOk = await syncSongs({ partOfBatch: true, skipConfirm: true });
      if (!songsOk) hadFailure = true;
      const transitionsOk = await syncTransitions({ partOfBatch: true, skipConfirm: true });
      if (!transitionsOk) hadFailure = true;
      const videosOk = await syncVideos({ partOfBatch: true, skipConfirm: true });
      if (!videosOk) hadFailure = true;
      const messageOk = await syncMessage({ partOfBatch: true, skipConfirm: true });
      if (!messageOk) hadFailure = true;
      const playlistOk = await syncPlaylist({ partOfBatch: true });
      if (!playlistOk) hadFailure = true;
      setActionStatus(prev => {
        const final = hadFailure ? 'Full sync completed with issues' : 'Full sync complete';
        if (!prev) return final;
        return prev.includes(final) ? prev : `${prev} • ${final}`;
      });
    } catch (e: any) {
      setActionStatus(e?.message || 'Failed');
    } finally {
      setSyncingAction(null);
    }
  }, [syncingAction, syncPrePost, syncSongs, syncTransitions, syncVideos, syncMessage, syncPlaylist]);

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
        <div className="mt-4 flex items-center gap-3">
          <button className="btn" onClick={run}>Sync PCO Plan</button>
          <div className="flex items-center gap-2 text-sm">
            {planState === 'syncing' && (
              <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true" />
            )}
            {planState === 'ready' && (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-500/15 border border-green-500/40 text-green-300 text-xs">✓</span>
            )}
            {planState === 'error' && (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500/15 border border-red-500/40 text-red-300 text-xs">!</span>
            )}
            {planState === 'idle' && (
              <span className="inline-block w-4 h-4 rounded-full border border-white/20" aria-hidden="true" />
            )}
            <span className="text-xs uppercase tracking-wide opacity-70">{status}</span>
          </div>
        </div>
      </div>

      {plan && (
        <div className="card p-6">
          <div className="text-xl font-semibold mb-2">Plan Preview</div>
          <div className="text-sm opacity-80 mb-3">{plan.title} — {plan.date}{matchStats ? ` • scanned ${matchStats.libraries} libs / ${matchStats.names} names` : ''}</div>
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
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="btn border border-amber-500/30 text-amber-300 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={Boolean(syncingAction)}
                onClick={() => { if (syncingAction) return; void syncPrePost(); }}
              >
                Sync Pre/Post Service
              </button>
              <button
                className="btn border border-blue-500/30 text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={Boolean(syncingAction)}
                onClick={() => { if (syncingAction) return; void syncSongs(); }}
              >
                Sync Songs
              </button>
              <button
                className="btn border border-teal-500/30 text-teal-300 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={Boolean(syncingAction)}
                onClick={() => { if (syncingAction) return; void syncTransitions(); }}
              >
                {syncingAction === 'transitions' ? 'Syncing…' : 'Sync Transitions'}
              </button>
              <button
                className="btn border border-pink-500/30 text-pink-300 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={Boolean(syncingAction)}
                onClick={() => { if (syncingAction) return; void syncVideos(); }}
              >
                Sync Videos
              </button>
              <button
                className="btn border border-purple-500/30 text-purple-300 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={Boolean(syncingAction)}
                onClick={() => { if (syncingAction) return; void syncMessage(); }}
              >
                Sync Message
              </button>
              <button
                className="btn border border-green-500/30 text-green-300 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={Boolean(syncingAction) || syncableItems.length === 0}
                title={syncableItems.length === 0 ? 'No items to sync' : 'Sync playlist to match plan order'}
                onClick={() => { if (syncingAction) return; void syncPlaylist(); }}
              >
                {syncingAction === 'playlist' ? 'Syncing…' : 'Sync Playlist'}
              </button>
              <button
                className="btn bg-gradient-to-r from-teal-500/40 via-blue-500/40 to-purple-500/40 text-white font-semibold border border-white/30 disabled:opacity-60 disabled:cursor-not-allowed"
                disabled={Boolean(syncingAction)}
                onClick={() => { if (syncingAction) return; void syncAll(); }}
              >
                {syncingAction === 'all' ? 'Syncing…' : 'Sync All'}
              </button>
            </div>
            {actionStatus && <div className="text-xs opacity-70">{actionStatus}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
