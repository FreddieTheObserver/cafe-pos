/** Browsers refuse to play sound until a tap, so the screen asks for one and keeps the context. */
let ctx: AudioContext | null = null;

export const enableAudio = async (): Promise<boolean> => {
  try {
    ctx ??= new AudioContext();
    await ctx.resume();
    chime();
    return ctx.state === 'running';
  } catch {
    return false;
  }
};

export const audioReady = (): boolean => ctx?.state === 'running';

export const chime = (): void => {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.2, now + i * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.18 + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.18);
    osc.stop(now + i * 0.18 + 0.4);
  }
};
