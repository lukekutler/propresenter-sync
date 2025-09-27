import https from 'node:https';
import keytar from 'keytar';
import fs from 'node:fs';
import path from 'node:path';

export type PCOCredentials = { appId: string; secret: string };
export type PCOTestResult = { ok: boolean; statusCode?: number; error?: string; bodyText?: string };
export type PCOPlanItem = {
  id: string;
  kind: 'song' | 'video' | 'announcement';
  title: string;
  order: number;
  description?: string;
  notes?: string;
  category?: 'Song' | 'Message' | 'Transitions' | 'Videos' | 'Pre Service' | 'Post Service';
  isHeader?: boolean;
};
export type PCOPlan = { id: string; date: string; title: string; items: PCOPlanItem[] };

const SERVICE = 'prosync-pco';
const ACCOUNT = 'default';

export async function saveCredentials(creds: PCOCredentials) {
  const payload = JSON.stringify(creds);
  await keytar.setPassword(SERVICE, ACCOUNT, payload);
}

export async function loadCredentials(): Promise<PCOCredentials | null> {
  const payload = await keytar.getPassword(SERVICE, ACCOUNT);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed.appId === 'string' && typeof parsed.secret === 'string') {
      return parsed as PCOCredentials;
    }
  } catch { }
  return null;
}

export async function testCredentials(creds: PCOCredentials): Promise<PCOTestResult> {
  const auth = Buffer.from(`${creds.appId}:${creds.secret}`).toString('base64');
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'User-Agent': 'prosync/0.1 (+https://example.local)'
  } as const;

  const tryPath = (path: string) => new Promise<PCOTestResult>((resolve) => {
    const req = https.request({ method: 'GET', host: 'api.planningcenteronline.com', path, headers, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => {
        if (chunks.reduce((n, b) => n + b.length, 0) < 4096) chunks.push(c as Buffer);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        resolve({ ok, statusCode: res.statusCode, bodyText: body });
      });
    });
    req.on('error', (e: any) => resolve({ ok: false, error: e?.message || 'error' }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });

  // Try commonly-available Services endpoints. Root should be 200 if auth is valid.
  const paths = [
    '/services/v2',
    '/services/v2/service_types?per_page=1',
  ];
  for (const p of paths) {
    const res = await tryPath(p);
    if (res.ok) return res;
    // If 401/403, bail early to show auth issue rather than trying alternates
    if (res.statusCode && (res.statusCode === 401 || res.statusCode === 403)) return res;
  }
  // Return last result if none ok
  return await tryPath(paths[paths.length - 1]);
}

// Hardcoded credentials for local development. Replace the values below.
// Prefer environment variables for safety in real projects.
function loadDotEnvOnce() {
  if ((process as any).__DOTENV_LOADED) return;
  const roots = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'src', '.env'),
    path.resolve(process.cwd(), 'src', 'lib', '.env'),
  ];
  for (const envPath of roots) {
    try {
      if (fs.existsSync(envPath)) {
        const text = fs.readFileSync(envPath, 'utf8');
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, '');
            if (!process.env[key]) process.env[key] = val;
          } else if (/^\d+$/.test(trimmed) && !process.env.PCO_SERVICE_TYPE_ID) {
            // Support a .env file containing only the numeric Service Type ID for convenience
            process.env.PCO_SERVICE_TYPE_ID = trimmed;
          }
        }
        break;
      }
    } catch { }
  }
  (process as any).__DOTENV_LOADED = true;
}

function getEnvCreds(): PCOCredentials {
  loadDotEnvOnce();
  return {
    appId: process.env.PCO_APP_ID || '',
    secret: process.env.PCO_SECRET || '',
  };
}

function stripHtml(text: string): string {
  return text
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeWhitespace(input: string): string {
  const normalized = input
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim());

  // Remove leading/trailing empty lines and collapse consecutive empties to a single blank line
  const filtered: string[] = [];
  for (const line of normalized) {
    if (!line && (!filtered.length || filtered[filtered.length - 1] === '')) continue;
    filtered.push(line);
  }
  while (filtered.length && filtered[filtered.length - 1] === '') filtered.pop();
  return filtered.join('\n').trim();
}

function extractNotes(attrs: Record<string, unknown>): { description?: string; notes?: string } {
  const rawDesc = typeof attrs.description === 'string'
    ? attrs.description
    : typeof attrs.description_html === 'string'
      ? stripHtml(attrs.description_html)
      : undefined;
  const rawNotes = typeof attrs.notes === 'string' ? attrs.notes : undefined;

  const desc = rawDesc ? normalizeWhitespace(rawDesc) : undefined;
  const notes = rawNotes ? normalizeWhitespace(rawNotes) : undefined;

  return {
    description: desc && desc.length ? desc : undefined,
    notes: notes && notes.length ? notes : undefined,
  };
}

