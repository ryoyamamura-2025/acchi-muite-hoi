import { Direction } from '../ml/labels';

const ARROWS: Record<Direction, string> = { up: '▲', right: '▶', down: '▼', left: '◀' };

/**
 * 画面上のキャラクター。指さされた方向に顔ごと動く。
 * 向きは CSS 側で `data-facing` を見て transform している。
 */
export class CharacterStage {
  private readonly figure: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly arrows = new Map<Direction, HTMLElement>();

  constructor(private readonly root: HTMLElement) {
    this.root.classList.add('stage');
    this.root.dataset.facing = 'front';

    for (const direction of Object.keys(ARROWS) as Direction[]) {
      const arrow = document.createElement('div');
      arrow.className = `stage-arrow stage-arrow--${direction}`;
      arrow.textContent = ARROWS[direction];
      this.root.append(arrow);
      this.arrows.set(direction, arrow);
    }

    this.figure = document.createElement('div');
    this.figure.className = 'chara';
    this.figure.innerHTML = FACE_SVG;

    this.badge = document.createElement('div');
    this.badge.className = 'stage-badge';
    this.badge.hidden = true;

    this.caption = document.createElement('div');
    this.caption.className = 'stage-caption';

    this.root.append(this.figure, this.badge, this.caption);
  }

  /** キャラクターが向く方向。`null` で正面。 */
  setFacing(direction: Direction | null): void {
    this.root.dataset.facing = direction ?? 'front';
  }

  /** 指さしを示す矢印のハイライト。`null` で全消灯。 */
  setPointer(direction: Direction | null): void {
    for (const [key, element] of this.arrows) {
      element.classList.toggle('is-active', key === direction);
    }
  }

  /** 「ほい！」などの掛け声。 */
  setBadge(text: string | null): void {
    this.badge.textContent = text ?? '';
    this.badge.hidden = text === null;
  }

  /** キャラクターが誰を表しているかの説明（「守り: CPU」など）。 */
  setCaption(text: string): void {
    this.caption.textContent = text;
  }

  setMood(mood: 'normal' | 'win' | 'lose'): void {
    this.root.dataset.mood = mood;
  }
}

const FACE_SVG = `
<svg viewBox="0 0 120 120" role="img" aria-label="キャラクター">
  <circle class="head" cx="60" cy="60" r="46" />
  <g class="face">
    <circle class="eye" cx="45" cy="52" r="6" />
    <circle class="eye" cx="75" cy="52" r="6" />
    <path class="mouth" d="M45 78 Q60 90 75 78" />
  </g>
</svg>`;
