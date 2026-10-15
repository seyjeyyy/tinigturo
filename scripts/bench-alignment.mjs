// Measures the cost of live alignment on this machine: every partial transcript
// update re-aligns the unconfirmed tail. Run: node scripts/bench-alignment.mjs
// (Results on low-cost target devices must be measured there; see docs/SPEECH.md.)
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { StreamingAligner } = await server.ssrLoadModule('/src/alignment/aligner.ts');
  const { tokenizePassage } = await server.ssrLoadModule('/src/text/tokenize.ts');
  const { STARTER_STORIES } = await server.ssrLoadModule('/src/content/starterStories.ts');

  const lola = STARTER_STORIES.find((s) => s.title === "Lola's Garden");
  const long = Array.from({ length: 5 }, () => lola.body).join('\n\n');

  function run(label, body, errorRate) {
    const passage = tokenizePassage(body, 'en');
    const words = passage.words.map((w) => w.core.toLowerCase());
    const aligner = new StreamingAligner(passage.words, 'en');
    const times = [];
    let segment = 0;
    let current = [];
    let rng = 42;
    const random = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < words.length; i++) {
      // Simulated disfluencies, each a third of `errorRate`: saying "um" instead of the
      // word (so the word is not read), repeating the word, or skipping it.
      const r = random();
      if (r < errorRate / 3) current.push('um');
      else if (r < (2 * errorRate) / 3) current.push(words[i], words[i]);
      else if (r < errorRate) continue;
      else current.push(words[i]);
      const final = current.length >= 6;
      const t0 = performance.now();
      aligner.update(`s${segment}`, current.join(' '), final, i * 400);
      times.push(performance.now() - t0);
      if (final) {
        segment++;
        current = [];
      }
    }
    const t0 = performance.now();
    const result = aligner.finish();
    const finishMs = performance.now() - t0;
    times.sort((a, b) => a - b);
    const mean = times.reduce((s, t) => s + t, 0) / times.length;
    const matched = result.statuses.filter((s) => s === 'correct' || s === 'self_corrected').length;
    console.log(
      `${label}: ${passage.words.length} words, ${times.length} updates | per update mean ${mean.toFixed(3)} ms, p95 ${times[Math.floor(times.length * 0.95)].toFixed(3)} ms, max ${times[times.length - 1].toFixed(3)} ms | finish ${finishMs.toFixed(2)} ms | matched ${matched}/${passage.words.length}`,
    );
  }

  run('Lola\'s Garden (clean reading)', lola.body, 0);
  run('Lola\'s Garden (15% disfluencies)', lola.body, 0.15);
  run('5x passage (clean)', long, 0);
  run('5x passage (15% disfluencies)', long, 0.15);
} finally {
  await server.close();
}
