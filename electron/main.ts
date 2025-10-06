
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { spawn, SpawnOptionsWithoutStdio } from 'node:child_process';
import http from 'node:http';
import { testConnection, matchPresentations, normalizeTitle, fetchJson } from './pp';
import { syncPlaylist } from './playlistSync';
import { saveCredentials as pcoSave, testCredentials as pcoTest, testHardcoded as pcoTestHardcoded, getNextPlan as pcoGetNextPlan } from './pco';

function loadLocalEnvOnce() {
  if ((process as any).__PROSYNC_ENV_LOADED) return;
  const roots = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'src', '.env'),
    path.resolve(process.cwd(), 'src', 'lib', '.env'),
  ];
  for (const envPath of roots) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const text = fs.readFileSync(envPath, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
      break;
    } catch {}
  }
  (process as any).__PROSYNC_ENV_LOADED = true;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function acquireSingleInstanceLock(): Promise<boolean> {
  const envWait = Number((process.env.PROSYNC_SINGLE_INSTANCE_WAIT_MS || '').trim());
  const maxWaitMs = Number.isFinite(envWait) && envWait >= 0
    ? envWait
    : (app.isPackaged ? 0 : 15000);
  const retryDelayMs = 200;
  const started = Date.now();
  let attempts = 0;

  while (true) {
    const got = app.requestSingleInstanceLock();
    if (got) {
      if (attempts > 0) debugLog(`acquired single instance lock after ${attempts} retries`);
      else debugLog('acquired single instance lock');
      return true;
    }

    if (Date.now() - started >= maxWaitMs) {
      return false;
    }

    attempts += 1;
    await sleep(retryDelayMs);
  }
}

function canonicalUuid(val: unknown): string | null {
  if (!val) return null;
  const str = String(val).trim();
  if (!str) return null;
  const normalized = str.replace(/[{}]/g, '').toLowerCase();
  return normalized.length ? normalized : null;
}

function broadcastLog(line: string) {
  console.log(line);
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('log', line); } catch {}
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolvePlanItemCategory(item: any): string | undefined {
  const raw = typeof item?.category === 'string' ? item.category.trim() : '';
  if (raw) return raw;
  const title = String(item?.title || '').trim();
  if (!title) return undefined;
  const normalized = title.toLowerCase();
  const isHeader = Boolean(item?.isHeader);
  const contains = (...patterns: RegExp[]) => patterns.some((rx) => rx.test(normalized));
  const containsAll = (...words: string[]) => words.every((w) => normalized.includes(w));

  if (isHeader && /pre[-\s]?service/.test(normalized)) return 'Pre Service';
  if (isHeader && /post[-\s]?service/.test(normalized)) return 'Post Service';
  if (contains(/pre[-\s]?service/, /prelude/, /countdown/, /walk[-\s]?in/, /lobby/, /pre[-\s]?show/, /pre\s*service\s*loop/)) return 'Pre Service';
  if (contains(/post[-\s]?service/, /dismissal/, /outro/, /walk[-\s]?out/)) return 'Post Service';
  if (contains(/video/, /bumper/, /package/, /segment/)) return 'Videos';
  if (contains(/message/, /sermon/, /teaching/, /communion/, /baptism/)) return 'Message';
  if (contains(/song/, /worship/, /music/, /hymn/, /setlist/)) return 'Song';
  if (containsAll('transition', 'host')) return 'Transitions';
  if (contains(/transition/, /mc/, /hosting/, /welcome/, /greeting/, /announcements/, /giving/)) return 'Transitions';
  if (isHeader) return undefined;
  return item?.kind === 'announcement' ? 'Transitions' : 'Message';
}

function resolveDefaultProPresenterEndpoint(): { host: string; port: number } {
  const envHost = (process.env.PROSYNC_PP_HOST || process.env.PP_HOST || '').trim();
  const host = envHost.length ? envHost : '127.0.0.1';
  const envPortRaw = (process.env.PROSYNC_PP_PORT || process.env.PP_PORT || '').trim();
  const parsedPort = Number(envPortRaw);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 1025;
  debugLog(`resolveDefaultProPresenterEndpoint -> host=${host} port=${port}`);
  return { host, port };
}

