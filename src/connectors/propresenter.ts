
// Shared types for ProPresenter connectors used by renderer and electron code.
export type PPConfig = { host: string; port: number; password?: string };
export type PPTestResult = {
  reachable: boolean;
  authenticated: boolean;
  latencyMs?: number;
  error?: string;
};

// Renderer shouldn't directly connect; main process handles network I/O.
// Keep this file types-only to avoid Node imports in the renderer project.

export async function createOrUpdatePlaylist(_title: string) {
  // TODO: implement
  return true;
}
