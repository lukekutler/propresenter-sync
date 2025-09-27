import { useState } from 'react';

type TestResult = {
   reachable: boolean;
   authenticated: boolean;
   latencyMs?: number;
   error?: string;
   pathTried?: string;
   statusCode?: number;
 } | null;
 
type IntegrationStatus = { state: 'pending'|'ok'|'error'; message?: string; detail?: string; path?: string; count?: number };
 
type ConnectionsProps = {
   host: string;
   setHost: (value: string) => void;
   port: number;
   setPort: (value: number) => void;
   libraryPath: string;
   setLibraryPath: (value: string) => void;
   refresh: () => void | Promise<void>;
   statuses: { proPresenter: IntegrationStatus; planningCenter: IntegrationStatus; library: IntegrationStatus };
   booting: boolean;
 };
 
 export default function Connections({ host, setHost, port, setPort, libraryPath, setLibraryPath, refresh, statuses, booting }: ConnectionsProps) {
   const [result, setResult] = useState<TestResult>(null);
   const [libInfo, setLibInfo] = useState<string>('');
   const [pcoStatus, setPcoStatus] = useState<{ ok: boolean; statusCode?: number; error?: string } | null>(null);
 
   async function testProPresenter() {
     const res = await window.api.testProPresenter({ host, port });
     setResult(res);
   }
 
   const proStatusText = statuses.proPresenter.state === 'ok'
     ? (statuses.proPresenter.message || 'Connected')
     : statuses.proPresenter.state === 'error'
       ? (statuses.proPresenter.message || 'Not connected')
       : 'Checking…';
 
   const libraryStatusText = statuses.library.state === 'ok'
     ? (statuses.library.message || 'Indexed')
     : statuses.library.state === 'error'
       ? (statuses.library.message || 'Needs setup')
       : 'Checking…';
 
   const planningStatusText = statuses.planningCenter.state === 'ok'
     ? (statuses.planningCenter.message || 'Connected')
     : statuses.planningCenter.state === 'error'
       ? (statuses.planningCenter.message || 'Not connected')
       : 'Checking…';
 
   return (
     <div className="grid md:grid-cols-2 gap-6">
       <div className="card p-6 space-y-4">
         <div>
           <div className="text-lg font-semibold mb-3">ProPresenter</div>
           <label className="block text-sm mb-2">Host</label>
           <input className="w-full bg-neutral-800 rounded-lg p-2" value={host} onChange={e => setHost(e.target.value)} />
           <label className="block text-sm mt-3 mb-2">Port</label>
           <input
             type="number"
             className="w-full bg-neutral-800 rounded-lg p-2"
             value={port}
             onChange={e => {
               const v = Number(e.target.value);
               setPort(Number.isNaN(v) ? 1025 : v);
             }}
           />
           <div className="mt-2 text-xs opacity-60">Status: {proStatusText}</div>
           <div className="mt-4 flex items-center gap-3">
             <button className="btn" onClick={testProPresenter}>Test Connection</button>
             <span className={`pill ${result ? (result.authenticated ? 'bg-green-500/15 text-green-400 border-green-500/30' : (result.reachable ? 'bg-red-500/15 text-red-400 border-red-500/30' : 'bg-red-500/15 text-red-400 border-red-500/30')) : ''}`}>
               {result
                 ? result.authenticated
                   ? 'Connected'
                   : result.reachable
                     ? `Not connected • ${result.statusCode ?? ''}${result.statusCode ? '' : (result.error ? result.error : '')}`
                     : `Unreachable${result.error ? ` • ${result.error}` : ''}`
                 : 'Not tested'}
             </span>
           </div>
         </div>
 
         <div>
           <label className="block text-sm mt-5 mb-2">Library Path</label>
           <div className="flex gap-2">
             <input
               className="w-full bg-neutral-800 rounded-lg p-2"
               placeholder="~/Documents/ProPresenter/Libraries/Presentations"
               value={libraryPath}
               onChange={e => setLibraryPath(e.target.value)}
             />
             <button className="btn" onClick={async ()=>{
               const res = await (window as any).api.ppFindLibraryRoot();
               if (res?.ok && res.best?.path) { setLibraryPath(res.best.path); refresh(); }
               setLibInfo(res?.ok ? `Detected ${res.best?.files ?? 0} .pro files` : 'Not found');
             }}>Detect</button>
             <button className="btn" onClick={async ()=>{
               if (!libraryPath) { setLibInfo('Set Library Path first'); return; }
               const res = await (window as any).api.ppIndexPresentations({ root: libraryPath });
               setLibInfo(res?.ok ? `Indexed ${res.count} items` : 'Index failed');
               refresh();
             }}>Index</button>
             <button className="btn" onClick={async ()=>{
               if (!libraryPath) { setLibInfo('Set Library Path first'); return; }
               const res = await (window as any).api.ppIndexPresentationsUuid({ root: libraryPath });
               if (res?.ok) {
                 setLibInfo(`Indexed by UUID: ${res.count}`);
                 refresh();
               } else {
                 const detail = (res?.err || res?.error || res?.out || '').split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean)[0] || '';
                 console.error('UUID index failed', res);
                 setLibInfo(detail ? `UUID index failed • ${detail}` : 'UUID index failed');
               }
             }}>Index (UUID)</button>
           </div>
           {libInfo && <div className="text-xs opacity-70 mt-2">{libInfo}</div>}
           <div className="text-xs opacity-60 mt-2">Status: {libraryStatusText}</div>
         </div>
 
         <div className="text-xs opacity-60">
           <div>Need to re-run the automatic checks? They run on launch, but you can run them again manually.</div>
           <button className="btn btn-sm mt-2" onClick={() => refresh()} disabled={booting}>{booting ? 'Checking…' : 'Re-run Checks'}</button>
         </div>
       </div>
 
       <div className="card p-6">
         <div className="text-lg font-semibold mb-3">Planning Center</div>
         <p className="text-sm opacity-80">Using .env values PCO_APP_ID and PCO_SECRET for local development.</p>
         <div className="mt-2 text-xs opacity-60">Status: {planningStatusText}</div>
         <div className="mt-4 flex items-center gap-3">
           <button className="btn" onClick={async () => {
             const res = await window.api.pcoTest();
             setPcoStatus({ ok: res.ok, statusCode: res.statusCode, error: res.error });
           }}>Test Connection</button>
           <span className={`pill ${pcoStatus ? (pcoStatus.ok ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-red-500/15 text-red-400 border-red-500/30') : ''}`}>
             {pcoStatus ? (pcoStatus.ok ? 'Connected' : `Failed${pcoStatus.statusCode ? ` • ${pcoStatus.statusCode}` : ''}${pcoStatus.error ? ` • ${pcoStatus.error}` : ''}`) : 'Not tested'}
           </span>
         </div>
       </div>
     </div>
   );
 }