function runCommand(cmd: string, args: string[], options: SpawnOptionsWithoutStdio = {}): Promise<{ code: number; out: string; err: string }> {
  debugLog(`runCommand start cmd=${cmd} args=${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, options);
    const out: string[] = [];
    const err: string[] = [];
    proc.stdout?.on('data', (d) => out.push(d.toString()));
    proc.stderr?.on('data', (d) => err.push(d.toString()));
    proc.on('error', (e) => {
      debugLog(`runCommand error cmd=${cmd} message=${e?.message || e}`);
      reject(e);
    });
    proc.on('close', (code) => {
      debugLog(`runCommand close cmd=${cmd} code=${code}`);
      resolve({ code: code ?? 1, out: out.join(''), err: err.join('') });
    });
  });
}

async function runPythonScript(script: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const env = { ...process.env, PYTHONPATH: path.resolve(process.cwd(), 'src/gen'), PYTHONDONTWRITEBYTECODE: '1' };
  return await runCommand('python3', [script, ...args], { env });
}

async function writeOperatorNotesFile(file: string, notes: string): Promise<{ ok: boolean; code: number; out: string; err: string }> {
  try {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const bak = file + '.bak-' + ts;
    try { fs.copyFileSync(file, bak); } catch {}
  } catch {}

  const script = path.resolve(process.cwd(), 'scripts', 'pp_set_operator_notes.py');
  const res = await runPythonScript(script, [file, notes]);
  return { ok: res.code === 0, ...res };
}

type TimerDescriptor = { uuid?: string; name?: string; allowsOverrun?: boolean };
type TimerEnsureOptions = { desiredName: string; allowsOverrun?: boolean; preferredUuid?: string };
type StageScreenDescriptor = { uuid?: string; name?: string };
type StageLayoutDescriptor = { layoutUuid?: string; layoutName?: string; assignments: StageScreenDescriptor[] };
type MediaPlaylistItem = {
  uuid: string;
  id?: string;
  name: string;
  playlistUuid?: string;
  playlistName?: string;
  updatedAt?: number;
  keywords: string[];
  filePath?: string;
  documentsRelativePath?: string;
  formatHint?: string;
};
type MediaMatch = MediaPlaylistItem & { score: number };
type TransitionTopicSpec = {
  topic: string;
  media?: {
    uuid: string;
    id?: string;
    name: string;
    playlistUuid?: string;
    playlistName?: string;
    updatedAt?: number;
    score?: number;
    filePath?: string;
    documentsRelativePath?: string;
    formatHint?: string;
  };
  gallery?: {
    filePath: string;
    documentsRelativePath?: string;
    formatHint?: string;
  }[];
};
type PropIdentifier = {
  propUuid: string;
  propName?: string;
  collectionUuid?: string;
  collectionName?: string;
  triggerAutoClearEnabled?: boolean;
  triggerAutoClearFollowsDuration?: boolean;
  triggerAutoClearDuration?: number;
};
type LowerThirdPayload = {
  name: string;
  filePath: string;
  documentsRelativePath?: string;
  formatHint?: string;
};
type SongTemplateSectionPayload = {
  id?: string;
  name?: string;
  sequenceLabel?: string;
  slides: string[][];
};
type SongTemplatePayload = {
  title?: string;
  groupName?: string;
  arrangementName?: string;
  fontFace?: string;
  fontFamily?: string;
  fontSize?: number;
  fontBold?: boolean;
  allCaps?: boolean;
  textColor?: [number, number, number, number];
  fillColor?: [number, number, number, number];
  sections: SongTemplateSectionPayload[];
};

const NON_LYRIC_SECTION_PATTERN = /\b(intro|turn\s*around|turnaround|instrumental|interlude|outro|tag|ending)\b/i;

const DEFAULT_TRANSITION_TIMER_NAME = 'Service Item Timer';
const TRANSITION_TOPIC_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'after', 'next', 'step', 'story', 'jr', 'jr.', 'grades', 'grade', 'service', 'news']);
const BULLET_MARKERS_REGEX = /[\u2022\u2023\u25E6\u2043\u2219\u25AA\u25CF\u25CB\u25C6\u2605\u25B8\u25BA\u25A0\u25A1\u25D8\u25D9\u2023❖⚑•▪▫➤▶➔‣◦⁃–—]/g;
const LEADING_TOPIC_PATTERN = /^(?:[\u2022\u2023\u25E6\u2043\u2219\u25AA\u25CF\u25CB\u25C6\u2605\u25B8\u25BA\u25A0\u25A1\u2023❖⚑•▪▫➤▶➔‣◦⁃*+>]|[-–—]|\(?\d+\)?[.)]?|[A-Za-z][.)])\s*/u;
const mediaPlaylistCache = new Map<string, Promise<MediaPlaylistItem[] | undefined>>();
const titlesMediaIndex: { built: boolean; byKey: Map<string, string[]> } = { built: false, byKey: new Map() };
const titlesDirectoryCandidates: { built: boolean; dirs: string[] } = { built: false, dirs: [] };
const CLEAR_PROP_NAME = 'Logo';
type TopicOverrideSpec = { topic: string; manualTarget?: string };
const TOPIC_MEDIA_RULES: { pattern: RegExp; targetName: string }[] = [
  { pattern: /(dismiss|pickup|release|dismissal).*(youth|jr)/i, targetName: 'LIFE Youth Jr' },
  { pattern: /next\s*step/i, targetName: 'Next Steps' },
];
const MIN_TRANSITION_MEDIA_SCORE = 15;
const lowerThirdDirectoryCandidates: { built: boolean; dirs: string[] } = { built: false, dirs: [] };
type LowerThirdEntry = {
  filePath: string;
  documentsRelativePath?: string;
  formatHint?: string;
  baseName: string;
  keys: string[];
};
const lowerThirdMediaIndex: { built: boolean; entries: LowerThirdEntry[]; byKey: Map<string, LowerThirdEntry[]> } = {
  built: false,
  entries: [],
  byKey: new Map(),
};
const LOWER_THIRD_STOP_WORDS = new Set([
  'pastor',
  'pst',
  'ps',
  'rev',
  'reverend',
  'minister',
  'min',
  'dr',
  'doctor',
  'bishop',
  'host',
  'speaker',
  'guest',
  'mc',
  'emcee',
  'coach',
  'leader',
  'team',
  'service',
  'transition',
  'closing',
  'message',
  'name',
  'the',
]);
const PHOTO_KEYWORDS = /\b(photo|photos|picture|pictures|pic|pics|gallery|images|shots|snap|snapshots)\b/i;
const PHOTO_KEYWORDS_GLOBAL = /\b(photo|photos|picture|pictures|pic|pics|gallery|images|shots|snap|snapshots)\b/gi;
const photoDirectoryCandidates: { built: boolean; dirs: string[] } = { built: false, dirs: [] };
type PhotoDirectoryEntry = {
  name: string;
  path: string;
  keys: string[];
};
const photoDirectoryIndex: { built: boolean; entries: PhotoDirectoryEntry[] } = { built: false, entries: [] };

function parseMaybeJson(text?: string) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractTimersFromNode(node: any): TimerDescriptor[] {
  const timers: TimerDescriptor[] = [];
  const seen = new Set<string>();
  const visit = (value: any) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      const name = typeof value.name === 'string' ? value.name : undefined;
      const uuidRaw = typeof value.uuid === 'string' ? value.uuid : (typeof value.id === 'string' ? value.id : undefined);
      const uuid = uuidRaw && uuidRaw.length ? uuidRaw : undefined;
      let allows: boolean | undefined;
      if (typeof (value as any).allows_overrun === 'boolean') allows = (value as any).allows_overrun;
      else if (typeof (value as any).allowsOverrun === 'boolean') allows = (value as any).allowsOverrun;
      else if (typeof (value as any).configuration === 'object' && value.configuration) {
        const cfg: any = value.configuration;
        if (typeof cfg.allows_overrun === 'boolean') allows = cfg.allows_overrun;
      }
      if ((name || uuid) && (!uuid || !seen.has(uuid.toLowerCase()))) {
        timers.push({ name, uuid, allowsOverrun: allows });
        if (uuid) seen.add(uuid.toLowerCase());
      }
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(node);
  return timers;
}

async function requestJson(host: string, port: number, pathname: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', payload?: any): Promise<{ status: number; json?: any; text?: string }> {
  return await new Promise((resolve) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }
    const req = http.request({ host, port, path: pathname, method, timeout: 5000, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => { if (chunks.reduce((n, b) => n + b.length, 0) < 1_048_576) chunks.push(c as Buffer); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { json = text ? JSON.parse(text) : undefined; } catch {}
        resolve({ status: res.statusCode ?? 0, json, text: text || undefined });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0 }));
    if (body) req.end(body); else req.end();
  });
}

async function createTimer(host: string, port: number, payload: any): Promise<TimerDescriptor | undefined> {
  const res = await requestJson(host, port, '/v1/timers', 'POST', payload);
  if (res.status >= 200 && res.status < 300) {
    const timers = extractTimersFromNode(res.json ?? parseMaybeJson(res.text));
    if (timers.length) return timers[0];
  }
  return undefined;
}

function collectNamedDescriptors(source: any): { items: StageScreenDescriptor[] } {
  const seen = new Set<string>();
  const items: StageScreenDescriptor[] = [];
  const visit = (value: any) => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value === 'object') {
      const name = typeof value.name === 'string' ? value.name : undefined;
      const uuidRaw = typeof value.uuid === 'string' ? value.uuid : (typeof value.id === 'string' ? value.id : undefined);
      const uuid = uuidRaw && uuidRaw.length ? uuidRaw : undefined;
      if (name || uuid) {
        const key = (uuid || `${name}`).toLowerCase();
        if (!seen.has(key)) {
          items.push({ name, uuid });
          seen.add(key);
        }
      }
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(source);
  return { items };
}

function extractTransitionTopics(description: string): string[] {
  if (!description || typeof description !== 'string') return [];
  const normalized = description
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(BULLET_MARKERS_REGEX, (match, offset, input) => (offset > 0 && input[offset - 1] !== '\n' ? `\n${match}` : match));
  const topics: string[] = [];
  for (const rawLine of normalized.split(/\n+/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const cleaned = trimmed.replace(LEADING_TOPIC_PATTERN, '').trim();
    if (!cleaned) continue;
    if (/\bcue\b/i.test(cleaned)) continue;
    topics.push(cleaned.replace(/\s+/g, ' '));
  }
  return topics;
}

function locatePlaylistCandidate(source: any, playlistName: string): any | undefined {
  const targetNorm = normalizeTitle(playlistName);
  const targetRaw = playlistName.trim().toLowerCase();
  let candidate: any | undefined;
  const visit = (value: any) => {
    if (candidate || !value) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value === 'object') {
      const name = typeof value.name === 'string' ? value.name : (typeof (value as any).title === 'string' ? (value as any).title : undefined);
      if (name) {
        const normalized = normalizeTitle(name);
        if ((normalized && normalized === targetNorm) || name.trim().toLowerCase() === targetRaw) {
          candidate = value;
          return;
        }
      }
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(source);
  return candidate;
}

function extractIdentifier(value: any): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidates = ['uuid', 'id', 'identifier', 'playlist_uuid', 'playlistUuid', 'playlist_id', 'playlistId', 'media_uuid', 'mediaUuid'];
  for (const key of candidates) {
    const raw = (value as any)[key];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length) return trimmed;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return String(raw);
    }
  }
  return undefined;
}

function extractName(value: any): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const keys = ['name', 'title', 'label', 'displayName', 'display_name', 'fileName', 'filename', 'mediaName', 'media_name'];
  for (const key of keys) {
    const raw = (value as any)[key];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length) return trimmed;
    }
  }
  return undefined;
}

function isLikelyMediaObject(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  const typeRaw = typeof (value as any).type === 'string' ? (value as any).type.toLowerCase() : '';
  if (typeRaw.includes('media') || typeRaw.includes('still') || typeRaw.includes('video') || typeRaw.includes('image')) return true;
  if ('thumbnail' in value || 'download' in value || 'duration' in value || 'width' in value || 'height' in value) return true;
  if ('fileName' in value || 'filename' in value || 'path' in value) return true;
  if ('media' in value && typeof (value as any).media === 'object') return true;
  if ('kind' in value && typeof (value as any).kind === 'string' && (value as any).kind.toLowerCase().includes('media')) return true;
  return false;
}

function gatherStringCandidates(value: any): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const push = (input: unknown) => {
    if (typeof input !== 'string') return;
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > 256) return;
    const lowered = trimmed.toLowerCase();
    if (seen.has(lowered)) return;
    seen.add(lowered);
    results.push(trimmed);
  };
  if (!value || typeof value !== 'object') return results;
  for (const key of ['name', 'title', 'label', 'displayName', 'display_name', 'fileName', 'filename', 'description', 'category', 'mediaType', 'kind']) {
    push((value as any)[key]);
  }
  for (const key of ['tags', 'keywords', 'labels']) {
    const entry = (value as any)[key];
    if (Array.isArray(entry)) {
      for (const item of entry) push(item);
    }
  }
  push((value as any).path);
  push((value as any).file_path);
  push((value as any).filePath);
  push((value as any).import_source);
  let scanned = 0;
  for (const val of Object.values(value)) {
    if (scanned > 20) break;
    scanned += 1;
    if (typeof val === 'string') {
      push(val);
      continue;
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') push(item);
        else if (item && typeof item === 'object') {
          for (const inner of Object.values(item)) {
            if (typeof inner === 'string') push(inner);
          }
        }
      }
      continue;
    }
    if (val && typeof val === 'object') {
      for (const inner of Object.values(val)) {
        if (typeof inner === 'string') push(inner);
      }
    }
  }
  return results;
}

function normalizeMediaKey(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function discoverTitlesDirectories(): string[] {
  if (titlesDirectoryCandidates.built) return titlesDirectoryCandidates.dirs;
  const dirs = new Set<string>();
  const envRaw = (process.env.PROSYNC_TITLES_DIRS || process.env.PROSYNC_TITLES_DIR || '').trim();
  if (envRaw) {
    for (const part of envRaw.split(path.delimiter)) {
      const candidate = part.trim();
      if (!candidate) continue;
      try {
        const stat = fs.statSync(candidate);
        if (stat.isDirectory()) dirs.add(path.resolve(candidate));
      } catch {}
    }
  }

  const home = os.homedir();
  const defaults = [
    path.join(home, 'Documents', 'Titles'),
    path.join(home, 'Documents', 'Word Of Life', 'Titles'),
    path.join(home, 'Documents', 'ProPresenter', 'Media', 'Titles'),
    path.join(home, 'Documents', 'ProPresenter', 'Media'),
  ];
  for (const candidate of defaults) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) dirs.add(path.resolve(candidate));
    } catch {}
  }

  const documentsDir = path.join(home, 'Documents');
  try {
    const entries = fs.readdirSync(documentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (/title/i.test(entry.name)) {
        const resolved = path.join(documentsDir, entry.name);
        try {
          if (fs.statSync(resolved).isDirectory()) dirs.add(path.resolve(resolved));
        } catch {}
      }
    }
  } catch {}

  titlesDirectoryCandidates.built = true;
  titlesDirectoryCandidates.dirs = Array.from(dirs);
  return titlesDirectoryCandidates.dirs;
}

function indexTitlesMedia(): Map<string, string[]> {
  if (titlesMediaIndex.built) return titlesMediaIndex.byKey;
  const byKey = new Map<string, string[]>();
  const enqueue = (key: string, filePath: string) => {
    if (!key) return;
    const list = byKey.get(key) ?? [];
    if (!list.includes(filePath)) list.push(filePath);
    byKey.set(key, list);
  };

  const visit = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(jpe?g|png|bmp|tiff?|webp|heic|gif|mp4|mov|m4v|mp3|wav)$/i.test(entry.name)) continue;
      const base = entry.name.replace(/\.[^.]+$/, '');
      const key = normalizeMediaKey(base);
      enqueue(key, full);
    }
  };

  for (const dir of discoverTitlesDirectories()) visit(dir, 0);

  titlesMediaIndex.built = true;
  titlesMediaIndex.byKey = byKey;
  return byKey;
}

function resolveMediaFilePath(name: string): { filePath: string; documentsRelativePath?: string; formatHint?: string } | undefined {
  const normalized = normalizeMediaKey(name);
  if (!normalized) return undefined;
  const byKey = indexTitlesMedia();
  const direct = byKey.get(normalized);
  let resolved: string | undefined;
  if (direct && direct.length) {
    resolved = direct[0];
  } else {
    for (const [key, files] of byKey.entries()) {
      if (!files.length) continue;
      if (key.includes(normalized) || normalized.includes(key)) {
        resolved = files[0];
        break;
      }
    }
  }
  if (!resolved) return undefined;
  const absolute = path.resolve(resolved);
  const documents = path.join(os.homedir(), 'Documents');
  let rel: string | undefined;
  if (absolute.startsWith(documents + path.sep)) {
    rel = path.relative(documents, absolute).split(path.sep).join('/');
  }
  const ext = path.extname(absolute).slice(1).toUpperCase();
  return { filePath: absolute, documentsRelativePath: rel, formatHint: ext || undefined };
}

function discoverLowerThirdDirectories(): string[] {
  if (lowerThirdDirectoryCandidates.built) return lowerThirdDirectoryCandidates.dirs;
  const dirs = new Set<string>();
  const envRaw = (process.env.PROSYNC_LOWER_THIRDS_DIRS || process.env.PROSYNC_LOWER_THIRDS_DIR || '').trim();
  if (envRaw) {
    for (const part of envRaw.split(path.delimiter)) {
      const candidate = part.trim();
      if (!candidate) continue;
      try {
        if (fs.statSync(candidate).isDirectory()) dirs.add(path.resolve(candidate));
      } catch {}
    }
  }

  const home = os.homedir();
  const defaults = [
    path.join(home, 'Documents', 'Lower Thirds'),
    path.join(home, 'Documents', 'LowerThirds'),
    path.join(home, 'Documents', 'Word Of Life', 'Lower Thirds'),
    path.join(home, 'Documents', 'Word Of Life', 'LowerThirds'),
    path.join(home, 'Documents', 'ProPresenter', 'Media', 'Lower Thirds'),
    path.join(home, 'Documents', 'ProPresenter', 'Media', 'LowerThirds'),
    path.join(home, 'Documents', 'ProPresenter', 'Media'),
  ];
  for (const candidate of defaults) {
    try {
      if (fs.statSync(candidate).isDirectory()) dirs.add(path.resolve(candidate));
    } catch {}
  }

  const documentsDir = path.join(home, 'Documents');
  try {
    const entries = fs.readdirSync(documentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (/lower\s*third/i.test(entry.name)) {
        const resolved = path.join(documentsDir, entry.name);
        try {
          if (fs.statSync(resolved).isDirectory()) dirs.add(path.resolve(resolved));
        } catch {}
      }
    }
  } catch {}

  lowerThirdDirectoryCandidates.built = true;
  lowerThirdDirectoryCandidates.dirs = Array.from(dirs);
  if (!lowerThirdDirectoryCandidates.dirs.length) {
    broadcastLog('[DEBUG] Lower third index: no directories discovered');
  } else {
    broadcastLog(`[DEBUG] Lower third index directories: ${lowerThirdDirectoryCandidates.dirs.join(', ')}`);
  }
  return lowerThirdDirectoryCandidates.dirs;
}

function normalizeLowerThirdBase(input: string): string {
  return normalizeMediaKey(
    input
      .replace(/lower\s*thirds?/gi, ' ')
      .replace(/lowerthirds?/gi, ' ')
      .replace(/lt\b/gi, ' ')
      .replace(/nameplate/gi, ' ')
      .replace(/title/gi, ' ')
      .replace(/overlay/gi, ' ')
      .replace(/\s+/g, ' ')
  );
}

function filterLowerThirdStopWords(input: string): string {
  if (!input) return input;
  const tokens = input.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter((token) => !LOWER_THIRD_STOP_WORDS.has(token));
  return filtered.join(' ');
}

function normalizeLowerThirdKey(input: string): string {
  const base = normalizeLowerThirdBase(input);
  if (!base) return '';
  const filtered = filterLowerThirdStopWords(base);
  return filtered || base;
}

function collectLowerThirdKeys(baseName: string, parentName?: string): string[] {
  const keys = new Set<string>();
  const variants = new Set<string>();
  variants.add(baseName);
  if (parentName) variants.add(`${parentName} ${baseName}`);
  if (parentName) variants.add(parentName);

  for (const variant of variants) {
    const baseNormalized = normalizeLowerThirdBase(variant);
    if (!baseNormalized) continue;
    keys.add(baseNormalized);
    const filtered = filterLowerThirdStopWords(baseNormalized);
    if (filtered) keys.add(filtered);

    const tokens = baseNormalized.split(/\s+/).filter(Boolean);
    const filteredTokens = filtered ? filtered.split(/\s+/).filter(Boolean) : tokens;

    for (const token of tokens) {
      if (token.length >= 2) keys.add(token);
    }
    for (const token of filteredTokens) {
      if (token.length >= 2) keys.add(token);
    }

    if (tokens.length >= 2) {
      keys.add(`${tokens[0]} ${tokens[tokens.length - 1]}`.trim());
      keys.add(tokens[tokens.length - 1]);
    }
    if (filteredTokens.length >= 2) {
      keys.add(`${filteredTokens[0]} ${filteredTokens[filteredTokens.length - 1]}`.trim());
      keys.add(filteredTokens[filteredTokens.length - 1]);
    }

    const initials = tokens.map((token) => token[0]).join('');
    if (initials.length >= 2) keys.add(initials);
    const filteredInitials = filteredTokens.map((token) => token[0]).join('');
    if (filteredInitials.length >= 2) keys.add(filteredInitials);
  }

  return Array.from(keys).map((key) => normalizeMediaKey(key)).filter(Boolean);
}

function topicRequestsPhotos(topic: string): boolean {
  return PHOTO_KEYWORDS.test(topic);
}

function stripPhotoKeywords(topic: string): string {
  return topic.replace(PHOTO_KEYWORDS_GLOBAL, ' ').replace(/\s+/g, ' ').trim();
}

function discoverPhotoDirectories(): string[] {
  if (photoDirectoryCandidates.built) return photoDirectoryCandidates.dirs;
  const dirs = new Set<string>();
  const envRaw = (process.env.PROSYNC_PHOTOS_DIRS || process.env.PROSYNC_PHOTOS_DIR || '').trim();
  if (envRaw) {
    for (const part of envRaw.split(path.delimiter)) {
      const candidate = part.trim();
      if (!candidate) continue;
      try {
        if (fs.statSync(candidate).isDirectory()) dirs.add(path.resolve(candidate));
      } catch {}
    }
  }

  const home = os.homedir();
  const defaults = [
    path.join(home, 'Documents', 'Word Of Life', 'Photos'),
    path.join(home, 'Documents', 'Photos'),
    path.join(home, 'Pictures', 'Word Of Life'),
  ];
  for (const candidate of defaults) {
    try {
      if (fs.statSync(candidate).isDirectory()) dirs.add(path.resolve(candidate));
    } catch {}
  }

  photoDirectoryCandidates.built = true;
  photoDirectoryCandidates.dirs = Array.from(dirs);
  if (!photoDirectoryCandidates.dirs.length) {
    broadcastLog('[DEBUG] Photo directories not found');
  } else {
    broadcastLog(`[DEBUG] Photo root directories: ${photoDirectoryCandidates.dirs.join(', ')}`);
  }
  return photoDirectoryCandidates.dirs;
}

function indexPhotoDirectories(): PhotoDirectoryEntry[] {
  if (photoDirectoryIndex.built) return photoDirectoryIndex.entries;

  const entries: PhotoDirectoryEntry[] = [];
  const seen = new Set<string>();
  const roots = discoverPhotoDirectories();

  const visit = (dir: string, depth: number) => {
    if (depth > 2) return;
    let dirEntries: fs.Dirent[] = [];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const canonical = path.resolve(full);
      if (seen.has(canonical)) {
        visit(full, depth + 1);
        continue;
      }
      seen.add(canonical);
      const parentName = path.basename(dir);
      const keys = collectLowerThirdKeys(entry.name, parentName);
      entries.push({ name: entry.name, path: canonical, keys });
      visit(full, depth + 1);
    }
  };

  for (const root of roots) visit(root, 0);

  photoDirectoryIndex.entries = entries;
  photoDirectoryIndex.built = true;
  broadcastLog(`[DEBUG] Indexed ${entries.length} photo directories`);
  return photoDirectoryIndex.entries;
}

function collectPhotosFromDirectory(dir: string): { filePath: string; documentsRelativePath?: string; formatHint?: string }[] {
  const images: { filePath: string; documentsRelativePath?: string; formatHint?: string }[] = [];
  const visit = (current: string, depth: number) => {
    if (depth > 2) return;
    let dirEntries: fs.Dirent[] = [];
    try {
      dirEntries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(jpe?g|png|bmp|tiff?|webp|heic)$/i.test(entry.name)) continue;
      const absolute = path.resolve(full);
      const documents = path.join(os.homedir(), 'Documents') + path.sep;
      let documentsRelativePath: string | undefined;
      if (absolute.startsWith(documents)) {
        documentsRelativePath = path.relative(path.join(os.homedir(), 'Documents'), absolute).split(path.sep).join('/');
      }
      const formatHint = path.extname(absolute).slice(1).toUpperCase() || undefined;
      images.push({ filePath: absolute, documentsRelativePath, formatHint });
    }
  };

  visit(dir, 0);
  images.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return images;
}

function resolveTopicPhotos(topic: string): { filePath: string; documentsRelativePath?: string; formatHint?: string }[] | undefined {
  if (!topicRequestsPhotos(topic)) return undefined;
  const stripped = stripPhotoKeywords(topic);
  const normalized = normalizeMediaKey(stripped);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const index = indexPhotoDirectories();

  let bestEntry: PhotoDirectoryEntry | undefined;
  let bestScore = 0;

  for (const entry of index) {
    let score = 0;
    for (const key of entry.keys) {
      if (!key) continue;
      if (normalized && key === normalized) {
        score = Math.max(score, 120);
        break;
      }
      if (normalized && (key.includes(normalized) || normalized.includes(key))) {
        score = Math.max(score, 90);
        continue;
      }
      if (tokens.length) {
        const keyTokens = key.split(/\s+/).filter(Boolean);
        const overlap = tokens.filter((token) => keyTokens.includes(token)).length;
        if (overlap) score = Math.max(score, overlap * 18);
      }
    }
    if (score > 0 && (!bestEntry || score > bestScore)) {
      bestEntry = entry;
      bestScore = score;
    }
  }

  if (!bestEntry) return undefined;

  const photos = collectPhotosFromDirectory(bestEntry.path);
  if (!photos.length) return undefined;

  broadcastLog(`[INFO] Transition photos selected • ${topic} -> ${bestEntry.path} (${photos.length} images)`);
  return photos;
}

function indexLowerThirdMedia(): { entries: LowerThirdEntry[]; byKey: Map<string, LowerThirdEntry[]> } {
  if (lowerThirdMediaIndex.built) return lowerThirdMediaIndex;

  const entries: LowerThirdEntry[] = [];
  const byKey = new Map<string, LowerThirdEntry[]>();
  const documentsRoot = path.join(os.homedir(), 'Documents') + path.sep;

  const enqueue = (entry: LowerThirdEntry) => {
    entries.push(entry);
    for (const key of entry.keys) {
      if (!key) continue;
      const list = byKey.get(key) ?? [];
      if (!list.includes(entry)) {
        list.push(entry);
        byKey.set(key, list);
      }
    }
  };

  const visit = (dir: string, depth: number) => {
    if (depth > 5) return;
    let dirEntries: fs.Dirent[] = [];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(mov|mp4|m4v)$/i.test(entry.name)) continue;
      const abs = path.resolve(full);
      let rel: string | undefined;
      if (abs.startsWith(documentsRoot)) {
        rel = path.relative(path.join(os.homedir(), 'Documents'), abs).split(path.sep).join('/');
      }
      const ext = path.extname(abs).slice(1).toUpperCase() || undefined;
      const baseName = entry.name.replace(/\.[^.]+$/, '');
      const parentName = path.basename(path.dirname(abs));
      const keys = new Set<string>(collectLowerThirdKeys(baseName, parentName));
      const entryPayload: LowerThirdEntry = {
        filePath: abs,
        documentsRelativePath: rel,
        formatHint: ext,
        baseName,
        keys: Array.from(keys).filter(Boolean),
      };
      enqueue(entryPayload);
    }
  };

  for (const dir of discoverLowerThirdDirectories()) visit(dir, 0);

  lowerThirdMediaIndex.built = true;
  lowerThirdMediaIndex.entries = entries;
  lowerThirdMediaIndex.byKey = byKey;
  broadcastLog(`[DEBUG] Indexed ${entries.length} lower third assets`);
  return lowerThirdMediaIndex;
}

function resolveLowerThirdMedia(name: string): { filePath: string; documentsRelativePath?: string; formatHint?: string } | undefined {
  const normalized = normalizeLowerThirdKey(name);
  if (!normalized) return undefined;
  const index = indexLowerThirdMedia();
  if (!index.entries.length) {
    broadcastLog('[DEBUG] Lower third index empty when resolving asset');
  }
  const direct = index.byKey.get(normalized);
  if (direct && direct.length) {
    const pick = direct.sort((a, b) => a.baseName.localeCompare(b.baseName))[0];
    return { filePath: pick.filePath, documentsRelativePath: pick.documentsRelativePath, formatHint: pick.formatHint };
  }

  let best: LowerThirdEntry | undefined;
  let bestScore = 0;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (const entry of index.entries) {
    let score = 0;
    for (const key of entry.keys) {
      if (!key) continue;
      if (key === normalized) {
        score = Math.max(score, 100);
        break;
      }
      if (key.includes(normalized) || normalized.includes(key)) {
        score = Math.max(score, 70);
      } else if (tokens.length) {
        const keyTokens = key.split(/\s+/).filter(Boolean);
        const overlap = tokens.filter((token) => keyTokens.includes(token)).length;
        if (overlap) score = Math.max(score, overlap * 15);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  if (!best || bestScore < 30) {
    broadcastLog(`[DEBUG] Lower third candidate not strong enough • query=${normalized} score=${bestScore}`);
    return undefined;
  }
  return { filePath: best.filePath, documentsRelativePath: best.documentsRelativePath, formatHint: best.formatHint };
}

function extractBracketedName(title: string): string | undefined {
  if (!title) return undefined;
  const matches = title.matchAll(/\[([^\]]+)\]/g);
  for (const match of matches) {
    const candidate = (match[1] ?? '').trim();
    if (candidate) return candidate;
  }
  return undefined;
}

function parsePossibleTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    if (value > 1e6) return value * 1000;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isNaN(num)) {
        if (trimmed.length >= 13) return num;
        if (trimmed.length >= 10) return num * 1000;
      }
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function extractMediaPlaylistItems(source: any, playlistUuid?: string, playlistName?: string): MediaPlaylistItem[] {
  const items: MediaPlaylistItem[] = [];
  const seen = new Set<string>();
  const visit = (value: any) => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value === 'object') {
      const embedded = (value as any).id;
      if (embedded && typeof embedded === 'object') {
        const embeddedUuid = extractIdentifier(embedded);
        const embeddedName = extractName(embedded);
        if (embeddedUuid && embeddedName) {
          const key = embeddedUuid.trim().toLowerCase();
          if (!seen.has(key)) {
            const keywords = gatherStringCandidates({ ...embedded, ...value });
            const updatedAt = parsePossibleTimestamp((value as any).updatedAt
              ?? (value as any).updated_at
              ?? (value as any).modifiedAt
              ?? (value as any).modified_at
              ?? (value as any).createdAt
              ?? (value as any).created_at);
            const idValRaw = (value as any).uuid ?? (value as any).id;
            const idVal = typeof idValRaw === 'string'
              ? idValRaw
              : (typeof idValRaw === 'number' && Number.isFinite(idValRaw) ? String(idValRaw) : undefined);
            const payload: MediaPlaylistItem = {
              uuid: embeddedUuid,
              id: idVal && idVal !== embeddedUuid ? idVal : undefined,
              name: embeddedName,
              playlistUuid,
              playlistName,
              updatedAt,
              keywords,
            };
            const resolved = resolveMediaFilePath(embeddedName);
            if (resolved) {
              payload.filePath = resolved.filePath;
              payload.documentsRelativePath = resolved.documentsRelativePath;
              payload.formatHint = resolved.formatHint;
              broadcastLog(`[DEBUG] Titles media resolved • ${embeddedName} -> ${resolved.filePath}`);
            } else {
              broadcastLog(`[WARN] Titles media missing file path • ${embeddedName}`);
            }
            items.push(payload);
            seen.add(key);
          }
        }
      }
      if ((value as any).media && typeof (value as any).media === 'object') {
        visit((value as any).media);
      }
      const uuid = extractIdentifier(value);
      const name = extractName(value);
      if (uuid && name && isLikelyMediaObject(value)) {
        const key = uuid.trim().toLowerCase();
        if (!seen.has(key)) {
          const keywords = gatherStringCandidates(value);
          const updatedAt = parsePossibleTimestamp((value as any).updatedAt
            ?? (value as any).updated_at
            ?? (value as any).modifiedAt
            ?? (value as any).modified_at
            ?? (value as any).createdAt
            ?? (value as any).created_at
            ?? (value as any).importedAt
            ?? (value as any).import_timestamp);
          const idValRaw = (value as any).id;
          const idVal = typeof idValRaw === 'string'
            ? idValRaw
            : (typeof idValRaw === 'number' && Number.isFinite(idValRaw) ? String(idValRaw) : undefined);
          const payload: MediaPlaylistItem = {
            uuid,
            id: idVal && idVal !== uuid ? idVal : undefined,
            name,
            playlistUuid,
            playlistName,
            updatedAt,
            keywords,
          };
          const resolved = resolveMediaFilePath(name);
          if (resolved) {
            payload.filePath = resolved.filePath;
            payload.documentsRelativePath = resolved.documentsRelativePath;
            payload.formatHint = resolved.formatHint;
            broadcastLog(`[DEBUG] Titles media resolved • ${name} -> ${resolved.filePath}`);
          } else {
            broadcastLog(`[WARN] Titles media missing file path • ${name}`);
          }
          items.push(payload);
          seen.add(key);
        }
      }
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(source);
  return items;
}

function selectMediaMatch(topic: string, items: MediaPlaylistItem[]): MediaMatch | undefined {
  if (!topic || !items.length) return undefined;
  const canonical = topic.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!canonical) return undefined;
  const compactTopic = canonical.replace(/\s+/g, '');
  const tokens = canonical.split(/\s+/).filter((token) => token.length >= 3 && !TRANSITION_TOPIC_STOP_WORDS.has(token));
  let best: MediaMatch | undefined;
  for (const item of items) {
    const hay = item.keywords.map((k) => k.toLowerCase());
    const hayString = hay.join(' ');
    const hayCompact = hayString.replace(/\s+/g, '');
    let score = 0;
    if (hayString.includes(canonical)) score += 30;
    if (compactTopic && hayCompact.includes(compactTopic)) score += 15;
    const nameLow = item.name.toLowerCase();
    if (nameLow.includes(topic.toLowerCase())) score += 8;
    for (const token of tokens) {
      if (hayString.includes(token)) score += 10;
      else if (hayCompact.includes(token)) score += 6;
      else if (token.length >= 5) {
        const partial = token.slice(0, Math.max(3, Math.ceil(token.length * 0.6)));
        if (partial && hayString.includes(partial)) score += 2;
      }
    }
    if (item.updatedAt) {
      const ageDays = (Date.now() - item.updatedAt) / 86_400_000;
      if (Number.isFinite(ageDays)) {
        const recency = Math.max(0, 10 - ageDays);
        score += recency;
      }
    }
    if (!best || score > best.score || (score === best.score && (item.updatedAt ?? 0) > (best.updatedAt ?? 0))) {
      best = { ...item, score };
    }
  }
  if (best) return best;
  const fallback = items.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  return fallback ? { ...fallback, score: 0 } : undefined;
}

async function getMediaPlaylistItems(host: string, port: number, playlistName: string): Promise<MediaPlaylistItem[] | undefined> {
  const cacheKey = `${host}:${port}:${normalizeTitle(playlistName) || playlistName.trim().toLowerCase()}`;
  const existing = mediaPlaylistCache.get(cacheKey);
  if (existing) {
    try { return await existing; } catch { mediaPlaylistCache.delete(cacheKey); return undefined; }
  }
  const fetchPromise = (async () => {
    try {
      const playlistsRes = await fetchJson(host, port, '/v1/media/playlists');
      if (!(playlistsRes.status >= 200 && playlistsRes.status < 300)) {
        broadcastLog(`[WARN] Media playlists request failed (status=${playlistsRes.status})`);
        return undefined;
      }
      const source = playlistsRes.json ?? parseMaybeJson(playlistsRes.text);
      if (!source) {
        broadcastLog('[WARN] Media playlists response missing JSON payload.');
        return undefined;
      }
      const candidate = locatePlaylistCandidate(source, playlistName);
      if (!candidate) {
        broadcastLog(`[WARN] Media playlist "${playlistName}" not found in response.`);
        return undefined;
      }
      const playlistId = extractIdentifier(candidate);
      if (!playlistId) {
        broadcastLog(`[WARN] Media playlist "${playlistName}" missing identifier.`);
        return undefined;
      }
      const playlistUuid = typeof candidate.uuid === 'string' ? candidate.uuid : undefined;
      const playlistLabel = typeof candidate.name === 'string' && candidate.name.trim().length ? candidate.name : playlistName;
      const detailRes = await fetchJson(host, port, `/v1/media/playlist/${encodeURIComponent(playlistId)}`);
      if (!(detailRes.status >= 200 && detailRes.status < 300)) {
        broadcastLog(`[WARN] Media playlist fetch failed for "${playlistName}" (status=${detailRes.status}).`);
        return undefined;
      }
      const detailSource = detailRes.json ?? parseMaybeJson(detailRes.text);
      if (!detailSource) {
        broadcastLog(`[WARN] Media playlist "${playlistName}" returned no data.`);
        return undefined;
      }
      const items = extractMediaPlaylistItems(detailSource, playlistUuid, playlistLabel);
      if (!items.length) {
        broadcastLog(`[WARN] Media playlist "${playlistName}" produced no media candidates.`);
      }
      return items;
    } catch (err: any) {
      broadcastLog(`[WARN] Media playlist fetch error for "${playlistName}": ${err?.message || err}`);
      return undefined;
    }
  })();
  mediaPlaylistCache.set(cacheKey, fetchPromise);
  try {
    const result = await fetchPromise;
    if (!result) mediaPlaylistCache.delete(cacheKey);
    return result;
  } catch (err) {
    mediaPlaylistCache.delete(cacheKey);
    broadcastLog(`[WARN] Media playlist fetch threw for "${playlistName}": ${err}`);
    return undefined;
  }
}

function collectPropEntries(source: any): Map<string, { uuid: string; name: string }> {
  const result = new Map<string, { uuid: string; name: string }>();
  const visit = (value: any) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      const uuidRaw = (value as any).uuid ?? (value as any).id ?? (value as any).prop_uuid ?? (value as any).propUuid;
      const nameRaw = (value as any).name ?? (value as any).title ?? (value as any).label;
      const uuid = typeof uuidRaw === 'string' ? uuidRaw.trim() : undefined;
      const name = typeof nameRaw === 'string' ? nameRaw.trim() : undefined;
      if (uuid && name && uuid.length >= 4 && name.length > 0) {
        const typeHint = typeof (value as any).type === 'string' ? String((value as any).type).toLowerCase() : '';
        if (!typeHint || typeHint.includes('prop')) {
          const key = uuid.toLowerCase();
          if (!result.has(key)) result.set(key, { uuid, name });
        }
      }
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(source);
  return result;
}

function gatherPropUuidsFromNode(node: any, out: Set<string>) {
  if (!node) return;
  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (trimmed.length >= 8) out.add(trimmed);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item) => gatherPropUuidsFromNode(item, out));
    return;
  }
  if (typeof node === 'object') {
    for (const [key, val] of Object.entries(node)) {
      if (/prop.*uuid/i.test(key) && typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.length >= 8) out.add(trimmed);
      }
      gatherPropUuidsFromNode(val, out);
    }
  }
}

function collectPropCollections(source: any): Map<string, { collectionUuid: string; collectionName: string }> {
  const map = new Map<string, { collectionUuid: string; collectionName: string }>();
  const visit = (value: any) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      const uuidRaw = (value as any).uuid ?? (value as any).id;
      const nameRaw = (value as any).name ?? (value as any).title;
      const uuid = typeof uuidRaw === 'string' ? uuidRaw.trim() : undefined;
      const name = typeof nameRaw === 'string' ? nameRaw.trim() : undefined;
      if (uuid && name) {
        const propUuids = new Set<string>();
        for (const child of Object.values(value)) {
          if (Array.isArray(child) || (child && typeof child === 'object')) {
            gatherPropUuidsFromNode(child, propUuids);
          }
        }
        if (propUuids.size) {
          for (const propUuid of propUuids) {
            map.set(propUuid.toLowerCase(), { collectionUuid: uuid, collectionName: name });
          }
        }
      }
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(source);
  return map;
}

function normalizePropName(name: string): string {
  return name.toLowerCase().trim();
}

async function fetchPropIdentifier(host: string, port: number, propName: string): Promise<PropIdentifier | undefined> {
  const targetName = normalizePropName(propName);
  try {
    const propsRes = await fetchJson(host, port, '/v1/props');
    const source = propsRes.status >= 200 && propsRes.status < 300 ? (propsRes.json ?? parseMaybeJson(propsRes.text)) : undefined;
    if (!source) {
      broadcastLog(`[WARN] Prop list unavailable; prop slides will skip.`);
      return undefined;
    }
    const props = collectPropEntries(source);
    const match = Array.from(props.values()).find((entry) => normalizePropName(entry.name) === targetName);
    if (!match) {
      broadcastLog(`[WARN] Prop "${propName}" not found via API.`);
      return undefined;
    }

    let collectionUuid: string | undefined;
    let collectionName: string | undefined;
    try {
      const colRes = await fetchJson(host, port, '/v1/prop_collections');
      const colSource = colRes.status >= 200 && colRes.status < 300 ? (colRes.json ?? parseMaybeJson(colRes.text)) : undefined;
      if (colSource) {
        const mapping = collectPropCollections(colSource);
        const found = mapping.get(match.uuid.toLowerCase());
        if (found) {
          collectionUuid = found.collectionUuid;
          collectionName = found.collectionName;
        }
      }
    } catch (error) {
      broadcastLog(`[WARN] Prop collections lookup failed: ${String((error as any)?.message || error)}`);
    }

    return {
      propUuid: match.uuid,
      propName: match.name,
      collectionUuid,
      collectionName,
      triggerAutoClearEnabled: true,
      triggerAutoClearFollowsDuration: true,
    };
  } catch (error) {
    broadcastLog(`[WARN] Prop lookup failed: ${String((error as any)?.message || error)}`);
    return undefined;
  }
}

function findManualMediaMatch(topic: string, items: MediaPlaylistItem[], overrideTarget?: string): { match: MediaMatch; reason: string } | undefined {
  const rule = overrideTarget ? { targetName: overrideTarget } : TOPIC_MEDIA_RULES.find(entry => entry.pattern.test(topic));
  if (!rule) return undefined;
  const targetKey = normalizeMediaKey(rule.targetName);
  const source = items.find(item => normalizeMediaKey(item.name) === targetKey);
  if (!source) {
    broadcastLog(`[WARN] Media override target not found • ${rule.targetName}`);
    return undefined;
  }
  const manualMatch: MediaMatch = { ...source, score: 100 };
  return { match: manualMatch, reason: rule.targetName };
}

function deriveTopicOverrides(originalTopic: string): TopicOverrideSpec[] {
  const normalized = originalTopic.toLowerCase();

  if (/next\s*step/.test(normalized)) {
    return [{ topic: originalTopic, manualTarget: 'Next Steps' }];
  }

  const hasYouth = /life\s*youth/.test(normalized);
  const hasKidz = /life\s*kid/.test(normalized);
  if (hasYouth && hasKidz) {
    const overrides: { index: number; spec: TopicOverrideSpec }[] = [];
    const youthMatch = /life[^,&]*youth[^,&]*/i.exec(originalTopic);
    if (youthMatch) {
      overrides.push({ index: youthMatch.index, spec: { topic: youthMatch[0].trim(), manualTarget: 'LIFE Youth Jr' } });
    }
    const kidzMatch = /life[^,&]*kid[^,&]*/i.exec(originalTopic);
    if (kidzMatch) {
      overrides.push({ index: kidzMatch.index, spec: { topic: kidzMatch[0].trim(), manualTarget: 'LIFE Kidz' } });
    }
    if (overrides.length) {
      return overrides.sort((a, b) => a.index - b.index).map(entry => entry.spec);
    }
  }

  return [{ topic: originalTopic }];
}

loadLocalEnvOnce();

const singleInstanceReadyPromise = acquireSingleInstanceLock();

app.on('second-instance', (_event, argv, cwd) => {
  debugLog(`second-instance event argv=${argv.join(' ')} cwd=${cwd}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.moveTop();
  }
});

