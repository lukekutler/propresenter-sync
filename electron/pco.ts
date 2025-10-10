import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const keytar: typeof import('keytar') = require('keytar');

export type PCOCredentials = { appId: string; secret: string };
export type PCOTestResult = { ok: boolean; statusCode?: number; error?: string; bodyText?: string };
export type PCOSongArrangementSection = {
  id: string;
  name: string;
  sequenceLabel?: string;
  lyrics?: string;
  lyricLines?: string[];
  lyricSlides?: string[][];
};

export type PCOSongArrangementSequenceEntry = {
  id: string;
  position?: number;
  label?: string;
  number?: string;
  sectionId?: string;
};

export type PCOPlanItemSongDetails = {
  songId: string;
  arrangementId?: string;
  arrangementName?: string;
  sequenceSummary?: string;
  sections?: PCOSongArrangementSection[];
  sequence?: PCOSongArrangementSequenceEntry[];
};

export type PCOPlanItem = {
  id: string;
  kind: 'song' | 'video' | 'announcement';
  title: string;
  order: number;
  description?: string;
  notes?: string;
  category?: 'Song' | 'Message' | 'Transitions' | 'Videos' | 'Pre Service' | 'Post Service';
  isHeader?: boolean;
  lengthSeconds?: number;
  songDetails?: PCOPlanItemSongDetails;
};
export type PCOPlan = { id: string; date: string; title: string; items: PCOPlanItem[] };

const SERVICE = 'prosync-pco';
const ACCOUNT = 'default';
const MAX_LYRIC_LINE_LENGTH = 48;
const PUNCT_REMOVE_REGEX = /[\p{P}\p{S}]/gu;

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

function normalizeLyricBlock(input: string): string {
  const normalized = input
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ');
  const rawLines = normalized.split('\n');
  if (!rawLines.length) return '';

  const trimmed = rawLines.map((line) => line.replace(/\s+$/g, '').replace(/^\s+/g, ''));

  let start = 0;
  while (start < trimmed.length && !trimmed[start].trim()) start += 1;
  let end = trimmed.length - 1;
  while (end >= start && !trimmed[end].trim()) end -= 1;
  if (start > end) return '';

  const slice = trimmed.slice(start, end + 1);
  const expanded: string[] = [];
  for (const line of slice) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    const sanitized = sanitizeLyric(line);
    if (!sanitized) {
      continue;
    }
    const segments = splitLyricLine(sanitized);
    for (const segment of segments) {
      expanded.push(segment);
    }
  }
  return expanded.join('\n');
}

const ROMAN_NUMERAL_VALUES: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
  xiii: 13,
  xiv: 14,
  xv: 15,
  xvi: 16,
  xvii: 17,
  xviii: 18,
  xix: 19,
  xx: 20,
};

function normalizeSequenceNumber(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+$/.test(trimmed)) return trimmed;
    const roman = trimmed.toLowerCase();
    if (roman in ROMAN_NUMERAL_VALUES) return String(ROMAN_NUMERAL_VALUES[roman]);
    if (/^\d+[a-z]$/i.test(trimmed)) return trimmed.toLowerCase();
    return trimmed;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return undefined;
}

function splitLyricLine(line: string, maxLength = MAX_LYRIC_LINE_LENGTH): string[] {
  const segments: string[] = [];
  let remaining = line.trim();
  while (remaining.length > maxLength) {
    let breakIdx = remaining.lastIndexOf(' ', maxLength);
    if (breakIdx <= 0) {
      breakIdx = remaining.indexOf(' ', maxLength);
    }
    if (breakIdx <= 0) {
      break;
    }
    const head = remaining.slice(0, breakIdx).trim();
    if (head) segments.push(head);
    remaining = remaining.slice(breakIdx).trim();
  }
  if (remaining.length) segments.push(remaining);
  return segments.length ? segments : [line.trim()];
}

