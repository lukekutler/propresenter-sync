
// Planning Center connector — calls Electron main via IPC to avoid exposing secrets in renderer
export type PlanItem = {
  id: string;
  kind: 'song'|'video'|'announcement';
  title: string;
  order: number;
  isHeader?: boolean;
  lengthSeconds?: number;
  description?: string;
  notes?: string;
  category?: 'Song' | 'Message' | 'Transitions' | 'Videos' | 'Pre Service' | 'Post Service';
};
export type Plan = { id: string; date: string; title: string; items: PlanItem[] };

export async function fetchNextPlan(): Promise<Plan> {
  if (typeof window !== 'undefined' && (window as any).api?.pcoGetNextPlan) {
    const res = await window.api.pcoGetNextPlan();
    if (!res.ok || !res.plan) throw new Error(res.error || 'Failed to load PCO plan');
    return res.plan as unknown as Plan;
  }
  // Fallback mock if IPC not available
  await new Promise(r => setTimeout(r, 200));
  return {
    id: 'plan_mock',
    date: new Date().toISOString().slice(0,10),
    title: 'Mock Service',
    items: [
      { id: 'i1', kind: 'song', title: 'Sample Song', order: 1 },
      { id: 'i2', kind: 'announcement', title: 'Welcome', order: 2 },
    ]
  };
}