export function classifyPlanItem(params: { kind: 'song' | 'video' | 'announcement'; title: string; isHeader?: boolean }): PCOPlanItem['category'] {
  const { kind, title, isHeader } = params;
  const normalized = title.trim().toLowerCase();
  const containsAny = (patterns: RegExp[]) => patterns.some(rx => rx.test(normalized));
  const containsAll = (...words: string[]) => words.every(w => normalized.includes(w));

  let category: PCOPlanItem['category'];

  if (isHeader && /pre[-\s]?service/.test(normalized)) {
    category = 'Pre Service';
  } else if (isHeader && /post[-\s]?service/.test(normalized)) {
    category = 'Post Service';
  } else if (containsAny([/pre[-\s]?service/, /prelude/, /countdown/, /walk[-\s]?in/, /lobby/, /pre[-\s]?show/, /pre\s*service\s*loop/])) {
    category = 'Pre Service';
  } else if (containsAny([/post[-\s]?service/, /walk[-\s]?out/, /dismissal/, /outro/, /exit\b/, /after\s*service/])
    || (containsAll('bumper', 'ending'))
    || (containsAll('bumper', 'exit'))
    || (containsAll('ending', 'exit'))
    || (containsAll('closing', 'exit'))
  ) {
    category = 'Post Service';
  } else if (kind === 'song' || containsAny([/song/, /worship/, /praise/, /anthem/, /hymn/])) {
    category = 'Song';
  } else if (kind === 'video' || containsAny([/video/, /bumper/, /clip/, /lyric\s*video/, /church\s*news/])) {
    category = 'Videos';
  } else if (containsAny([/message/, /sermon/, /homily/, /teaching/, /talk/, /devotional/, /communion message/, /communion meditation/, /testimony/])) {
    category = 'Message';
  } else if (containsAny([/transition/, /prayer/, /welcome/, /host/, /announcement/, /announcements/, /giving/, /offering/, /tithes/, /response/, /benediction/, /dismissal/])) {
    category = 'Transitions';
  } else {
    category = kind === 'announcement' ? 'Transitions' : 'Message';
  }

  console.log('[PCO classify]', { title, kind, isHeader, category });
  return category;
}

export async function testHardcoded(): Promise<PCOTestResult> {
  const creds = getEnvCreds();
  if (!creds.appId || !creds.secret) {
    return { ok: false, error: 'Missing PCO_APP_ID or PCO_SECRET in .env' };
  }
  return await testCredentials(creds);
}

function authHeader(creds: PCOCredentials) {
  const auth = Buffer.from(`${creds.appId}:${creds.secret}`).toString('base64');
  return {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'User-Agent': 'prosync/0.1 (+https://example.local)'
  } as const;
}

