import http from 'node:http';
import { fetchJson, normalizeTitle } from './pp';

type HTTPRes = { status: number; json?: any; text?: string };

function httpJson(host: string, port: number, path: string, method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', body?: any, headers: Record<string,string> = {}): Promise<HTTPRes> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const hdrs: Record<string,string> = { Accept: 'application/json', ...headers };
    if (payload && !hdrs['Content-Type']) hdrs['Content-Type'] = 'application/json';
    if (payload) hdrs['Content-Length'] = Buffer.byteLength(payload).toString();
    const req = http.request({ host, port, path, method, headers: hdrs, timeout: 8000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => { if (chunks.reduce((n,b)=>n+b.length,0) < 2097152) chunks.push(c as Buffer); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any | undefined;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0 }));
    if (payload) req.end(payload); else req.end();
  });
}

export async function syncPlaylist(payload: { host: string; port: number; name: string; titles?: string[]; items?: { type: 'header'|'presentation'; title: string }[] }): Promise<{ ok: boolean; changed: boolean; created?: boolean; playlistId?: string; totalDesired: number; totalResolved: number; error?: string }>{
  const { host, port, name } = payload;
  const titles = payload.titles ?? [];
  const itemsIn = payload.items ?? [];
  const desiredSource = itemsIn.length > 0 ? itemsIn : titles.map(t => ({ type: 'presentation' as const, title: t }));
  if (!host || !port) return { ok: false, changed: false, totalDesired: desiredSource.length, totalResolved: 0, error: 'Missing host/port' };

  // Resolve library ids
  const libsResp = await fetchJson(host, port, '/v1/libraries');
  let libraryIds: string[] = [];
  if (libsResp.status >= 200 && libsResp.json) {
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
  // If no libraries enumerated, leave list empty; API uses UUIDs

  // Build name -> refs
  const refsByNorm = new Map<string, { library_id: string; id: string; name: string }[]>();
  for (const libId of libraryIds.slice(0, 10)) {
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
            const arr = refsByNorm.get(norm) ?? [];
            arr.push({ library_id: String(libId), id: String(idVal), name: nm! });
            refsByNorm.set(norm, arr);
          }
          for (const v of Object.values(obj)) rec(v);
        }
      };
      rec(r.json ?? r.text);
    }
  }

  // Desired items: include headers + resolved presentations
  const desired: ({ id: { uuid: string }; type: 'presentation' } | { id: { uuid: null; name: string; index: number }; type: 'header'; header_color?: { red: number; green: number; blue: number; alpha: number } })[] = [];
  for (let i = 0; i < desiredSource.length; i++) {
    const it = desiredSource[i];
    if (it.type === 'header') {
      desired.push({ type: 'header', id: { uuid: null, name: it.title, index: i }, header_color: { red: 0, green: 0.54, blue: 0.87, alpha: 1 } });
    } else {
      const ref = (refsByNorm.get(normalizeTitle(it.title)) || [])[0];
      if (ref) desired.push({ type: 'presentation', id: { uuid: ref.id } });
    }
  }
  const totalDesired = desiredSource.length;
  const totalResolved = desired.length;

  // Find or create playlist
  const pls = await fetchJson(host, port, '/v1/playlists');
  let playlistId: string | undefined;
  if (pls.status >= 200 && pls.json) {
    const rec = (obj: any) => {
      if (!obj || playlistId) return;
      if (Array.isArray(obj)) { obj.forEach(rec); return; }
      if (typeof obj === 'object') {
        const nm = (obj.name ?? obj.title ?? '').toString();
        const idVal = obj.id ?? obj.uuid;
        if (nm && idVal && normalizeTitle(nm) === normalizeTitle(name)) playlistId = String(idVal);
        for (const v of Object.values(obj)) rec(v);
      }
    };
    rec(pls.json);
  }
  let created = false;
  if (!playlistId) {
    const r = await httpJson(host, port, '/v1/playlists', 'POST', { name, type: 'presentation' });
    if (r.status >= 200 && r.status < 300 && r.json?.id) { playlistId = String(r.json.id); created = true; }
  }
  if (!playlistId) return { ok: false, changed: false, totalDesired: titles.length, totalResolved: desired.length, error: 'Could not find or create playlist' };

  // Read current items
  const currentResp = await fetchJson(host, port, `/v1/playlist/${encodeURIComponent(playlistId)}`);
  const currentItems: any[] = (currentResp.json?.items ?? []) as any[];
  const currentRefs = currentItems
    .map((it: any) => it && it.type === 'presentation' && it.id && it.id.uuid ? `p:${String(it.id.uuid)}` : (it && it.type === 'header' && it.id && it.id.name ? `h:${normalizeTitle(String(it.id.name))}` : ''))
    .filter(Boolean);
  const desiredRefs = desired.map((it: any) => it.type === 'presentation' ? `p:${it.id.uuid}` : `h:${normalizeTitle(String(it.id.name))}`);

  const equal = currentRefs.length === desiredRefs.length && currentRefs.every((x, i) => x === desiredRefs[i]);
  if (equal) {
    return { ok: true, changed: false, created, playlistId, totalDesired, totalResolved };
  }

  // Replace with desired in one PUT
  const put = await httpJson(host, port, `/v1/playlist/${encodeURIComponent(playlistId)}`, 'PUT', desired);
  const ok = put.status >= 200 && put.status < 300;
  return ok ? { ok: true, changed: true, created, playlistId, totalDesired, totalResolved } : { ok: false, changed: false, created, playlistId, totalDesired, totalResolved, error: "status " + String(put.status) };
}