function sanitizeLyric(value: string): string {
  return value
    .replace(PUNCT_REMOVE_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildLyricSlides(lines: string[]): { lines: string[]; slides: string[][] } {
  const expanded: string[] = [];
  const slides: string[][] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length) {
      slides.push(current);
      current = [];
    }
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed.length) {
      flush();
      continue;
    }
    const parts = splitLyricLine(trimmed);
    for (const part of parts) {
      const segment = part.trim();
      if (!segment.length) continue;
      expanded.push(segment);
      if (current.length === 2) flush();
      current.push(segment);
      if (current.length === 2) flush();
    }
  }

  flush();
  return { lines: expanded, slides };
}

function enrichSectionLyrics(section: PCOSongArrangementSection): void {
  if (!section.lyrics) {
    section.lyricLines = undefined;
    section.lyricSlides = undefined;
    return;
  }
  const baseLines = section.lyrics
    .split('\n')
    .map((line) => line.replace(/\s+$/g, '').replace(/^\s+/g, ''));
  const { lines, slides } = buildLyricSlides(baseLines);
  section.lyricLines = lines.length ? lines : undefined;
  section.lyricSlides = slides.length ? slides : undefined;
}

function extractRelationshipId(node: any, key: string): string | undefined {
  const rel = node?.relationships?.[key]?.data;
  if (!rel) return undefined;
  if (Array.isArray(rel)) {
    const first = rel[0];
    if (first && first.id !== undefined && first.id !== null) {
      const id = String(first.id).trim();
      if (id) return id;
    }
    return undefined;
  }
  if (rel.id !== undefined && rel.id !== null) {
    const id = String(rel.id).trim();
    if (id) return id;
  }
  return undefined;
}

function coerceSequenceArray(payload: unknown): PCOSongArrangementSequenceEntry[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const entries: PCOSongArrangementSequenceEntry[] = [];
  payload.forEach((value, idx) => {
    if (typeof value === 'string' && value.trim()) {
      entries.push({ id: `seq-${idx}`, position: idx + 1, label: value.trim() });
      return;
    }
    if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>;
      const rawId = node.id ?? `seq-${idx}`;
      const id = String(rawId ?? `seq-${idx}`).trim() || `seq-${idx}`;
      const labelRaw = typeof node.label === 'string' ? node.label : (typeof node.name === 'string' ? node.name : undefined);
      const sectionRefRaw = node.section_id ?? node.sectionId ?? (node.section && typeof (node.section as any).id !== 'undefined' ? (node.section as any).id : undefined);
      const sectionRef = sectionRefRaw !== undefined && sectionRefRaw !== null ? String(sectionRefRaw).trim() : undefined;
      const positionRaw = node.position ?? node.index ?? node.sequence_position;
      const position = typeof positionRaw === 'number' ? positionRaw : Number.parseInt(String(positionRaw ?? ''), 10);
      const numberRaw = (node as any).number ?? (node as any).sequence_number ?? (node as any).sequenceNumber;
      const metaNode = (node as any).meta && typeof (node as any).meta === 'object' ? (node as any).meta as Record<string, unknown> : undefined;
      const metaNumber = metaNode ? (metaNode.number ?? (metaNode as any).sequence_number ?? (metaNode as any).sequenceNumber) : undefined;
      const entry: PCOSongArrangementSequenceEntry = { id };
      if (Number.isFinite(position)) entry.position = Number(position);
      if (labelRaw && labelRaw.trim()) entry.label = labelRaw.trim();
      if (sectionRef) entry.sectionId = sectionRef;
      const normalizedNumber = normalizeSequenceNumber(numberRaw ?? metaNumber);
      if (normalizedNumber) entry.number = normalizedNumber;
      entries.push(entry);
      return;
    }
  });
  return entries.length ? entries : undefined;
}

