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
  unlock(): Promise<void>;
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

  const unlock = async (): Promise<void> => {
    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) return;

    context ??= new AudioContextConstructor();
    if (context.state === 'running' || context.state === 'closed') return;

    try {
      await context.resume();
    } catch {
      // 音は補助演出なので、再生できない端末でもゲーム自体は継続する。
    }
  };

  const play = (cue: GameSoundCue): void => {
    const activeContext = context;
    if (!activeContext || activeContext.state !== 'running') return;

    const now = activeContext.currentTime;
    switch (cue) {
      case 'start':
        tone(activeContext, 440, now, 0.1, 0.045);
        tone(activeContext, 660, now + 0.12, 0.12, 0.05);
        return;
      case 'chant':
        tone(activeContext, 330, now, 0.18, 0.035, 'triangle');
        return;
      case 'hoi':
        tone(activeContext, 880, now, 0.09, 0.065, 'square');
        tone(activeContext, 1175, now + 0.04, 0.08, 0.045, 'square');
        return;
      case 'retry':
        tone(activeContext, 294, now, 0.09, 0.035, 'triangle');
        tone(activeContext, 294, now + 0.13, 0.09, 0.03, 'triangle');
        return;
      case 'player-point':
        tone(activeContext, 523, now, 0.12, 0.055);
        tone(activeContext, 659, now + 0.1, 0.12, 0.055);
        tone(activeContext, 784, now + 0.2, 0.16, 0.06);
        return;
      case 'cpu-point':
        tone(activeContext, 440, now, 0.13, 0.045, 'triangle');
        tone(activeContext, 330, now + 0.13, 0.17, 0.04, 'triangle');
        return;
      case 'miss':
        tone(activeContext, 220, now, 0.1, 0.035, 'triangle');
        return;
      case 'win':
        tone(activeContext, 523, now, 0.12, 0.055);
        tone(activeContext, 659, now + 0.1, 0.12, 0.055);
        tone(activeContext, 784, now + 0.2, 0.12, 0.06);
        tone(activeContext, 1047, now + 0.32, 0.22, 0.065);
        return;
      case 'lose':
        tone(activeContext, 392, now, 0.15, 0.04, 'triangle');
        tone(activeContext, 330, now + 0.14, 0.15, 0.038, 'triangle');
        tone(activeContext, 262, now + 0.28, 0.22, 0.035, 'triangle');
        return;
    }
  };

  return { unlock, play };
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as WebkitAudioWindow).webkitAudioContext ?? null;
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
