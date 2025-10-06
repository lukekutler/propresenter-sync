type SundayPrepSongSection = {
  id: string;
  name: string;
  sequenceLabel?: string;
  lyrics?: string;
  lyricLines?: string[];
  lyricSlides?: string[][];
};

type SundayPrepSongSequenceEntry = {
  id: string;
  position?: number;
  label?: string;
  sectionId?: string;
};

type SundayPrepPlanItemSongDetails = {
  songId: string;
  arrangementId?: string;
  arrangementName?: string;
  sequenceSummary?: string;
  sections?: SundayPrepSongSection[];
  sequence?: SundayPrepSongSequenceEntry[];
  fontFace?: string;
  fontFamily?: string;
  fontSize?: number;
  fontBold?: boolean;
  allCaps?: boolean;
  textColor?: [number, number, number, number];
  fillColor?: [number, number, number, number];
};

type SundayPrepPlanItem = {
  id: string;
  kind: 'song' | 'video' | 'announcement';
  title: string;
  order: number;
  isHeader?: boolean;
  lengthSeconds?: number;
  description?: string;
  notes?: string;
  category?: 'Song' | 'Message' | 'Transitions' | 'Videos' | 'Pre Service' | 'Post Service';
  songDetails?: SundayPrepPlanItemSongDetails;
};

type SundayPrepPlan = {
  id: string;
  date: string;
  title: string;
  items: SundayPrepPlanItem[];
};

type PpMatchResult = {
  matches: Record<string, { matched: boolean; uuid?: string; candidates?: { uuid: string; name: string }[] }>;
  stats?: { libraries: number; names: number };
  error?: string;
};

type PresentationSyncSummary = {
  updated: number;
  skipped: number;
  noDesc: number;
  missingPath: number;
  writeErrors: number;
};

type ProSyncApi = {
  runSundayPrep: (payload: { date?: string }) => Promise<{ ok: boolean; message: string; plan?: SundayPrepPlan }>;
  onLog: (cb: (line: string) => void) => () => void;
  testProPresenter: (cfg: { host: string; port: number; path?: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'; body?: unknown; headers?: Record<string, string>; password?: string }) => Promise<{
    reachable: boolean;
    authenticated: boolean;
    latencyMs?: number;
    error?: string;
    info?: Record<string, unknown>;
    pathTried?: string;
    statusCode?: number;
  }>;
  pcoTest: () => Promise<{ ok: boolean; statusCode?: number; error?: string; bodyText?: string }>;
  pcoSaveAndTest: (payload: { appId: string; secret: string }) => Promise<{ ok: boolean; statusCode?: number; error?: string; bodyText?: string }>;
  pcoGetNextPlan: () => Promise<{ ok: boolean; error?: string; statusCode?: number; plan?: SundayPrepPlan }>;
  ppMatch: (payload: { host: string; port: number; titles: string[] }) => Promise<PpMatchResult>;
  ppSyncPlaylist: (payload: { host: string; port: number; name: string; titles?: string[]; items?: { type: 'header' | 'presentation'; title: string }[] }) => Promise<{ ok: boolean; changed: boolean; created?: boolean; playlistId?: string; totalDesired: number; totalResolved: number; error?: string }>;
  ppFindLibraryRoot: () => Promise<{ ok: boolean; best: { path: string; files: number } | null; candidates: string[] }>;
  ppIndexPresentations: (payload: { root: string }) => Promise<{ ok: boolean; count: number; map: Record<string, { path: string; title?: string }> }>;
  ppIndexPresentationsUuid: (payload: { root: string }) => Promise<{ ok: boolean; count?: number; map?: Record<string, { path: string; title?: string }>; code?: number; err?: string; out?: string; error?: string }>;
  ppWriteOperatorNotesFile: (payload: { file: string; notes: string }) => Promise<{ ok: boolean; code: number; out: string; err: string }>;
  ppRunPresentationSync: (payload: { host: string; port: number; libraryRoot: string; reopen?: boolean; categories?: string[]; itemIds?: string[] }) => Promise<{ ok: boolean; error?: string; summary?: PresentationSyncSummary; planTitle?: string; details?: string; categories?: Record<string, string> }>;
  ppIsRunning: () => Promise<{ ok: boolean; running: boolean; error?: string }>;
  appBootComplete: () => Promise<{ ok: boolean }>;
};

declare global {
  interface Window {
    api: ProSyncApi;
  }
}

export {};