function coerceSectionArray(payload: unknown): PCOSongArrangementSection[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const sections: PCOSongArrangementSection[] = [];
  payload.forEach((value, idx) => {
    if (!value) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return;
      const section: PCOSongArrangementSection = { id: `sec-${idx}`, name: text, lyrics: normalizeLyricBlock(text) };
      enrichSectionLyrics(section);
      sections.push(section);
      return;
    }
    if (typeof value === 'object') {
      const node = value as Record<string, unknown>;
      const attrs = (node.attributes && typeof node.attributes === 'object') ? node.attributes as Record<string, unknown> : node;
      const rawId = node.id ?? attrs.id ?? `sec-${idx}`;
      const id = String(rawId ?? `sec-${idx}`).trim() || `sec-${idx}`;
      const nameSource = attrs.name ?? attrs.title ?? attrs.label ?? attrs.sequence_label ?? attrs.sequenceLabel;
      const seqLabelSource = attrs.sequence_label ?? attrs.sequenceLabel ?? attrs.label ?? attrs.short_label;
      const lyricsSourceRaw = attrs.lyrics ?? attrs.content ?? attrs.text ?? attrs.body;
      const name = typeof nameSource === 'string' && nameSource.trim() ? nameSource.trim() : `Section ${idx + 1}`;
      const section: PCOSongArrangementSection = { id, name };
      if (typeof seqLabelSource === 'string' && seqLabelSource.trim()) section.sequenceLabel = seqLabelSource.trim();
      if (Array.isArray(lyricsSourceRaw)) {
        const joined = lyricsSourceRaw.map((line) => typeof line === 'string' ? line : '').filter(Boolean).join('\n');
        if (joined.trim()) section.lyrics = normalizeLyricBlock(joined);
      } else if (lyricsSourceRaw && typeof lyricsSourceRaw === 'object') {
        const maybe = (lyricsSourceRaw as any).text ?? (lyricsSourceRaw as any).body ?? (lyricsSourceRaw as any).content;
        if (typeof maybe === 'string' && maybe.trim()) section.lyrics = normalizeLyricBlock(maybe);
      } else if (typeof lyricsSourceRaw === 'string' && lyricsSourceRaw.trim()) {
        section.lyrics = normalizeLyricBlock(lyricsSourceRaw);
      }
      enrichSectionLyrics(section);
      sections.push(section);
    }
  });
  return sections.length ? sections : undefined;
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

