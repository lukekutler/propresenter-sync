// Renderer-friendly ProPresenter client shim. All network I/O is done in the
// Electron main process via window.api to avoid Node modules in the renderer.

export type PPStatus =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'connected'; rttMs?: number }
  | { state: 'error'; message: string };

export class ProPresenterClient {
  private readonly host: string;
  private readonly port: number;

  constructor(opts: { host: string; port?: number }) {
    this.host = opts.host;
    this.port = opts.port ?? 1025; // Network API default
  }

  async connect(): Promise<PPStatus> {
    try {
      const res = await window.api.testProPresenter({ host: this.host, port: this.port });
      if (res.reachable) {
        return { state: 'connected', rttMs: res.latencyMs };
      }
      return { state: 'error', message: res.error || 'unreachable' };
    } catch (e: any) {
      return { state: 'error', message: e?.message || 'error' };
    }
  }
}
