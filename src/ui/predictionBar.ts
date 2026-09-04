import { Prediction } from '../ml/classifier';
import { CLASS_LABELS, CLASS_META, ClassLabel } from '../ml/labels';

/** 各クラスの信頼度バー。学習の効き具合が目で見えるようにするためのもの。 */
export class PredictionBars {
  private readonly fills = new Map<ClassLabel, HTMLElement>();
  private readonly values = new Map<ClassLabel, HTMLElement>();
  private readonly rows = new Map<ClassLabel, HTMLElement>();

  constructor(private readonly root: HTMLElement) {
    this.root.classList.add('bars');
    for (const label of CLASS_LABELS) {
      const meta = CLASS_META[label];

      const row = document.createElement('div');
      row.className = 'bar-row';

      const name = document.createElement('span');
      name.className = 'bar-name';
      name.textContent = `${meta.icon} ${meta.ja}`;

      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      track.append(fill);

      const value = document.createElement('span');
      value.className = 'bar-value';
      value.textContent = '–';

      row.append(name, track, value);
      this.root.append(row);

      this.rows.set(label, row);
      this.fills.set(label, fill);
      this.values.set(label, value);
    }
  }

  update(prediction: Prediction | null): void {
    for (const label of CLASS_LABELS) {
      const confidence = prediction?.confidences[label] ?? 0;
      this.fills.get(label)!.style.width = `${Math.round(confidence * 100)}%`;
      this.values.get(label)!.textContent = prediction ? `${Math.round(confidence * 100)}%` : '–';
      this.rows.get(label)!.classList.toggle('is-top', prediction?.label === label);
    }
  }
}