let mainWindow: BrowserWindow | null = null;
let pendingMainWindow: BrowserWindow | null = null;
let mainWindowPromise: Promise<BrowserWindow> | null = null;
let splashWindow: BrowserWindow | null = null;
let initialBootHandled = false;
let mainWindowInitialized = false;
const shouldOpenDevTools = (process.env.PROSYNC_OPEN_DEVTOOLS || '').trim() === '1';

function debugLog(message: string) {
  const ts = new Date().toISOString();
  try {
    console.log(`[main] ${ts} ${message}`);
  } catch {}
}

function isDevtoolsWindow(win: BrowserWindow | null): boolean {
  if (!win) return false;
  try {
    const url = win.webContents.getURL();
    if (url && url.startsWith('devtools://')) return true;
  } catch {}
  try {
    const title = win.getTitle();
    if (title && /devtools|developer tools/i.test(title)) return true;
  } catch {}
  return false;
}

async function applyTransitionTemplate(file: string, label: string, timerSeconds?: number, timerInfo?: TimerDescriptor, stageLayout?: StageLayoutDescriptor, topics?: TransitionTopicSpec[], propInfo?: PropIdentifier, lowerThird?: LowerThirdPayload): Promise<{ ok: boolean; code: number; out: string; err: string }> {
  const script = path.resolve(process.cwd(), 'scripts', 'pp_apply_transition_template.py');
  const args = [file, label, ''];
  const hasTimerSeconds = typeof timerSeconds === 'number' && Number.isFinite(timerSeconds) && timerSeconds > 0;
  args.push(hasTimerSeconds ? String(timerSeconds) : '');
  args.push(timerInfo ? JSON.stringify(timerInfo) : '');
  args.push(stageLayout ? JSON.stringify(stageLayout) : '');
  args.push(Array.isArray(topics) && topics.length ? JSON.stringify(topics) : '');
  args.push(propInfo ? JSON.stringify(propInfo) : '');
  args.push(lowerThird ? JSON.stringify(lowerThird) : '');
  const res = await runPythonScript(script, args);
  return { ok: res.code === 0, ...res };
}

