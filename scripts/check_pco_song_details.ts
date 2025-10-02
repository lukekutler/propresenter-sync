import { getNextPlan } from '../electron/pco';

async function main() {
  try {
    const res = await getNextPlan();
    if (!res.ok || !res.plan) {
      console.error('Failed to fetch plan:', res.error || 'Unknown error', 'status=', res.statusCode);
      process.exitCode = 1;
      return;
    }

    const plan = res.plan;
    console.log(`Plan: ${plan.title} (${plan.date})`);
    for (const item of plan.items) {
      if (item.kind !== 'song' || !item.songDetails) continue;
      const { songId, arrangementId, arrangementName, sequenceSummary, sections, sequence } = item.songDetails;
      console.log('—', item.title);
      console.log('   songId:', songId);
      if (arrangementId) console.log('   arrangementId:', arrangementId);
      if (arrangementName) console.log('   arrangementName:', arrangementName);
      if (sequenceSummary) console.log('   sequenceSummary:', sequenceSummary);
      console.log('   sections:', sections?.length ?? 0);
      if (sections?.length) {
        for (const section of sections) {
          console.log(`     • ${section.sequenceLabel ? `[${section.sequenceLabel}] ` : ''}${section.name}`);
          if (section.lyrics) {
            const snippet = section.lyrics.split('\n').slice(0, 2).join(' | ');
            console.log('       lyrics:', snippet.length > 120 ? `${snippet.slice(0, 117)}...` : snippet);
          }
        }
      }
      console.log('   sequence entries:', sequence?.length ?? 0);
    }
  } catch (err) {
    console.error('Error while fetching plan details:', err);
    process.exitCode = 1;
  }
}

void main();