function httpsGetJson(pathname: string, headers: Record<string, string>): Promise<{ status: number; json?: any; text?: string; }> {
  return new Promise((resolve) => {
    const req = https.request({ method: 'GET', host: 'api.planningcenteronline.com', path: pathname, headers, timeout: 8000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => { if (chunks.reduce((n, b) => n + b.length, 0) < 1048576) chunks.push(c as Buffer); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any | undefined;
        try { json = JSON.parse(text); } catch { }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}

export async function getNextPlan(): Promise<{ ok: boolean; plan?: PCOPlan; error?: string; statusCode?: number }> {
  const creds = getEnvCreds();
  if (!creds.appId || !creds.secret) return { ok: false, error: 'Missing PCO_APP_ID or PCO_SECRET in .env' };
  loadDotEnvOnce();
  const stid = process.env.PCO_SERVICE_TYPE_ID;
  if (!stid) return { ok: false, error: 'Missing PCO_SERVICE_TYPE_ID in .env' };
  const headers = authHeader(creds);

  const candidates = [
    `/services/v2/service_types/${stid}/plans?filter=future&order=sort_date&per_page=1`,
    `/services/v2/service_types/${stid}/plans?order=sort_date&per_page=1`,
  ];

  let plansResp: { status: number; json?: any; text?: string; } | undefined;
  for (const p of candidates) {
    const r = await httpsGetJson(p, headers as any);
    plansResp = r;
    if (r.status >= 200 && r.status < 300 && r.json && Array.isArray(r.json.data) && r.json.data.length > 0) {
      break;
    }
    if (r.status === 401 || r.status === 403) return { ok: false, statusCode: r.status, error: 'Unauthorized' };
  }
  if (!plansResp || !(plansResp.status >= 200 && plansResp.status < 300) || !plansResp.json || !Array.isArray(plansResp.json.data) || plansResp.json.data.length === 0) {
    return { ok: false, statusCode: plansResp?.status, error: 'No plans found' };
  }

  const plan = plansResp.json.data[0];
  const planId = plan.id;
  const attrs = plan.attributes || {};
  const title: string = attrs.title || attrs.short_title || 'Untitled Plan';
  const dateRaw: string = attrs.sort_date || attrs.dates || new Date().toISOString();
  const date = new Date(dateRaw).toISOString().slice(0, 10);

  const itemsPath = `/services/v2/service_types/${stid}/plans/${planId}/items?per_page=100`;
  const itemsResp = await httpsGetJson(itemsPath, headers as any);
  let items: PCOPlanItem[] = [];
  if (itemsResp.status >= 200 && itemsResp.status < 300 && itemsResp.json && Array.isArray(itemsResp.json.data)) {
    for (const it of itemsResp.json.data) {
      const a = it.attributes || {};
      const itemType: string = (a.item_type || a.category || '').toString().toLowerCase();
      const isHeader = itemType === 'header';
      const kind: 'song' | 'video' | 'announcement' = isHeader
        ? 'announcement'
        : itemType.includes('song')
          ? 'song'
          : (itemType.includes('media') || itemType.includes('video'))
            ? 'video'
            : 'announcement';
      const order = typeof a.sequence === 'number' ? a.sequence : (typeof a.position === 'number' ? a.position : (items.length + 1));
      const len = typeof a.length === 'number' ? a.length
        : (typeof a.length_seconds === 'number' ? a.length_seconds
          : (typeof a.length_in_seconds === 'number' ? a.length_in_seconds : undefined));
      // Temporarily piggyback extra fields on title to keep PlanItem minimal; UI doesn't read them directly
      (it as any).__isHeader = isHeader;
      (it as any).__lengthSeconds = len;
      const noteFields = extractNotes(a as Record<string, unknown>);
      const category = classifyPlanItem({ kind, title: a.title || a.description || 'Untitled', isHeader });
      items.push({
        id: String(it.id),
        kind,
        title: a.title || a.description || 'Untitled',
        order,
        description: noteFields.description,
        notes: noteFields.notes,
        category,
        isHeader,
      } as any);
    }
  }

  // --- START: Strict "SERVICE" header slicing ---
  // Start exactly at the "SERVICE" header (case-insensitive). Exclude all items before it.
  if (Array.isArray(itemsResp.json?.data)) {
    const data = itemsResp.json.data as any[];

    const norm = (s: unknown) =>
      String(s ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

    // Match a header whose title begins with "service" but NOT "pre-service" or "post-service"
    const isServiceHeader = (node: any) => {
      const a = node?.attributes || {};
      const isHeader = String(a.item_type || a.category || '').toLowerCase() === 'header';
      const t = norm(a.title || a.description || '');
      if (!isHeader) return false;
      if (t.startsWith('pre-service') || t.startsWith('post-service')) return false;
      return /^service\b/.test(t); // titles like "Service", "Service (Main)", etc.
    };

    const startIdx = data.findIndex(isServiceHeader);

    // If we found the SERVICE header, slice from there (including the header itself).
    // Otherwise, leave the original items array as-is (no fallback heuristics).
    if (startIdx >= 0) {
      const sliced = data.slice(startIdx);

      const rebuilt: PCOPlanItem[] = [];
      for (const node of sliced) {
        const a = node?.attributes || {};
        const itemType: string = String(a.item_type || a.category || '').toLowerCase();
        const isHeader = itemType === 'header';

        const kind: 'song' | 'video' | 'announcement' =
          isHeader
            ? 'announcement'
            : (String(itemType).includes('song')
              ? 'song'
              : (String(itemType).includes('media') || String(itemType).includes('video'))
                ? 'video'
                : 'announcement');

        const order =
          typeof a.sequence === 'number'
            ? a.sequence
            : typeof a.position === 'number'
              ? a.position
              : (rebuilt.length + 1);

        const len =
          typeof a.length === 'number'
            ? a.length
            : typeof a.length_seconds === 'number'
              ? a.length_seconds
              : typeof a.length_in_seconds === 'number'
                ? a.length_in_seconds
                : undefined;

        const noteFields = extractNotes(a as Record<string, unknown>);
        const category = classifyPlanItem({ kind, title: a.title || a.description || 'Untitled', isHeader });
        const item: any = {
          id: String(node.id),
          kind,
          title: a.title || a.description || 'Untitled',
          order,
          description: noteFields.description,
          notes: noteFields.notes,
          category,
        };

        if (isHeader) item.isHeader = true;
        if (typeof len === 'number') item.lengthSeconds = len;

        rebuilt.push(item);
      }

      items = rebuilt;
    }
  }
  // --- END: Strict "SERVICE" header slicing ---

  const mapped: PCOPlan = { id: String(planId), date, title, items } as any;
  return { ok: true, plan: mapped };
}
