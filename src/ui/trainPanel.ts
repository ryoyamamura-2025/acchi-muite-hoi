import { SampleCounts } from '../ml/classifier';
import { CLASS_LABELS, CLASS_META, ClassLabel, MIN_SAMPLES_PER_CLASS } from '../ml/labels';

export interface TrainPanelDeps {
  onCaptureStart(label: ClassLabel): void;
  onCaptureStop(): void;
  onClearClass(label: ClassLabel): void;
}

/**
 * 学習パネル。ボタンを押しっぱなしにしている間だけサンプルを追加する
 * （Teachable Machine と同じ操作感）。
 */
export class TrainPanel {
  private readonly cards = new Map<ClassLabel, HTMLElement>();
  private readonly counters = new Map<ClassLabel, HTMLElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly deps: TrainPanelDeps,
  ) {
    this.root.classList.add('train-grid');

    for (const label of CLASS_LABELS) {
      const meta = CLASS_META[label];

      const card = document.createElement('div');
      card.className = 'train-card';

      const title = document.createElement('div');
      title.className = 'train-title';
      title.textContent = `${meta.icon} ${meta.ja}`;

      const hint = document.createElement('div');
      hint.className = 'train-hint';
      hint.textContent = meta.hint;

      const counter = document.createElement('div');
      counter.className = 'train-count';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'train-button';
      button.textContent = '押しっぱなしで撮る';

      const start = (event: PointerEvent) => {
        event.preventDefault();
        button.setPointerCapture(event.pointerId);
        card.classList.add('is-capturing');
        this.deps.onCaptureStart(label);
      };
      const stop = () => {
        card.classList.remove('is-capturing');
        this.deps.onCaptureStop();
      };
      button.addEventListener('pointerdown', start);
      button.addEventListener('pointerup', stop);
      button.addEventListener('pointercancel', stop);
      // キーボード操作（Space / Enter の押しっぱなし）でも撮れるように。
      button.addEventListener('keydown', (event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
          event.preventDefault();
          card.classList.add('is-capturing');
          this.deps.onCaptureStart(label);
        }
      });
      button.addEventListener('keyup', stop);
      button.addEventListener('blur', stop);

      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'link-button';
      clear.textContent = 'このクラスを消す';
      clear.addEventListener('click', () => this.deps.onClearClass(label));

      card.append(title, hint, counter, button, clear);
      this.root.append(card);

      this.cards.set(label, card);
      this.counters.set(label, counter);
    }
  }

  update(counts: SampleCounts): void {
    for (const label of CLASS_LABELS) {
      const count = counts[label];
      const counter = this.counters.get(label)!;
      counter.textContent = `${count} 枚`;
      const card = this.cards.get(label)!;
      card.classList.toggle('is-insufficient', count < MIN_SAMPLES_PER_CLASS);
    }
  }
}
