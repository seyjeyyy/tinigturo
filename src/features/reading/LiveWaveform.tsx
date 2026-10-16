import { useEffect, useRef, useState } from 'react';
import { drawWaveform } from '../../recording/waveform';

interface WaveformSource {
  readWaveform(target: Float32Array<ArrayBuffer>): boolean;
}

export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches));
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const onChange = () => setReduced(list.matches);
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

/**
 * What the microphone hears right now, drawn from the real microphone signal. Display
 * only: it says nothing about which words were read or how they were pronounced. With
 * reduced motion, or without audio analysis, a still level bar is shown instead.
 */
export function LiveWaveform({ source, active, level }: { source: WaveformSource | null; active: boolean; level: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.('2d');
    if (!active || !source || reduced || !canvas || !ctx) return;
    const samples = new Float32Array(1024);
    const color = getComputedStyle(canvas).color || '#0f766e';
    let frame = 0;
    let last = 0;
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      if (time - last < 33) return; // about 30 frames a second is plenty
      last = time;
      const ok = source.readWaveform(samples);
      if (!ok) {
        setSupported(false);
        cancelAnimationFrame(frame);
        return;
      }
      drawWaveform(ctx, canvas.width, canvas.height, samples, color);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      drawWaveform(ctx, canvas.width, canvas.height, null, color);
    };
  }, [active, source, reduced]);

  if (reduced || !supported) {
    return (
      <span className="h-2 w-16 overflow-hidden rounded-full bg-line" aria-hidden="true" data-testid="level-meter">
        <span className="level-meter block h-full bg-teal-brand" style={{ width: `${Math.round(level * 100)}%` }} />
      </span>
    );
  }
  return <canvas ref={canvasRef} width={96} height={28} className="h-7 w-24 text-teal-brand" aria-hidden="true" data-testid="live-waveform" />;
}
