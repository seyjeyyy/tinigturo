/**
 * Live waveform geometry. It visualizes the raw microphone signal so a reader can see
 * that the microphone hears them. It is display only: it is not transcript matching,
 * not pronunciation assessment, and not pitch or rhythm feedback.
 */

/** Vertical extent (0..1 of half the height) per column, from min/max of each sample bucket. */
export function waveformColumns(samples: ArrayLike<number>, columns: number, gain = 3): { low: number; high: number }[] {
  const out: { low: number; high: number }[] = [];
  if (columns <= 0) return out;
  const per = Math.max(1, Math.floor(samples.length / columns));
  for (let c = 0; c < columns; c++) {
    let low = 0;
    let high = 0;
    const start = c * per;
    const end = Math.min(samples.length, start + per);
    for (let i = start; i < end; i++) {
      const v = samples[i] * gain;
      if (v < low) low = v;
      if (v > high) high = v;
    }
    out.push({ low: Math.max(-1, low), high: Math.min(1, high) });
  }
  return out;
}

/** Draws the waveform, or a flat line when no samples are available. */
export function drawWaveform(ctx: CanvasRenderingContext2D, width: number, height: number, samples: ArrayLike<number> | null, color: string): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color;
  const mid = height / 2;
  const columns = waveformColumns(samples ?? [], Math.floor(width / 2));
  if (!samples || !columns.length) {
    ctx.fillRect(0, mid - 0.5, width, 1);
    return;
  }
  columns.forEach(({ low, high }, c) => {
    const top = mid - high * mid;
    const bottom = mid - low * mid;
    ctx.fillRect(c * 2, top, 1.5, Math.max(1, bottom - top));
  });
}