async function applySongTemplate(file: string, payload: SongTemplatePayload): Promise<{ ok: boolean; code: number; out: string; err: string }> {
  const script = path.resolve(process.cwd(), 'scripts', 'pp_apply_song_template.py');
  const res = await runPythonScript(script, [file, JSON.stringify(payload)]);
  return { ok: res.code === 0, ...res };
}

async function fetchTimers(host: string, port: number): Promise<TimerDescriptor[]> {
  try {
    const res = await fetchJson(host, port, '/v1/timers');
    if (!(res.status >= 200 && res.status < 300)) return [];
    const source = res.json ?? parseMaybeJson(res.text);
    if (!source) return [];
    return extractTimersFromNode(source);
  } catch {
    return [];
  }
}

function resolveTransitionTimerFromEnv(): TimerDescriptor | undefined {
  const name = (process.env.PROSYNC_TRANSITION_TIMER_NAME || process.env.TRANSITION_TIMER_NAME || '').trim();
  const uuid = (process.env.PROSYNC_TRANSITION_TIMER_UUID || '').trim();
  const allowsRaw = (process.env.PROSYNC_TRANSITION_TIMER_ALLOW_OVERRUN || '').trim().toLowerCase();
  const allowsOverrun = allowsRaw === 'true' ? true : allowsRaw === 'false' ? false : undefined;
  if (!name && !uuid && allowsOverrun === undefined) return undefined;
  return {
    name: name || undefined,
    uuid: uuid || undefined,
    allowsOverrun,
  };
}