async function fetchSongArrangementDetails(params: {
  headers: Record<string, string>;
  songId: string;
  arrangementId: string;
  arrangementName?: string;
}): Promise<PCOPlanItemSongDetails> {
  const { headers, songId, arrangementId, arrangementName } = params;
  const basePath = `/services/v2/songs/${encodeURIComponent(songId)}/arrangements/${encodeURIComponent(arrangementId)}`;
  const details: PCOPlanItemSongDetails = { songId, arrangementId, arrangementName };

  const arrangementResp = await httpsGetJson(`${basePath}`, headers);
  if (arrangementResp.status >= 200 && arrangementResp.status < 300 && arrangementResp.json?.data) {
    const attrs = arrangementResp.json.data.attributes || {};
    if (typeof attrs.name === 'string' && attrs.name.trim()) details.arrangementName = attrs.name.trim();
    if (typeof attrs.sequence_short === 'string' && attrs.sequence_short.trim()) {
      details.sequenceSummary = attrs.sequence_short.trim();
    } else if (typeof attrs.sequence === 'string' && attrs.sequence.trim()) {
      details.sequenceSummary = attrs.sequence.trim();
    }

    if (!details.sequence) {
      const seqArray = coerceSequenceArray(attrs.sequence_full ?? attrs.sequence ?? attrs.sequence_short);
      if (seqArray) details.sequence = seqArray;
    }

    if (!details.sections) {
      const sectionArray = coerceSectionArray(attrs.sections ?? attrs.lyrics);
      if (sectionArray) details.sections = sectionArray;
    }

    const relSeq = arrangementResp.json.data.relationships?.sequence?.data;
    if (Array.isArray(relSeq)) {
      const seqEntries: PCOPlanItemSongDetails['sequence'] = [];
      for (const entry of relSeq) {
        if (!entry || typeof entry.id !== 'string') continue;
        const node: any = entry;
        const seqItem: PCOSongArrangementSequenceEntry = { id: entry.id };
        if (node.meta && typeof node.meta === 'object') {
          const posRaw = (node.meta as any).position ?? (node.meta as any).index;
          const labelRaw = (node.meta as any).label ?? (node.meta as any).name;
          const numberRaw = (node.meta as any).number ?? (node.meta as any).sequence_number ?? (node.meta as any).sequenceNumber;
          const posNum = typeof posRaw === 'number' ? posRaw : Number.parseInt(String(posRaw ?? ''), 10);
          if (Number.isFinite(posNum)) seqItem.position = Number(posNum);
          if (typeof labelRaw === 'string' && labelRaw.trim()) seqItem.label = labelRaw.trim();
          const normalizedNumber = normalizeSequenceNumber(numberRaw);
          if (normalizedNumber) seqItem.number = normalizedNumber;
        }
        seqEntries.push(seqItem);
      }
      if (seqEntries.length) details.sequence = seqEntries;
    }
  }

  const sectionsResp = await httpsGetJson(`${basePath}/sections`, headers);
  if (sectionsResp.status >= 200 && sectionsResp.status < 300) {
    let sections: PCOSongArrangementSection[] | undefined;
    const dataNode = sectionsResp.json?.data;
    if (Array.isArray(dataNode)) {
      sections = coerceSectionArray(dataNode);
    } else if (dataNode && typeof dataNode === 'object') {
      const attrs = (dataNode as any).attributes;
      if (attrs && typeof attrs === 'object') {
        sections = coerceSectionArray((attrs as any).sections ?? (attrs as any).items ?? (attrs as any).data);
      }
    }
    if (!sections && Array.isArray(sectionsResp.json?.included)) {
      sections = coerceSectionArray(sectionsResp.json?.included);
    }
    if (sections?.length) details.sections = sections;
  }

  if (!details.sequence || !details.sequence.length) {
    const sequenceResp = await httpsGetJson(`${basePath}/sequence`, headers);
    if (sequenceResp.status >= 200 && sequenceResp.status < 300 && Array.isArray(sequenceResp.json?.data)) {
      const seqEntries: PCOSongArrangementSequenceEntry[] = [];
      for (const node of sequenceResp.json.data) {
        if (!node || typeof node.id !== 'string') continue;
        const attrs = node.attributes || {};
        const entry: PCOSongArrangementSequenceEntry = { id: node.id };
        const posRaw = attrs.position ?? attrs.index ?? attrs.sequence_position;
        const posNum = typeof posRaw === 'number' ? posRaw : Number.parseInt(String(posRaw ?? ''), 10);
        if (Number.isFinite(posNum)) entry.position = Number(posNum);
        const labelRaw = attrs.label ?? attrs.sequence_label ?? attrs.name;
        if (typeof labelRaw === 'string' && labelRaw.trim()) entry.label = labelRaw.trim();
        const numberRaw = attrs.number ?? attrs.sequence_number ?? (attrs as any).sequenceNumber ?? (attrs as any).label_number;
        const normalizedNumber = normalizeSequenceNumber(numberRaw);
        if (normalizedNumber) entry.number = normalizedNumber;
        const sectionId = extractRelationshipId(node, 'section');
        if (sectionId) entry.sectionId = sectionId;
        seqEntries.push(entry);
      }
      if (seqEntries.length) details.sequence = seqEntries;
    }
  }

  if (!details.sequence || !details.sequence.length) {
    const fallback = coerceSequenceArray(arrangementResp.json?.included);
    if (fallback) details.sequence = fallback;
  }

  if (!details.sections || !details.sections.length) {
    const includeResp = await httpsGetJson(`${basePath}?include=sections.section_items,sections.items`, headers);
    if (includeResp.status >= 200 && includeResp.status < 300) {
      let sections: PCOSongArrangementSection[] | undefined;
      const includeData = includeResp.json?.included ?? includeResp.json?.data;
      sections = coerceSectionArray(includeData);
      if (!sections && includeResp.json?.data && typeof includeResp.json.data === 'object') {
        const attrs = (includeResp.json.data as any).attributes;
        if (attrs && typeof attrs === 'object') {
          sections = coerceSectionArray((attrs as any).sections ?? (attrs as any).items);
        }
      }
      if (sections?.length) details.sections = sections;
    }
  }

  return details;
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

      const noteFields = extractNotes(a as Record<string, unknown>);
      const category = classifyPlanItem({ kind, title: a.title || a.description || 'Untitled', isHeader });
      const songId = extractRelationshipId(it, 'song');
      const arrangementId = extractRelationshipId(it, 'arrangement')
        ?? extractRelationshipId(it, 'selected_arrangement')
        ?? extractRelationshipId(it, 'arrangements');
      const arrangementNameRaw = a.selected_arrangement_name
        ?? a.arrangement_name
        ?? a.arrangement
        ?? a.arrangement_label;

      const item: PCOPlanItem = {
        id: String(it.id),
        kind,
        title: a.title || a.description || 'Untitled',
        order,
        description: noteFields.description,
        notes: noteFields.notes,
        category,
        isHeader,
      };

      if (Number.isFinite(len)) item.lengthSeconds = Number(len);

      if (songId) {
        const details: PCOPlanItemSongDetails = { songId };
        if (arrangementId) details.arrangementId = arrangementId;
        if (typeof arrangementNameRaw === 'string' && arrangementNameRaw.trim()) {
          details.arrangementName = arrangementNameRaw.trim();
        }
        item.songDetails = details;
      }

      items.push(item);
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
        const songId = extractRelationshipId(node, 'song');
        const arrangementId = extractRelationshipId(node, 'arrangement')
          ?? extractRelationshipId(node, 'selected_arrangement')
          ?? extractRelationshipId(node, 'arrangements');
        const arrangementNameRaw = a.selected_arrangement_name
          ?? a.arrangement_name
          ?? a.arrangement
          ?? a.arrangement_label;

        const item: PCOPlanItem = {
          id: String(node.id),
          kind,
          title: a.title || a.description || 'Untitled',
          order,
          description: noteFields.description,
          notes: noteFields.notes,
          category,
        };

        if (isHeader) item.isHeader = true;
        if (Number.isFinite(len)) item.lengthSeconds = Number(len);

        if (songId) {
          const details: PCOPlanItemSongDetails = { songId };
          if (arrangementId) details.arrangementId = arrangementId;
          if (typeof arrangementNameRaw === 'string' && arrangementNameRaw.trim()) {
            details.arrangementName = arrangementNameRaw.trim();
          }
          item.songDetails = details;
        }

        rebuilt.push(item);
      }

      items = rebuilt;
    }
  }
  // --- END: Strict "SERVICE" header slicing ---

  const arrangementCache = new Map<string, PCOPlanItemSongDetails>();
  const arrangementRequests: Array<{ key: string; songId: string; arrangementId: string; arrangementName?: string }> = [];

  for (const item of items) {
    const details = item.songDetails;
    if (!details?.songId || !details.arrangementId) continue;
    const key = `${details.songId}:${details.arrangementId}`;
    if (arrangementCache.has(key)) continue;
    arrangementCache.set(key, details);
    arrangementRequests.push({ key, songId: details.songId, arrangementId: details.arrangementId, arrangementName: details.arrangementName });
  }

  for (const req of arrangementRequests) {
    try {
      const fetched = await fetchSongArrangementDetails({
        headers: headers as any,
        songId: req.songId,
        arrangementId: req.arrangementId,
        arrangementName: req.arrangementName,
      });
      arrangementCache.set(req.key, fetched);
    } catch (err) {
      console.warn('[PCO] Failed to fetch arrangement details', req, err);
    }
  }

  for (const item of items) {
    const details = item.songDetails;
    if (!details?.songId || !details.arrangementId) continue;
    const key = `${details.songId}:${details.arrangementId}`;
    const fetched = arrangementCache.get(key);
    if (!fetched) continue;
    item.songDetails = {
      ...details,
      arrangementName: fetched.arrangementName ?? details.arrangementName,
      sequenceSummary: fetched.sequenceSummary ?? details.sequenceSummary,
      sections: fetched.sections ?? details.sections,
      sequence: fetched.sequence ?? details.sequence,
    };
  }

  const mapped: PCOPlan = { id: String(planId), date, title, items } as any;
  return { ok: true, plan: mapped };
}
