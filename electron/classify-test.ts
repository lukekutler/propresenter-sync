import { classifyPlanItem } from './pco';

const samples: Array<{ kind: 'song'|'video'|'announcement'; title: string }> = [
  { kind: 'announcement', title: 'Pre-Service Countdown' },
  { kind: 'song', title: 'Living Hope' },
  { kind: 'announcement', title: 'Message: Hope Series' },
  { kind: 'video', title: 'Baptism Video' },
  { kind: 'announcement', title: 'Host Welcome & Prayer' },
  { kind: 'announcement', title: 'Post-Service Walkout' },
  { kind: 'announcement', title: 'Church News' },
  { kind: 'video', title: 'Church News Video' },
  { kind: 'video', title: 'Ending Bumper & Exit' },
  { kind: 'announcement', title: 'Ending Bumper & Exit' },
  { kind: 'video', title: 'Closing Exit Video' },
];

const results = samples.map(s => ({ ...s, category: classifyPlanItem({ kind: s.kind, title: s.title }) }));

console.log(JSON.stringify(results, null, 2));