function getDesiredTimerName(): string {
  const name = (process.env.PROSYNC_TRANSITION_TIMER_NAME || process.env.TRANSITION_TIMER_NAME || '').trim();
  return name || DEFAULT_TRANSITION_TIMER_NAME;
}

async function ensureTransitionTimer(host: string, port: number, opts: TimerEnsureOptions): Promise<TimerDescriptor | undefined> {
  const desiredName = opts.desiredName.trim() || DEFAULT_TRANSITION_TIMER_NAME;
  const preferredUuid = opts.preferredUuid?.trim();
  const allows = opts.allowsOverrun;
  const timers = await fetchTimers(host, port);

  const matchByUuid = preferredUuid
    ? timers.find((t) => (t.uuid || '').toLowerCase() === preferredUuid.toLowerCase())
    : undefined;
  if (matchByUuid) return matchByUuid;

  const normalizedName = desiredName.toLowerCase();
  const matchByName = timers.find((t) => (t.name || '').trim().toLowerCase() === normalizedName);
  if (matchByName) return matchByName;

  const payload = {
    name: desiredName,
    allows_overrun: typeof allows === 'boolean' ? allows : true,
    countdown: { duration: 0 },
  };

  broadcastLog(`[INFO] Creating transition timer "${desiredName}"…`);
  const created = await createTimer(host, port, payload);
  if (created && created.uuid) {
    broadcastLog(`[INFO] Created transition timer ${created.name ?? created.uuid}.`);
    return created;
  }

  const refreshed = await fetchTimers(host, port);
  const refreshedMatch = refreshed.find((t) => (t.name || '').trim().toLowerCase() === normalizedName)
    || (preferredUuid ? refreshed.find((t) => (t.uuid || '').toLowerCase() === preferredUuid.toLowerCase()) : undefined);
  if (refreshedMatch) return refreshedMatch;

  broadcastLog('[WARN] Failed to create transition timer; timer cues may show a warning badge.');
  return undefined;
}

async function fetchStageLayouts(host: string, port: number): Promise<{ layouts: StageScreenDescriptor[]; screens: StageScreenDescriptor[] }> {
  const layoutsRes = await fetchJson(host, port, '/v1/stage/layouts');
  const layoutsSource = layoutsRes.status >= 200 && layoutsRes.status < 300 ? (layoutsRes.json ?? parseMaybeJson(layoutsRes.text)) : undefined;
  const layouts = layoutsSource ? collectNamedDescriptors(layoutsSource).items : [];

  const screensRes = await fetchJson(host, port, '/v1/stage/screens');
  const screensSource = screensRes.status >= 200 && screensRes.status < 300 ? (screensRes.json ?? parseMaybeJson(screensRes.text)) : undefined;
  const screens = screensSource ? collectNamedDescriptors(screensSource).items : [];

  return { layouts, screens };
}

async function ensureStageLayout(host: string, port: number, layoutName: string): Promise<StageLayoutDescriptor | undefined> {
  const desiredName = layoutName.trim();
  if (!desiredName) return undefined;

  const { layouts, screens } = await fetchStageLayouts(host, port);
  const match = layouts.find((l) => (l.name || '').trim().toLowerCase() === desiredName.toLowerCase() || (l.uuid || '').toLowerCase() === desiredName.toLowerCase());
  if (!match) {
    broadcastLog(`[WARN] Stage layout "${desiredName}" not found; stage display cues will be skipped.`);
    return undefined;
  }

  if (!screens.length) {
    broadcastLog('[WARN] No stage screens reported; stage display cues will be skipped.');
    return undefined;
  }
  const assignments = screens.map((s) => ({ uuid: s.uuid, name: s.name }));
  return {
    layoutUuid: match.uuid,
    layoutName: match.name || desiredName,
    assignments,
  };
}

async function indexPresentationsUuid(root: string): Promise<{ ok: boolean; count?: number; map?: Record<string, { path: string; title?: string }>; code?: number; err?: string; out?: string; error?: string }> {
  try {
    const script = path.resolve(process.cwd(), 'scripts', 'pp_index_presentations.py');
    const res = await runPythonScript(script, [root]);
    if (res.code !== 0) {
      console.warn('[pp-index-presentations-uuid] failed', { code: res.code, err: res.err.trim() || undefined, out: res.out.trim() || undefined });
      return { ok: false, code: res.code, err: res.err, out: res.out };
    }
    const map: Record<string, { path: string; title?: string }> = {};
    for (const line of res.out.split(/\r?\n/)) {
      const t = line.trim(); if (!t) continue;
      try {
        const j = JSON.parse(t);
        if (j.uuid && j.path) {
          const value = { path: j.path, title: j.title };
          const keys = new Set<string>();
          keys.add(String(j.uuid));
          const canon = canonicalUuid(j.uuid);
          if (canon) keys.add(canon);
          for (const key of keys) {
            map[key] = value;
          }
        }
      } catch {}
    }
    return { ok: true, count: Object.keys(map).length, map };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'spawn error' };
  }
}

async function isProPresenterRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const names = ['ProPresenter', 'ProPresenter 7'];
    for (const name of names) {
      try {
        const res = await runCommand('pgrep', ['-x', name]);
        if (res.code === 0) return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

async function quitProPresenter(timeoutMs = 15000): Promise<{ ok: boolean; message?: string }> {
  if (process.platform !== 'darwin') return { ok: true, message: 'non-mac platform: skip quit' };
  const running = await isProPresenterRunning();
  if (!running) return { ok: true, message: 'already closed' };
  try { await runCommand('pkill', ['-TERM', '-x', 'ProPresenter']); } catch {}
  try { await runCommand('pkill', ['-TERM', '-x', 'ProPresenter 7']); } catch {}
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isProPresenterRunning())) return { ok: true };
    await sleep(500);
  }
  try { await runCommand('pkill', ['-9', '-x', 'ProPresenter']); } catch {}
  try { await runCommand('pkill', ['-9', '-x', 'ProPresenter 7']); } catch {}
  await sleep(500);
  return (await isProPresenterRunning()) ? { ok: false, message: 'Timed out waiting for ProPresenter to close' } : { ok: true, message: 'Force quit' };
}

type LaunchAttemptResult = { ok: boolean; launched: boolean; alreadyRunning: boolean; appName?: string; message?: string };
type WaitForReadyResult = { ok: boolean; ready: boolean; message?: string; lastError?: string; elapsedMs: number };

