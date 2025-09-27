
import { fetchNextPlan } from '@/connectors/planningCenter';
import { createOrUpdatePlaylist } from '@/connectors/propresenter';
import { log } from '@/lib/logger';

export async function runSundayPrep() {
  log('Starting Sunday Prep…');
  const plan = await fetchNextPlan();
  log(`Fetched plan: ${plan.title} (${plan.date}) with ${plan.items.length} items`);

  await createOrUpdatePlaylist(`${plan.date} — ${plan.title}`);
  log('Playlist created/updated');

  log('Done');
  return { ok: true as const };
}
