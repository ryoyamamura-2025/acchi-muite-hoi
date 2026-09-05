export type GameSoundCue =
  | 'start'
  | 'chant'
  | 'hoi'
  | 'retry'
  | 'player-point'
  | 'cpu-point'
  | 'miss'
  | 'win'
  | 'lose';

export interface GameSoundPort {
  unlock(): void;
  play(cue: GameSoundCue): void;
}

type WebkitAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/**
 * 外部音源を持たず、Web Audio APIだけで短いSEを鳴らす。
 * AudioContextが使えない環境（Nodeのテスト等）ではno-opになる。
 */
export function createBrowserGameSound(): GameSoundPort {
  let context: AudioContext | null = null;
  let resumePromise: Promise<void> | null = null;

  const unlock = (): void => {
    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) return;

    context ??= new AudioContextConstructor();
    if (context.state === 'running' || context.state === 'closed') return;

    resumePromise ??= context
      .resume()
      .catch(() => undefined)
      .finally(() => {
        resumePromise = null;
      });
  };

  const play = (cue: GameSoundCue): void => {
    const activeContext = context;
    if (!activeContext) return;

    if (activeContext.state === 'running') {
      playCue(activeContext, cue);
      return;
    }

    const pendingResume = resumePromise;
    if (!pendingResume) return;

    void pendingResume.then(() => {
      if (activeContext.state === 'running') playCue(activeContext, cue);
    });
  };

  return { unlock, play };
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as WebkitAudioWindow).webkitAudioContext ?? null;
}

function playCue(context: AudioContext, cue: GameSoundCue): void {
  const now = context.currentTime;
  switch (cue) {
    case 'start':
      tone(context, 440, now, 0.1, 0.045);
      tone(context, 660, now + 0.12, 0.12, 0.05);
      return;
    case 'chant':
      tone(context, 330, now, 0.18, 0.035, 'triangle');
      return;
    case 'hoi':
      tone(context, 880, now, 0.09, 0.065, 'square');
      tone(context, 1175, now + 0.04, 0.08, 0.045, 'square');
      return;
    case 'retry':
      tone(context, 294, now, 0.09, 0.035, 'triangle');
      tone(context, 294, now + 0.13, 0.09, 0.03, 'triangle');
      return;
    case 'player-point':
      tone(context, 523, now, 0.12, 0.055);
      tone(context, 659, now + 0.1, 0.12, 0.055);
      tone(context, 784, now + 0.2, 0.16, 0.06);
      return;
    case 'cpu-point':
      tone(context, 440, now, 0.13, 0.045, 'triangle');
      tone(context, 330, now + 0.13, 0.17, 0.04, 'triangle');
      return;
    case 'miss':
      tone(context, 220, now, 0.1, 0.035, 'triangle');
      return;
    case 'win':
      tone(context, 523, now, 0.12, 0.055);
      tone(context, 659, now + 0.1, 0.12, 0.055);
      tone(context, 784, now + 0.2, 0.12, 0.06);
      tone(context, 1047, now + 0.32, 0.22, 0.065);
      return;
    case 'lose':
      tone(context, 392, now, 0.15, 0.04, 'triangle');
      tone(context, 330, now + 0.14, 0.15, 0.038, 'triangle');
      tone(context, 262, now + 0.28, 0.22, 0.035, 'triangle');
      return;
  }
}

function tone(
  context: AudioContext,
  frequency: number,
  startAt: number,
  duration: number,
  volume: number,
  type: OscillatorType = 'sine',
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const endAt = startAt + duration;

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(endAt + 0.02);
}