async function attemptLaunchProPresenterApp(): Promise<LaunchAttemptResult> {
  if (process.platform !== 'darwin') {
    return { ok: true, launched: false, alreadyRunning: false, message: 'non-mac platform: skip launch' };
  }

  if (await isProPresenterRunning()) {
    debugLog('ProPresenter already running; skipping launch command');
    return { ok: true, launched: false, alreadyRunning: true };
  }

  const configuredPath = (process.env.PROSYNC_PP_APP || '').trim();
  const configuredName = (process.env.PROSYNC_PP_APP_NAME || '').trim();
  const candidates = [configuredPath, configuredName, 'ProPresenter 7', 'ProPresenter', 'ProPresenter 7.app', 'ProPresenter.app']
    .map((item) => item.trim())
    .filter((item, idx, arr) => item.length > 0 && arr.indexOf(item) === idx);

  const errors: string[] = [];

  for (const candidate of candidates) {
    const useDirectPath = candidate.includes('/') || candidate.endsWith('.app');
    const args = useDirectPath ? [candidate] : ['-a', candidate];
    broadcastLog(`[INFO] Launching ${candidate}…`);
    try {
      const res = await runCommand('open', args);
      if (res.code === 0) {
        return { ok: true, launched: true, alreadyRunning: false, appName: candidate };
      }
      const detail = [res.err?.trim(), res.out?.trim()].filter(Boolean).join(' ');
      errors.push(`${candidate} (code=${res.code}${detail ? `, ${detail}` : ''})`);
    } catch (err: any) {
      const message = err?.message || String(err);
      errors.push(`${candidate} (${message})`);
    }
  }

  return {
    ok: false,
    launched: false,
    alreadyRunning: false,
    message: errors.length ? `Failed to launch ProPresenter (${errors.join('; ')})` : 'Failed to launch ProPresenter',
  };
}

async function waitForProPresenterReady(host: string, port: number, options: { pollIntervalMs?: number; readyTimeoutMs?: number } = {}): Promise<WaitForReadyResult> {
  if (process.platform !== 'darwin') {
    return { ok: true, ready: true, message: 'non-mac platform: assume ready', elapsedMs: 0 };
  }

  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 750);
  const readyTimeoutMs = Math.max(5000, options.readyTimeoutMs ?? 60000);
  const started = Date.now();
  let lastError: string | undefined;

  while (Date.now() - started < readyTimeoutMs) {
    if (!(await isProPresenterRunning())) {
      await sleep(pollIntervalMs);
      continue;
    }

    try {
      const res = await testConnection({ host, port });
      if (res.reachable) {
        const pathInfo = res.pathTried ? ` via ${res.pathTried}` : '';
        const latency = res.latencyMs ? ` • ${res.latencyMs}ms` : '';
        return {
          ok: true,
          ready: true,
          message: `ProPresenter API reachable${pathInfo}${latency}`,
          elapsedMs: Date.now() - started,
        };
      }
      lastError = res.error || (res.statusCode ? `HTTP ${res.statusCode}` : undefined) || 'API unreachable';
    } catch (err: any) {
      lastError = err?.message || String(err);
    }

    await sleep(pollIntervalMs);
  }

  return {
    ok: false,
    ready: false,
    message: 'Timed out waiting for ProPresenter to become ready',
    lastError,
    elapsedMs: Date.now() - started,
  };
}

async function launchProPresenter(host: string, port: number, timeoutMs = 60000, initialAttempt?: LaunchAttemptResult): Promise<{ ok: boolean; message?: string }> {
  if (process.platform !== 'darwin') return { ok: true, message: 'non-mac platform: skip launch' };

  const attempt = initialAttempt ?? await attemptLaunchProPresenterApp();
  if (!attempt.ok && !attempt.alreadyRunning) {
    const stillRunning = await isProPresenterRunning();
    if (!stillRunning) {
      return { ok: false, message: attempt.message || 'Failed to launch ProPresenter' };
    }
  }

  const wait = await waitForProPresenterReady(host, port, { readyTimeoutMs: timeoutMs });
  if (!wait.ok) {
    const detail = wait.lastError ? ` (${wait.lastError})` : '';
    return { ok: false, message: `${wait.message ?? 'ProPresenter not ready'}${detail}` };
  }

  if (attempt.ok && attempt.appName) {
    broadcastLog(`[INFO] ProPresenter ready after launching ${attempt.appName}.`);
  } else if (attempt.alreadyRunning) {
    broadcastLog('[INFO] ProPresenter already running; connection verified.');
  } else {
    broadcastLog('[INFO] ProPresenter ready.');
  }

  if (wait.message) {
    broadcastLog(`[INFO] ${wait.message}`);
  }

  return { ok: true, message: wait.message };
}

async function ensureMainWindow(): Promise<BrowserWindow> {
  debugLog(`ensureMainWindow invoked mainWindowExists=${!!mainWindow} pending=${!!pendingMainWindow} promise=${!!mainWindowPromise}`);
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  if (mainWindowPromise) return mainWindowPromise;

  mainWindowPromise = (async () => {
    debugLog('ensureMainWindow creating BrowserWindow');
    const preloadPath = app.isPackaged
      ? path.join(__dirname, 'preload.cjs')
      // In dev, load the unbundled CJS preload to avoid ESM issues
      : path.join(app.getAppPath(), 'electron', 'preload.cjs');

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: 'ProPresenter Sync',
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      }
    });

    pendingMainWindow = win;
    mainWindow = win;
    debugLog('ensureMainWindow BrowserWindow instantiated');

    win.on('closed', () => {
      debugLog('mainWindow closed event');
      if (mainWindow === win) mainWindow = null;
      if (pendingMainWindow === win) pendingMainWindow = null;
      mainWindowPromise = null;
      if (mainWindow === null && pendingMainWindow === null) mainWindowInitialized = false;
    });

    try {
      if (!app.isPackaged) {
        const devUrl = 'http://localhost:5173';
        let loaded = false;
        for (let attempt = 0; attempt < 12 && !loaded; attempt++) {
          try {
            debugLog(`ensureMainWindow dev load attempt ${attempt + 1}`);
            await win.loadURL(devUrl);
            loaded = true;
            debugLog('ensureMainWindow dev load succeeded');
          } catch (err) {
            const delay = 500;
            debugLog(`ensureMainWindow dev load failed: ${(err as any)?.message || err}`);
            await sleep(delay);
          }
        }
        if (!loaded) {
          try {
            debugLog('ensureMainWindow loading dist index as fallback');
            await win.loadFile(path.join(__dirname, '../dist/index.html'));
            loaded = true;
            debugLog('ensureMainWindow dist load succeeded');
          } catch (fallbackErr) {
            const rawMessage = (fallbackErr as any)?.message || 'Failed to load UI';
            const safeMessage = String(rawMessage).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));
            const html = `<h2 style="font-family: sans-serif; color: #f87171; background: #0f172a; margin:0; height:100vh; display:flex; align-items:center; justify-content:center;">${safeMessage}</h2>`;
            debugLog(`ensureMainWindow fallback load failed; rendering error message: ${safeMessage}`);
            await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
          }
        }
        if (loaded && shouldOpenDevTools) {
          debugLog('ensureMainWindow opening devtools');
          try { win.webContents.openDevTools({ mode: 'detach' }); } catch {}
        }
      } else {
        debugLog('ensureMainWindow loading packaged index.html');
        await win.loadFile(path.join(__dirname, '../dist/index.html'));
      }
    } catch (err) {
      debugLog(`ensureMainWindow encountered error: ${(err as any)?.message || err}`);
      win.destroy();
      if (pendingMainWindow === win) pendingMainWindow = null;
      if (mainWindow === win) mainWindow = null;
      mainWindowPromise = null;
      throw err;
    }

    if (pendingMainWindow === win) pendingMainWindow = null;
    mainWindowInitialized = true;
    debugLog('ensureMainWindow finished successfully');
    return win;
  })();

  try {
    return await mainWindowPromise;
  } finally {
    if (!mainWindow) {
      mainWindowPromise = null;
    }
  }
}

function createSplashWindow(): BrowserWindow {
  debugLog('createSplashWindow invoked');
  const splashPath = app.isPackaged
    ? path.join(__dirname, 'splash.html')
    : path.join(app.getAppPath(), 'electron', 'splash.html');

  const splash = new BrowserWindow({
    width: 500,
    height: 320,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    show: true,
    transparent: false,
    center: true,
  });

  splash.setMenuBarVisibility(false);
  splash.loadFile(splashPath).catch(() => splash.close());
  splash.on('closed', () => {
    if (splashWindow === splash) splashWindow = null;
  });
  return splash;
}

function revealMainWindow() {
  debugLog('revealMainWindow called');
  initialBootHandled = true;
  if (splashWindow && !splashWindow.isDestroyed()) {
    debugLog('closing splash window');
    splashWindow.close();
    splashWindow = null;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === splashWindow || win === mainWindow || win === pendingMainWindow) continue;
    if (isDevtoolsWindow(win)) continue;
    if (!win.isDestroyed()) {
      debugLog('closing unexpected extra window');
      try { win.close(); } catch {}
    }
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
  if (process.platform === 'darwin') {
    try { app.focus(); } catch {}
  }
}

