import { getNextPlan } from './electron/pco.ts';

const NON_LYRIC_SECTION_PATTERN = /\b(intro|turn\s*around|turnaround|instrumental|interlude|outro|tag|ending)\b/i;

function toSlides(rawSlides: unknown): string[][] {
  if (!Array.isArray(rawSlides)) return [];
  const slides: string[][] = [];
  for (const slide of rawSlides) {
    if (!Array.isArray(slide)) continue;
    const lines = slide
      .map((line) => (typeof line === 'string' ? line.trim() : String(line ?? '').trim()))
      .filter((line) => line.length);
    if (lines.length) slides.push(lines);
  }
  return slides;
}

async function main() {
  const res = await getNextPlan();
  if (!res.ok || !res.plan) {
    console.error('Failed to fetch plan:', res.error || 'Unknown error', 'status=', res.statusCode);
    process.exitCode = 1;
    return;
  }

  const plan = res.plan;
  const target = plan.items.find((item) => item.kind === 'song' && item.title.toLowerCase().includes('i thank god'));
  if (!target || !target.songDetails) {
    console.error('Song "I Thank God" not found in plan.');
    process.exitCode = 1;
    return;
  }

  const songDetails = target.songDetails;
  const rawSections = Array.isArray(songDetails.sections) ? songDetails.sections : [];
  const sectionsPayload = rawSections
    .map((section) => {
      const slides = toSlides((section as any)?.lyricSlides);
      const sequenceLabel = typeof (section as any)?.sequenceLabel === 'string' ? (section as any).sequenceLabel : undefined;
      const sectionName = typeof (section as any)?.name === 'string' ? (section as any).name : undefined;
      const labelSource = sequenceLabel || sectionName || '';
      const isNonLyric = NON_LYRIC_SECTION_PATTERN.test(labelSource);
      if (!slides.length) {
        if (!isNonLyric) return null;
        return {
          id: typeof (section as any)?.id === 'string' ? (section as any).id : undefined,
          name: sectionName,
          sequenceLabel,
          slides: [] as string[][],
        };
      }
      return {
        id: typeof (section as any)?.id === 'string' ? (section as any).id : undefined,
        name: sectionName,
        sequenceLabel,
        slides,
      };
    })
    .filter((section): section is { id?: string; name?: string; sequenceLabel?: string; slides: string[][] } => Boolean(section));

  const seenSectionIds = new Set<string>();
  const seenLabels = new Set<string>();
  for (const section of sectionsPayload) {
    if (section.id) seenSectionIds.add(section.id);
    const key = (section.sequenceLabel || section.name || '').trim().toLowerCase();
    if (key) seenLabels.add(key);
  }

  if (Array.isArray(songDetails.sequence)) {
    for (const entry of songDetails.sequence) {
      const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
      const sectionId = typeof entry?.sectionId === 'string' ? entry.sectionId : undefined;
      if (!label && !sectionId) continue;
      if (sectionId && seenSectionIds.has(sectionId)) continue;
      const labelKey = label.toLowerCase();
      if (labelKey && seenLabels.has(labelKey)) continue;
      if (!NON_LYRIC_SECTION_PATTERN.test(label)) continue;
      sectionsPayload.push({
        id: sectionId,
        name: label || undefined,
        sequenceLabel: label || undefined,
        slides: [],
      });
      if (sectionId) seenSectionIds.add(sectionId);
      if (labelKey) seenLabels.add(labelKey);
    }
  }

  const sequencePayload = Array.isArray(songDetails.sequence)
    ? songDetails.sequence
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return undefined;
          const id = typeof entry.id === 'string' ? entry.id : undefined;
          const label = typeof entry.label === 'string' ? entry.label : undefined;
          const sectionId = typeof entry.sectionId === 'string' ? entry.sectionId : undefined;
          const position = typeof entry.position === 'number' && Number.isFinite(entry.position) ? entry.position : undefined;
          let number: string | undefined;
          const rawNumber = (entry as any).number;
          if (typeof rawNumber === 'number' && Number.isFinite(rawNumber)) {
            number = String(Math.trunc(rawNumber));
          } else if (typeof rawNumber === 'string' && rawNumber.trim()) {
            number = rawNumber.trim();
          }
          if (!id && !label && !sectionId && !number && position === undefined) return undefined;
          return { id, label, sectionId, position, number };
        })
        .filter((node): node is NonNullable<typeof node> => Boolean(node))
    : undefined;

  const payload = {
    title: target.title,
    arrangementName: typeof songDetails.arrangementName === 'string' ? songDetails.arrangementName : 'Default',
    groupName: typeof (songDetails as any)?.groupName === 'string' ? (songDetails as any).groupName : 'Lyrics',
    sections: sectionsPayload,
    sequence: sequencePayload,
  };

  console.log(JSON.stringify(payload));
}

void main();
