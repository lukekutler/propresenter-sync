import http from 'node:http';

export type PPConfig = {
  host: string;
  port: number;
  password?: string;
  path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  body?: unknown;
  headers?: Record<string, string>;
};
export type PPTestResult = {
  reachable: boolean;
  authenticated: boolean;
  latencyMs?: number;
  error?: string;
  info?: Record<string, unknown>;
  pathTried?: string;
  statusCode?: number;
};

export async function testConnection(cfg: PPConfig): Promise<PPTestResult> {
  const { host, port } = cfg;
  const started = Date.now();
  if (!host || !port) return { reachable: false, authenticated: false, error: 'Missing host/port' };

  // Candidate API endpoints to probe; adjust as needed for your ProPresenter build
  const paths = cfg.path && cfg.path.trim().length > 0
    ? [cfg.path]
    : ['/v1/version', '/api/version', '/version', '/v1', '/api', '/'];

  const tryPath = (idx: number): Promise<PPTestResult> => new Promise((resolve) => {
    if (idx >= paths.length) {
      resolve({ reachable: false, authenticated: false, latencyMs: Date.now() - started, error: 'no_http_response' });
      return;
    }

    const path = paths[idx];
    const method = cfg.method ?? 'GET';

    const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
    let requestBody: string | undefined;
    if (cfg.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      if (typeof cfg.body === 'string') {
        requestBody = cfg.body;
      } else {
        requestBody = JSON.stringify(cfg.body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = Buffer.byteLength(requestBody).toString();
    }

    const req = http.request({ host, port, path, method, timeout: 3000, headers }, (res) => {
      const t = Date.now() - started;
      const chunks: Buffer[] = [];
      res.on('data', (c) => {
        if (chunks.reduce((n, b) => n + b.length, 0) < 2048) chunks.push(c as Buffer);
      });
      res.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        const bodyStr = bodyBuf.toString('utf8');
        let info: any = undefined;
        try {
          const json = JSON.parse(bodyStr);
          info = json;
        } catch {
          // not JSON; include plain text in info for visibility
          if (bodyStr && bodyStr.trim().length > 0) info = { text: bodyStr.slice(0, 1024) };
        }
        const statusCode = res.statusCode ?? 0;
        // Only mark connected when a probe path returns 2xx; otherwise try next path.
        if (statusCode >= 200 && statusCode < 300) {
          resolve({ reachable: true, authenticated: true, latencyMs: t, info, pathTried: path, statusCode });
        } else {
          // Try next candidate path
          tryPath(idx + 1).then((next) => {
            // If none of the later paths succeed, keep the first non-2xx as the result so UI shows useful status
            if (!next.reachable) {
              resolve({ reachable: true, authenticated: false, latencyMs: t, info, pathTried: path, statusCode });
            } else {
              resolve(next);
            }
          });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', () => {
      // try next path
      tryPath(idx + 1).then(resolve);
    });
    if (requestBody) {
      req.end(requestBody);
    } else {
      req.end();
    }
  });

  return await tryPath(0);
}

export function fetchJson(host: string, port: number, path: string, timeout = 5000): Promise<{ status: number; json?: any; text?: string }> {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, method: 'GET', timeout, headers: { 'Accept': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => { if (chunks.reduce((n, b) => n + b.length, 0) < 1_048_576) chunks.push(c as Buffer); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any | undefined;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}

function mapAlias(s: string): string {
  const low = s.toLowerCase();
  if (/\bclosing\s+worship(\s+song)?\b/.test(low)) return 'closing worship';
  return s;
}

export function normalizeTitle(s: string): string {
  // Strip parenthetical/bracketed content, map aliases, then normalize
  let t = s
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ');
  t = mapAlias(t);
  return t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}

function collectPresentationNames(obj: any, out: Set<string>) {
  if (!obj) return;
  if (Array.isArray(obj)) {
    for (const it of obj) collectPresentationNames(it, out);
    return;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && /(name|title)/i.test(k)) {
        out.add(v);
      }
    }
    for (const v of Object.values(obj)) collectPresentationNames(v as any, out);
  }
}

export async function matchPresentations(payload: { host: string; port: number; titles: string[] }): Promise<{ matches: Record<string, { matched: boolean; uuid?: string; candidates?: { uuid: string; name: string }[] }>; stats?: { libraries: number; names: number } }> {
  const { host, port, titles } = payload;
  const libsResp = await fetchJson(host, port, '/v1/libraries');
  let libraryIds: string[] = [];
  if (libsResp.status >= 200 && libsResp.status < 300 && libsResp.json) {
    const ids: string[] = [];
    const rec = (obj: any) => {
      if (!obj) return;
      if (Array.isArray(obj)) { obj.forEach(rec); return; }
      if (typeof obj === 'object') {
        if (obj.uuid && obj.name) ids.push(String(obj.uuid));
        if (obj.id && (obj.type === 'library' || /library/i.test(String(obj.type ?? '')))) ids.push(String(obj.id));
        for (const v of Object.values(obj)) rec(v);
      }
    };
    rec(libsResp.json);
    libraryIds = Array.from(new Set(ids));
  }

  // Map normalized name -> array of { uuid, name }
  const byNorm = new Map<string, { uuid: string; name: string }[]>();
  for (const libId of libraryIds.slice(0, 10)) { // limit to avoid huge scans
    const r = await fetchJson(host, port, `/v1/library/${encodeURIComponent(libId)}`);
    if (r.status >= 200 && r.status < 300) {
      const rec = (obj: any) => {
        if (!obj) return;
        if (Array.isArray(obj)) { obj.forEach(rec); return; }
        if (typeof obj === 'object') {
          const idVal = obj.id ?? obj.uuid;
          let nm: string | undefined;
          for (const [k,v] of Object.entries(obj)) { if (typeof v === 'string' && /(name|title)/i.test(k)) { nm = v; break; } }
          if (nm && (typeof idVal === 'string' || typeof idVal === 'number')) {
            const norm = normalizeTitle(nm);
            const arr = byNorm.get(norm) ?? [];
            arr.push({ uuid: String(idVal), name: nm! });
            byNorm.set(norm, arr);
          }
          for (const v of Object.values(obj)) rec(v);
        }
      };
      rec(r.json ?? r.text);
    }
  }
  const allNamesCount = Array.from(byNorm.values()).reduce((n, arr) => n + arr.length, 0);
  const result: Record<string, { matched: boolean; uuid?: string; candidates?: { uuid: string; name: string }[] }> = {};
  for (const t of titles) {
    const norm = normalizeTitle(t);
    const exact = byNorm.get(norm) || [];
    if (exact.length > 0) {
      result[t] = { matched: true, uuid: exact[0].uuid, candidates: exact };
    } else {
      // simple partial candidates list
      const parts = norm.split(' ').filter(Boolean);
      const candidates: { uuid: string; name: string }[] = [];
      for (const arr of byNorm.values()) {
        for (const p of arr) {
          const nn = normalizeTitle(p.name);
          if (parts.every(w => nn.includes(w))) { candidates.push({ uuid: p.uuid, name: p.name }); if (candidates.length >= 5) break; }
        }
        if (candidates.length >= 5) break;
      }
      result[t] = { matched: false, candidates: candidates.length ? candidates : undefined };
    }
  }
  return { matches: result, stats: { libraries: libraryIds.length, names: allNamesCount } };
}

export async function getPresentation(host: string, port: number, uuid: string) {
  return await fetchJson(host, port, `/v1/presentation/${encodeURIComponent(uuid)}`);
}

// helper removed after testing
/* export async function getEndpoint(payload: { host: string; port: number; path: string }): Promise<{ ok: boolean; statusCode?: number; json?: any; text?: string; path: string; error?: string }> {
  const { host, port, path } = payload;
  if (!host || !port || !path) return { ok: false, error: 'Missing host/port/path', path };
  return await new Promise((resolve) => {
    const req = http.request({ host, port, path, method: 'GET', timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => { if (chunks.reduce((n, b) => n + b.length, 0) < 1_048_576) chunks.push(c as Buffer); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any | undefined;
        try { json = JSON.parse(text); } catch {}
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, statusCode: status, json, text, path });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e: any) => resolve({ ok: false, error: e?.message || 'error', path }));
    req.end();
  });
} */

export async function syncPlaylist(payload: { host: string; port: number; name: string; titles: string[] }): Promise<{ ok: boolean; error?: string }>{
  const { host, port } = payload;
  if (!host || !port) return { ok: false, error: 'Missing host/port' };
  return { ok: false, error: 'Not implemented' };
}