app.whenReady().then(async () => {
  if (!(await singleInstanceReadyPromise)) {
    debugLog('requestSingleInstanceLock failed after retries; exiting secondary instance');
    app.quit();
    return;
  }

  debugLog('app.whenReady resolved');
  app.on('browser-window-created', (_event, win) => {
    debugLog('browser-window-created event fired');
    if (win === splashWindow || win === mainWindow || win === pendingMainWindow) return;
    if (isDevtoolsWindow(win)) return;
    setImmediate(() => {
      if (win.isDestroyed()) return;
      if (win === splashWindow || win === mainWindow || win === pendingMainWindow) return;
      if (isDevtoolsWindow(win)) return;
      debugLog('closing unexpected browser window');
      try { win.close(); } catch {}
    });
  });

  const { host, port } = resolveDefaultProPresenterEndpoint();

  let initialLaunchAttempt: LaunchAttemptResult | undefined;
  if (process.platform === 'darwin') {
    try {
      debugLog('initiating ProPresenter launch before splash');
      initialLaunchAttempt = await attemptLaunchProPresenterApp();
    } catch (err: any) {
      const message = err?.message || String(err);
      debugLog(`attemptLaunchProPresenterApp threw: ${message}`);
      broadcastLog(`[WARN] Failed to initiate ProPresenter launch: ${message}`);
    }
  }

  splashWindow = createSplashWindow();
  debugLog('splash window created');

  try {
    debugLog('waiting for ProPresenter readiness');
    const launchRes = await launchProPresenter(host, port, 60000, initialLaunchAttempt);
    if (!launchRes.ok) {
      broadcastLog(`[WARN] Failed to prepare ProPresenter: ${launchRes.message ?? 'unknown error'}`);
    }
  } catch (err) {
    debugLog(`launchProPresenter threw: ${(err as any)?.message || err}`);
    broadcastLog(`[WARN] Failed to prepare ProPresenter: ${err?.message ?? err ?? 'unknown error'}`);
  }

  try {
    await ensureMainWindow();
    mainWindowInitialized = true;
  } catch (err: any) {
    console.error('[main] Failed to create main window', err);
  }

  app.on('activate', async () => {
    debugLog('app activate event fired');
    if (pendingMainWindow) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (!mainWindowInitialized) return;
      debugLog('activate ensuring main window');
      await ensureMainWindow();
    } else if (!mainWindow.isVisible() && initialBootHandled) {
      debugLog('activate bringing main window to front');
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC — Sunday Prep pipeline (logs to UI)
ipcMain.handle('run-sunday-prep', async (_e, payload: { date?: string }) => {
  broadcastLog('[INFO] Starting Sunday Prep…');
  try {
    const next = await pcoGetNextPlan();
    if (!next.ok || !next.plan) {
      broadcastLog(`[ERROR] Failed to fetch plan: ${next.error ?? 'unknown error'}`);
      return { ok: false, message: next.error ?? 'Failed to fetch plan' };
    }
    const plan = next.plan;
    broadcastLog(`[INFO] Fetched plan: ${plan.title} (${plan.date}) with ${plan.items.length} items`);
    // Future: create/update ProPresenter playlist here
    broadcastLog('[INFO] Sunday Prep finished');
    return { ok: true, message: `Plan ready: ${plan.title} (${plan.date})`, plan };
  } catch (e: any) {
    broadcastLog(`[ERROR] Pipeline error: ${e?.message || e}`);
    return { ok: false, message: e?.message || 'Pipeline error' };
  }
});

// ProPresenter test
ipcMain.handle('pp-test', async (_e, cfg: { host: string; port: number; password?: string }) => {
  return await testConnection(cfg);
});

ipcMain.handle('pp-is-running', async () => {
  try {
    return { ok: true, running: await isProPresenterRunning() };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'error', running: false };
  }
});

ipcMain.handle('app-boot-complete', async () => {
  revealMainWindow();
  return { ok: true };
});

// pp-action removed after testing

// pp-action removed (reverted)

ipcMain.handle('pco-save-and-test', async (_e, payload: { appId: string; secret: string }) => {
  try {
    await pcoSave({ appId: payload.appId, secret: payload.secret });
    const res = await pcoTest({ appId: payload.appId, secret: payload.secret });
    return res;
  } catch (e: any) {
    return { ok: false, error: e?.message || 'error' };
  }
});

ipcMain.handle('pco-test', async () => {
  try {
    return await pcoTestHardcoded();
  } catch (e: any) {
    return { ok: false, error: e?.message || 'error' };
  }
});

ipcMain.handle('pco-next-plan', async () => {
  try {
    return await pcoGetNextPlan();
  } catch (e: any) {
    return { ok: false, error: e?.message || 'error' };
  }
});

ipcMain.handle('pp-match', async (_e, payload: { host: string; port: number; titles: string[] }) => {
  try {
    return await matchPresentations(payload);
  } catch (e: any) {
    return { matches: {}, error: e?.message || 'error' } as any;
  }
});

ipcMain.handle('pp-sync-playlist', async (_e, payload: { host: string; port: number; name: string; titles: string[] }) => {
  try {
    return await syncPlaylist(payload);
  } catch (e: any) {
    return { ok: false, changed: false, error: e?.message || 'error' } as any;
  }
});

// Utilities — file-based operator notes writes via Python
function defaultMacLibraries(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cands = [
    path.join(home, 'Documents', 'ProPresenter', 'Libraries', 'Presentations'),
    path.join(home, 'Documents', 'ProPresenter', 'Libraries'),
  ];
  return cands.filter(p => !!p);
}

ipcMain.handle('pp-find-library-root', async () => {
  const cands = defaultMacLibraries();
  let best: { path: string; files: number } | null = null;
  for (const p of cands) {
    try {
      const entries = fs.readdirSync(p, { withFileTypes: true });
      const count = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pro')).length;
      if (!best || count > best.files) best = { path: p, files: count };
    } catch {}
  }
  return { ok: !!best, best, candidates: cands };
});

ipcMain.handle('pp-index-presentations', async (_e, payload: { root: string }) => {
  const { root } = payload;
  const result: Record<string, { path: string; title?: string }> = {};
  function walk(dir: string) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.pro')) continue;
      // For now, index by filename stem as a fallback; python-based UUID extraction can be added later if needed
      // We will rely on title-to-uuid matching we already do, then map uuid->path via filename search if name matches.
      result[path.basename(ent.name, '.pro')] = { path: full } as any;
    }
  }
  walk(root);
  return { ok: true, count: Object.keys(result).length, map: result };
});

ipcMain.handle('pp-write-operator-notes-file', async (_e, payload: { file: string; notes: string }) => {
  const { file, notes } = payload;
  try {
    return await writeOperatorNotesFile(file, notes);
  } catch (e: any) {
    return { ok: false, error: e?.message || 'spawn error' };
  }
});

ipcMain.handle('pp-index-presentations-uuid', async (_e, payload: { root: string }) => {
  const root = payload.root;
  return await indexPresentationsUuid(root);
});

type PresentationSyncPayload = { host: string; port: number; libraryRoot: string; reopen?: boolean; categories?: string[]; itemIds?: string[] };

async function runPresentationSync(payload: PresentationSyncPayload) {
  const { host, port, libraryRoot, reopen = true, categories, itemIds } = payload || {} as any;
  if (!host || !port) return { ok: false, error: 'Missing host/port' };
  if (!libraryRoot) return { ok: false, error: 'Missing library path' };

  const requestedCategories = Array.isArray(categories)
    ? categories.map((cat) => String(cat || '').trim()).filter((cat) => cat.length > 0)
    : [];
  const categoryFilter = requestedCategories.length
    ? new Set(requestedCategories.map((cat) => cat.toLowerCase()))
    : null;
  const requestedIds = Array.isArray(itemIds)
    ? itemIds.map((id) => String(id || '').trim()).filter((id) => id.length > 0)
    : [];
  const idFilter = requestedIds.length ? new Set(requestedIds) : null;

  broadcastLog('[INFO] Presentation sync started…');
  broadcastLog(`[DEBUG] Payload • host=${host}, port=${port}, libraryRoot=${libraryRoot}, reopen=${reopen}`);
  if (categoryFilter) {
    broadcastLog(`[DEBUG] Category filter active: ${requestedCategories.join(', ')}`);
  }
  if (idFilter) {
    broadcastLog(`[DEBUG] Item ID filter active: ${requestedIds.join(', ')}`);
  }
  try {
    broadcastLog('[INFO] Fetching next plan from Planning Center…');
    const next = await pcoGetNextPlan();
    if (!next.ok || !next.plan) {
      const err = next.error || 'Failed to fetch plan';
      broadcastLog(`[ERROR] Presentation sync aborted: ${err}`);
      return { ok: false, error: err };
    }
    const plan = next.plan;
    const items = Array.isArray(plan.items) ? plan.items : [];
    broadcastLog(`[INFO] Loaded plan "${plan.title}" with ${items.length} items`);

    const titles = items.map((it: any) => it.title);
    broadcastLog('[INFO] Matching plan items to ProPresenter presentations…');
    const matches = await matchPresentations({ host, port, titles });

    const desiredTimerName = getDesiredTimerName();
    const envTimer = resolveTransitionTimerFromEnv();
    let transitionTimer: TimerDescriptor | undefined;
    
    if (envTimer) {
      transitionTimer = await ensureTransitionTimer(host, port, {
        desiredName: envTimer.name || desiredTimerName,
        allowsOverrun: envTimer.allowsOverrun,
        preferredUuid: envTimer.uuid,
      });
      if (!transitionTimer && envTimer.uuid) {
        broadcastLog(`[WARN] Configured transition timer UUID ${envTimer.uuid} was not found; attempting to create "${desiredTimerName}".`);
        transitionTimer = await ensureTransitionTimer(host, port, {
          desiredName: desiredTimerName,
          allowsOverrun: envTimer.allowsOverrun,
        });
      }
    } else {
      transitionTimer = await ensureTransitionTimer(host, port, {
        desiredName: desiredTimerName,
      });
    }

    if (transitionTimer) {
      broadcastLog(`[INFO] Transition timer set to ${transitionTimer.name ?? transitionTimer.uuid ?? desiredTimerName}.`);
    }

    const stageLayout = await ensureStageLayout(host, port, process.env.PROSYNC_TRANSITION_STAGE_LAYOUT_NAME || 'Notes');
    if (stageLayout) {
      broadcastLog(`[INFO] Stage layout set to ${stageLayout.layoutName ?? 'Notes'}.`);
    }

    broadcastLog(`[INFO] Indexing ProPresenter library at ${libraryRoot}…`);
    const indexRes = await indexPresentationsUuid(libraryRoot);
    if (!indexRes.ok || !indexRes.map) {
      const detail = indexRes.err || indexRes.error || 'index failed';
      broadcastLog(`[ERROR] Presentation sync aborted: library index failed (${detail.trim?.() || detail})`);
      return { ok: false, error: 'Library index failed', details: detail };
    }
    broadcastLog(`[INFO] Indexed ${indexRes.count ?? 0} presentations`);

    const mapByUuid = indexRes.map;
    const titleMap = new Map<string, { path: string; title?: string }>();
    for (const entry of Object.values(mapByUuid)) {
      if (!entry || !entry.path) continue;
      const fallback = path.basename(entry.path, path.extname(entry.path));
      const key = normalizeTitle(entry.title || fallback);
      if (key && !titleMap.has(key)) titleMap.set(key, entry);
    }

    const summary = { updated: 0, skipped: 0, noDesc: 0, missingPath: 0, writeErrors: 0 };
    const categoriesByUuid: Record<string, string> = {};
    const missingInfo: { title: string; uuid?: string }[] = [];
    const shouldReopen = reopen !== false && process.platform === 'darwin';
    let reopenOutcome: { ok: boolean; message?: string } | null = null;

    broadcastLog('[INFO] Prefetching Titles media playlist…');
    const titlesMediaItems = await getMediaPlaylistItems(host, port, 'Titles');
    if (!titlesMediaItems || !titlesMediaItems.length) {
      broadcastLog('[WARN] Titles media playlist unavailable or empty while ProPresenter was running; media cues may fall back to blanks.');
    }

    const clearPropInfo = await fetchPropIdentifier(host, port, CLEAR_PROP_NAME);
    if (!clearPropInfo) {
      broadcastLog(`[WARN] Prop "${CLEAR_PROP_NAME}" not found; clear slides will omit prop action.`);
    }

    if (shouldReopen) {
      broadcastLog('[INFO] Closing ProPresenter…');
      const quitRes = await quitProPresenter();
      if (!quitRes.ok) {
        const msg = quitRes.message || 'Failed to close ProPresenter';
        broadcastLog(`[ERROR] Presentation sync aborted: ${msg}`);
        return { ok: false, error: msg };
      }
    }

    broadcastLog('[DEBUG] Plan items and categories:');
    for (const item of items) {
      const cat = resolvePlanItemCategory(item);
      broadcastLog(`[DEBUG] • ${(item.title || '').trim()} => ${cat ?? 'none'}`);
    }

    try {
      for (const item of items) {
        if (item?.isHeader) continue;
        const title = String(item?.title || '').trim();
        const itemId = String(item?.id || '').trim();
        if (idFilter && !idFilter.has(itemId)) continue;
        const notesOverride = typeof (item as any)?.notes === 'string' ? String((item as any).notes).trim() : '';
        const descOverride = typeof (item as any)?.description === 'string' ? String((item as any).description).trim() : '';
        if (!title) { summary.skipped++; continue; }
        const categoryLabel = resolvePlanItemCategory(item);
        if (categoryFilter && (!categoryLabel || !categoryFilter.has(categoryLabel.toLowerCase()))) {
          continue;
        }
        const match = matches?.matches?.[title];
        const uuidRaw = typeof match?.uuid === 'string' ? match.uuid : undefined;
        const desc = descOverride || notesOverride;
        if (!uuidRaw) { summary.skipped++; continue; }
        if (!desc) { summary.noDesc++; continue; }
        const canon = canonicalUuid(uuidRaw);
        const titleKey = normalizeTitle(title);
        const hit = (uuidRaw ? mapByUuid[uuidRaw] : undefined)
          || (canon ? mapByUuid[canon] : undefined)
          || (titleKey ? titleMap.get(titleKey) : undefined);
        if (!hit || !hit.path) {
          summary.missingPath++;
          missingInfo.push({ title, uuid: uuidRaw });
          broadcastLog(`[DEBUG] Transition skip (no file) • ${title}`);
          continue;
        }
        if (!categoryLabel) {
          broadcastLog(`[DEBUG] No category computed • ${title}`);
        }
        if (categoryLabel === 'Song') {
          const songDetails = (item as any)?.songDetails;
          const rawSections: any[] = Array.isArray(songDetails?.sections) ? songDetails.sections : [];
          const sectionsPayload: SongTemplateSectionPayload[] = rawSections
            .map((section) => {
              const rawSlides: any[] = Array.isArray(section?.lyricSlides) ? section.lyricSlides : [];
              const slides = rawSlides
                .map((slide) => Array.isArray(slide) ? slide.map((line) => String(line ?? '').trim()).filter((line) => line.length) : [])
                .filter((slide) => slide.length > 0);
              const sequenceLabel = typeof section?.sequenceLabel === 'string' ? section.sequenceLabel : undefined;
              const sectionName = typeof section?.name === 'string' ? section.name : undefined;
              const labelSource = sequenceLabel || sectionName || '';
              const isNonLyric = NON_LYRIC_SECTION_PATTERN.test(labelSource);
              if (!slides.length) {
                if (!isNonLyric) return null;
                return {
                  id: typeof section?.id === 'string' ? section.id : undefined,
                  name: sectionName,
                  sequenceLabel,
                  slides: [],
                } satisfies SongTemplateSectionPayload;
              }
              return {
                id: typeof section?.id === 'string' ? section.id : undefined,
                name: sectionName,
                sequenceLabel,
                slides,
              } satisfies SongTemplateSectionPayload;
            })
            .filter((section): section is SongTemplateSectionPayload => Boolean(section));

          const seenSectionIds = new Set<string>();
          const seenLabels = new Set<string>();
          for (const section of sectionsPayload) {
            if (section.id) seenSectionIds.add(section.id);
            const key = (section.sequenceLabel || section.name || '').trim().toLowerCase();
            if (key) seenLabels.add(key);
          }

          const sequenceEntries: any[] = Array.isArray(songDetails?.sequence) ? songDetails.sequence : [];
          for (const entry of sequenceEntries) {
            const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
            const sectionId = typeof entry?.sectionId === 'string' ? entry.sectionId : undefined;
            if (!label && !sectionId) continue;
            if (sectionId && seenSectionIds.has(sectionId)) continue;
            const labelKey = label.toLowerCase();
            if (labelKey && seenLabels.has(labelKey)) continue;
            if (!NON_LYRIC_SECTION_PATTERN.test(label)) continue;
            sectionsPayload.push({
              id: sectionId,
              name: label || undefined,
              sequenceLabel: label || undefined,
              slides: [],
            });
            if (sectionId) seenSectionIds.add(sectionId);
            if (labelKey) seenLabels.add(labelKey);
          }

          if (!sectionsPayload.length) {
            broadcastLog(`[DEBUG] Song rewrite skipped (no lyric slides) • ${title}`);
          } else {
            if (title.toLowerCase().includes('i thank god')) {
              broadcastLog('[DEBUG] Song sections (I Thank God):');
              for (const section of sectionsPayload) {
                const label = section.sequenceLabel || section.name || '(unnamed)';
                broadcastLog(`  - ${label}: ${section.slides.length} slides`);
              }
              if (Array.isArray(songDetails?.sequence)) {
                broadcastLog('[DEBUG] Song sequence entries (I Thank God):');
                for (const entry of songDetails.sequence) {
                  const label = typeof entry?.label === 'string' ? entry.label : '(no label)';
                  broadcastLog(`  • ${label}`);
                }
              }
            }
            broadcastLog(`[INFO] Song rewrite start • ${title} -> ${hit.path}`);
            const songPayload: SongTemplatePayload = {
              title,
              groupName: typeof songDetails?.groupName === 'string' ? songDetails.groupName : 'Lyrics',
              arrangementName: typeof songDetails?.arrangementName === 'string' ? songDetails.arrangementName : 'Default',
              sections: sectionsPayload,
            };
            try {
              const songRes = await applySongTemplate(hit.path, songPayload);
              if (!songRes.ok) {
                summary.writeErrors++;
                broadcastLog(`[WARN] Song rewrite failed • ${title}: ${songRes.err.trim() || songRes.out.trim() || 'unknown error'}`);
              } else {
                const trimmedOut = songRes.out.trim();
                if (trimmedOut) {
                  for (const line of trimmedOut.split(/\r?\n/)) {
                    broadcastLog(`[DEBUG] SONG:${line}`);
                  }
                }
                const trimmedErr = songRes.err.trim();
                if (trimmedErr) {
                  for (const line of trimmedErr.split(/\r?\n/)) {
                    broadcastLog(`[DEBUG] SONGERR:${line}`);
                  }
                }
                broadcastLog(`[INFO] Song rewrite done • ${title}`);
              }
            } catch (err: any) {
              summary.writeErrors++;
              broadcastLog(`[WARN] Song rewrite crashed • ${title}: ${err?.message || err}`);
            }
          }
        } else if (categoryLabel === 'Transitions') {
          broadcastLog(`[INFO] Transition rewrite start • ${title} -> ${hit.path}`);
          const rawLength = Number((item as any)?.lengthSeconds);
          const timerSeconds = Number.isFinite(rawLength) && rawLength > 0 ? rawLength : undefined;
          if (timerSeconds) {
            broadcastLog(`[DEBUG] Transition timer length ${timerSeconds}s • ${title}`);
          }
          const lowerThirdName = extractBracketedName(title);
          if (!lowerThirdName) {
            broadcastLog(`[DEBUG] Transition lower third skipped (no [Name] in title) • ${title}`);
          }
          let lowerThirdPayload: LowerThirdPayload | undefined;
          if (lowerThirdName) {
            const resolvedLowerThird = resolveLowerThirdMedia(lowerThirdName);
            if (resolvedLowerThird && resolvedLowerThird.filePath) {
              lowerThirdPayload = { name: lowerThirdName, ...resolvedLowerThird };
              broadcastLog(`[INFO] Transition lower third match • ${lowerThirdName} -> ${resolvedLowerThird.filePath}`);
            } else {
              broadcastLog(`[WARN] Transition lower third missing asset • ${lowerThirdName}`);
            }
          }
          const topics = extractTransitionTopics(desc);
          const topicPayload: TransitionTopicSpec[] = [];
          if (topics.length) {
            const available = titlesMediaItems ? [...titlesMediaItems] : [];
            for (const originalTopic of topics) {
              const overrides = deriveTopicOverrides(originalTopic);
              for (const overrideSpec of overrides) {
                const topicText = overrideSpec.topic.trim();
                if (!topicText) continue;
                const topicLower = topicText.toLowerCase();
                let match: MediaMatch | undefined;
                const requestsPhotos = topicRequestsPhotos(topicText);
                const galleryItems = requestsPhotos ? resolveTopicPhotos(topicText) : undefined;
                if (requestsPhotos && (!galleryItems || !galleryItems.length)) {
                  broadcastLog(`[WARN] Transition photos missing assets • ${topicText}`);
                }

                if (available.length) {
                  const manual = findManualMediaMatch(topicLower, available, overrideSpec.manualTarget);
                  if (manual) {
                    match = { ...manual.match, score: manual.match.score ?? 100 };
                    broadcastLog(`[DEBUG] Transition media override • ${topicText} -> ${manual.reason}`);
                  }
                }

                if (!match && available.length) {
                  const candidate = selectMediaMatch(topicText, available);
                  if (candidate && candidate.filePath && candidate.score >= MIN_TRANSITION_MEDIA_SCORE) {
                    match = candidate;
                  } else if (candidate) {
                    const scoreText = Number.isFinite(candidate.score) ? candidate.score.toFixed(2) : String(candidate.score);
                    broadcastLog(`[WARN] Transition media candidate too weak • ${topicText} -> ${candidate.name} (score=${scoreText})`);
                  }
                }

                if (!match) {
                  broadcastLog(`[WARN] Transition media skipped • ${topicText} (no suitable asset)`);
                  continue;
                }

                if (!match.filePath) {
                  broadcastLog(`[WARN] Transition media missing file path • ${topicText} -> ${match.name}`);
                  continue;
                }

                const key = match.uuid.trim().toLowerCase();
                const idx = available.findIndex((entry) => entry.uuid.trim().toLowerCase() === key);
                if (idx >= 0) available.splice(idx, 1);

                const scoreText = Number.isFinite(match.score) ? match.score.toFixed(2) : String(match.score);
                broadcastLog(`[DEBUG] Transition media match • ${topicText} -> ${match.name} (score=${scoreText})`);

                const entry: TransitionTopicSpec = {
                  topic: topicText,
                  media: {
                    uuid: match.uuid,
                    id: match.id,
                    name: match.name,
                    playlistUuid: match.playlistUuid,
                    playlistName: match.playlistName,
                    updatedAt: match.updatedAt,
                    score: match.score,
                    filePath: match.filePath,
                    documentsRelativePath: match.documentsRelativePath,
                    formatHint: match.formatHint,
                  },
                };
                if (galleryItems && galleryItems.length) {
                  entry.gallery = galleryItems;
                }
                topicPayload.push(entry);
              }
            }
          }
          if (!topicPayload.length) {
            broadcastLog('[INFO] Transition topics produced no media slides; applying base template only.');
          }
          const transitionRes = await applyTransitionTemplate(
            hit.path,
            'Background & Lights',
            timerSeconds,
            transitionTimer,
            stageLayout,
            topicPayload.length ? topicPayload : undefined,
            clearPropInfo,
            lowerThirdPayload,
          );
          if (!transitionRes.ok) {
            summary.writeErrors++;
            broadcastLog(`[WARN] Transition rewrite failed • ${title}: ${transitionRes.err.trim() || transitionRes.out.trim() || 'unknown error'}`);
            continue;
          }
          const trimmedOut = transitionRes.out.trim();
          if (trimmedOut) {
            for (const line of trimmedOut.split(/\r?\n/)) {
              broadcastLog(`[DEBUG] PY:${line}`);
            }
          }
          const trimmedErr = transitionRes.err.trim();
          if (trimmedErr) {
            for (const line of trimmedErr.split(/\r?\n/)) {
              broadcastLog(`[DEBUG] PYERR:${line}`);
            }
          }
          broadcastLog(`[INFO] Transition rewrite exit code ${transitionRes.code} • ${title}`);
          broadcastLog(`[INFO] Transition rewrite done • ${title}`);
        }
        if (categoryLabel) categoriesByUuid[uuidRaw] = categoryLabel;
        const res = await writeOperatorNotesFile(hit.path, desc);
        if (res.ok) {
          summary.updated++;
        } else {
          summary.writeErrors++;
          summary.skipped++;
          broadcastLog(`[WARN] Failed to write notes for "${title}": ${res.err.trim() || res.out.trim() || 'unknown error'}`);
        }
      }
    } finally {
      if (shouldReopen) {
        broadcastLog('[INFO] Reopening ProPresenter…');
        reopenOutcome = await launchProPresenter(host, port);
        if (!reopenOutcome.ok) {
          broadcastLog(`[WARN] ProPresenter did not relaunch cleanly: ${reopenOutcome.message ?? 'unknown error'}`);
        }
      }
    }

    broadcastLog(`[INFO] Presentation sync complete: updated ${summary.updated}, missing path ${summary.missingPath}, no description ${summary.noDesc}, write errors ${summary.writeErrors}.`);
    const detailPayload: Record<string, unknown> = {};
    if (missingInfo.length) detailPayload.missing = missingInfo;
    if (reopenOutcome && !reopenOutcome.ok) detailPayload.reopen = reopenOutcome.message;
    const details = Object.keys(detailPayload).length ? JSON.stringify(detailPayload) : undefined;
    return { ok: true, planTitle: plan.title, summary, details, categories: categoriesByUuid };
  } catch (e: any) {
    broadcastLog(`[ERROR] Presentation sync crashed: ${e?.message || e}`);
    return { ok: false, error: e?.message || 'Unexpected error' };
  }
}

ipcMain.handle('pp-run-presentation-sync', async (_e, payload: PresentationSyncPayload) => runPresentationSync(payload));
ipcMain.handle('pp-run-notes-sync', async (_e, payload: PresentationSyncPayload) => runPresentationSync(payload));
