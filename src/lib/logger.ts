
export function log(msg: string, level: 'info'|'warn'|'error' = 'info') {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);
}
