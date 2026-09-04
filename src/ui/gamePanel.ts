import { CLASS_META, ClassLabel, Direction, MIN_SAMPLES_PER_CLASS } from '../ml/labels';
import { GameState, HAND_META, Hand, TARGET_SCORE } from '../game/stateMachine';

export interface GamePanelDeps {
  onStart(): void;
  onHand(hand: Hand): void;
}

/** ゲーム画面。{@link GameState} を受け取って描画するだけの受け身な UI。 */
export class GamePanel {
  private readonly score: HTMLElement;
  private readonly message: HTMLElement;
  private readonly attacker: HTMLElement;
  private readonly reveal: HTMLElement;
  private readonly jankenRow: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly notice: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly deps: GamePanelDeps,
  ) {
    this.root.classList.add('game-panel');

    this.notice = el('div', 'game-notice');

    this.score = el('div', 'game-score');
    this.attacker = el('div', 'game-attacker');
    this.message = el('div', 'game-message');
    this.reveal = el('div', 'game-reveal');

    this.jankenRow = el('div', 'janken-row');
    for (const hand of ['rock', 'scissors', 'paper'] as Hand[]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'janken-button';
      button.innerHTML = `<span class="janken-icon">${HAND_META[hand].icon}</span><span>${HAND_META[hand].ja}</span>`;
      button.addEventListener('click', () => this.deps.onHand(hand));
      this.jankenRow.append(button);
    }

    this.startButton = document.createElement('button');
    this.startButton.type = 'button';
    this.startButton.className = 'primary-button';
    this.startButton.textContent = 'ゲームを始める';
    this.startButton.addEventListener('click', () => this.deps.onStart());

    this.root.append(
      this.notice,
      this.score,
      this.attacker,
      this.message,
      this.reveal,
      this.jankenRow,
      this.startButton,
    );
  }

  update(state: GameState, ready: boolean, missing: ClassLabel[]): void {
    const blocked = !ready;
    this.notice.hidden = !blocked;
    this.notice.textContent = blocked
      ? `まず「① おしえる」で全クラスを ${MIN_SAMPLES_PER_CLASS} 枚以上撮ってください（足りないクラス: ${missing
          .map((label) => CLASS_META[label].ja)
          .join('・')}）`
      : '';

    this.score.textContent = `あなた ${state.score.player} – ${state.score.cpu} CPU　(${TARGET_SCORE} 点先取)`;

    this.attacker.textContent =
      state.attacker === 'player'
        ? '👉 あなたが指さす番'
        : state.attacker === 'cpu'
          ? '🙈 あなたが顔を向ける番'
          : '';

    this.message.textContent = state.message;

    const round = state.round;
    if (round && round.outcome !== 'undecided') {
      this.reveal.innerHTML = `<span>あなた: ${directionLabel(round.playerDirection)}</span><span>CPU: ${directionLabel(round.cpuDirection)}</span>`;
      this.reveal.hidden = false;
    } else {
      this.reveal.hidden = true;
    }

    this.jankenRow.hidden = blocked || state.phase !== 'janken';
    this.startButton.hidden = blocked || (state.phase !== 'idle' && state.phase !== 'match-over');
    this.startButton.textContent = state.phase === 'match-over' ? 'もう一回' : 'ゲームを始める';
  }
}

function directionLabel(direction: Direction | null): string {
  if (!direction) return '—';
  const meta = CLASS_META[direction];
  return `${meta.icon} ${meta.ja}`;
}

function el(tag: string, className: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}
