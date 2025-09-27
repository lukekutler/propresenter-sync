
import { useEffect, useState } from 'react';

export default function Logs() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if ((window as any).api?.onLog) {
      const off = (window as any).api.onLog((line: string) => {
        setLines((l) => [...l.slice(-500), line]);
      });
      return () => { try { off(); } catch {} };
    }
    const i = setInterval(() => {
      setLines((l) => [...l.slice(-200), `${new Date().toLocaleTimeString()} heartbeat`]);
    }, 2000);
    return () => clearInterval(i);
  }, []);

  return (
    <div className="card p-4 font-mono text-xs h-[70vh] overflow-auto">
      {lines.map((ln, idx) => (
        <div key={idx} className="text-neutral-300">{ln}</div>
      ))}
    </div>
  );
}
