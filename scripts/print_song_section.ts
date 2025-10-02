import { getNextPlan } from '../electron/pco';

async function main() {
  const [songTitle = 'I Thank God', sectionName = 'Verse 1'] = process.argv.slice(2);

  try {
    const res = await getNextPlan();
    if (!res.ok || !res.plan) {
      console.error('Failed to fetch plan:', res.error || 'Unknown error');
      process.exitCode = 1;
      return;
    }

    const plan = res.plan;
    const song = plan.items.find((item) => item.kind === 'song' && item.title.trim().toLowerCase() === songTitle.trim().toLowerCase());
    if (!song || !song.songDetails) {
      console.error(`Song "${songTitle}" not found or missing details.`);
      process.exitCode = 1;
      return;
    }

    const sections = song.songDetails.sections ?? [];
    const match = sections.find((section) => {
      const name = section.name?.trim().toLowerCase();
      const seq = section.sequenceLabel?.trim().toLowerCase();
      const target = sectionName.trim().toLowerCase();
      return name === target || seq === target;
    });

    if (!match) {
      console.error(`Section "${sectionName}" not found in song "${songTitle}".`);
      process.exitCode = 1;
      return;
    }

    if (!match.lyrics) {
      console.warn(`Section "${sectionName}" has no lyrics payload.`);
      return;
    }

    console.log(`Song: ${song.title}`);
    console.log(`Section: ${match.sequenceLabel ? `[${match.sequenceLabel}] ` : ''}${match.name}`);
    console.log('\n' + match.lyrics);
    if (match.lyricSlides?.length) {
      console.log('\nSlides:');
      match.lyricSlides.forEach((slide, idx) => {
        console.log(`  Slide ${idx + 1}: ${slide.join(' / ')}`);
      });
    }
  } catch (err) {
    console.error('Unexpected error while fetching section lyrics:', err);
    process.exitCode = 1;
  }
}

void main();
