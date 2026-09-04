import * as tf from '@tensorflow/tfjs';
import './styles.css';
import { FeatureExtractor, createMobileNetExtractor } from './ml/featureExtractor';
import { PoseClassifier, Prediction } from './ml/classifier';
import { clearDataset, loadDataset, saveDataset } from './ml/storage';
import { CLASS_META, ClassLabel, DIRECTIONS, isDirection } from './ml/labels';
import { isCameraReady, startCamera } from './ui/camera';
import { PredictionBars } from './ui/predictionBar';
import { TrainPanel } from './ui/trainPanel';
import { CharacterStage } from './ui/character';
import { GamePanel } from './ui/gamePanel';
import { Game, GameState, Hand, randomHand } from './game/stateMachine';
import { JudgeSample } from './game/judge';

/** 推論の間隔。80ms なら「ほい！」の 500ms 窓で 6 枚前後集まる。 */
const INFERENCE_INTERVAL_MS = 80;
const TRAIN_CAPTURE_INTERVAL_MS = 100;
const SAVE_DEBOUNCE_MS = 800;

type Mode = 'train' | 'practice' | 'game';

const dom = {
  video: byId<HTMLVideoElement>('video'),
  status: byId('status'),
  error: byId('error'),
  bars: byId('bars'),
  memory: byId('memory'),
  tabs: byId('tabs'),
  stage: byId('stage'),
  trainPanel: byId('trainPanel'),
  trainGrid: byId('trainGrid'),
  practicePanel: byId('practicePanel'),
  practiceResult: byId('practiceResult'),
  gamePanel: byId('gamePanel'),
  clearAll: byId<HTMLButtonElement>('clearAll'),
  saveState: byId('saveState'),
};

const classifier = new PoseClassifier();
const bars = new PredictionBars(dom.bars);
const stage = new CharacterStage(dom.stage);

let extractor: FeatureExtractor | null = null;
let mode: Mode = 'train';
let capturingLabel: ClassLabel | null = null;
/** ゲームの「ほい！」窓のあいだだけ推論結果を溜めるバッファ。 */
let collector: JudgeSample[] | null = null;
let saveTimer: number | undefined;

const trainPanel = new TrainPanel(dom.trainGrid, {
  onCaptureStart(label) {
    capturingLabel = label;
  },
  onCaptureStop() {
    capturingLabel = null;
  },
  onClearClass(label) {
    classifier.clearClass(label);
    refreshCounts();
    scheduleSave();
  },
});

const game = new Game(
  {
    collect: (durationMs) =>
      new Promise((resolve) => {
        const buffer: JudgeSample[] = [];
        collector = buffer;
        window.setTimeout(() => {
          collector = null;
          resolve(buffer);
        }, durationMs);
      }),
    sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    randomDirection: () => DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)],
    randomHand,
  },
  renderGame,
);

const gamePanel = new GamePanel(dom.gamePanel, {
  onStart: () => game.start(),
  onHand: (hand: Hand) => void game.playHand(hand),
});

void boot();

async function boot(): Promise<void> {
  setupTabs();
  dom.clearAll.addEventListener('click', onClearAll);
  refreshCounts();
  renderGame(game.getState());
  applyMode('train');

  try {
    dom.status.textContent = 'カメラを起動中…';
    await startCamera(dom.video);
  } catch (error) {
    showError(error);
    return;
  }

  try {
    dom.status.textContent = 'モデルを読み込み中…（初回は数秒）';
    extractor = await createMobileNetExtractor();
  } catch (error) {
    showError(error);
    return;
  }

  await restoreDataset(extractor);

  dom.status.textContent = '準備OK — 「① おしえる」から始めてください';
  window.setInterval(() => {
    dom.memory.textContent = `tensors: ${tf.memory().numTensors} / backend: ${tf.getBackend()}`;
  }, 1000);

  requestAnimationFrame(tick);
}

async function restoreDataset(activeExtractor: FeatureExtractor): Promise<void> {
  try {
    const dataset = await loadDataset(activeExtractor.name, activeExtractor.featureDim);
    if (dataset) {
      classifier.importDataset(dataset);
      refreshCounts();
      dom.saveState.textContent = '前回の学習データを復元しました';
    }
  } catch (error) {
    console.warn('学習データの復元に失敗しました', error);
  }
}

let frameBusy = false;
let lastInference = 0;
let lastCapture = 0;

async function tick(now: number): Promise<void> {
  requestAnimationFrame(tick);
  if (frameBusy || !extractor || !isCameraReady(dom.video)) return;

  const wantCapture = capturingLabel !== null && now - lastCapture >= TRAIN_CAPTURE_INTERVAL_MS;
  const wantInference = now - lastInference >= INFERENCE_INTERVAL_MS;
  if (!wantCapture && !wantInference) return;

  frameBusy = true;
  try {
    const feature = extractor.infer(dom.video);
    try {
      if (wantCapture && capturingLabel !== null) {
        classifier.addExample(feature, capturingLabel);
        lastCapture = now;
        refreshCounts();
        scheduleSave();
      }
      if (wantInference) {
        lastInference = now;
        onPrediction(await classifier.predict(feature));
      }
    } finally {
      feature.dispose();
    }
  } catch (error) {
    console.error(error);
  } finally {
    frameBusy = false;
  }
}

function onPrediction(prediction: Prediction | null): void {
  bars.update(prediction);

  if (collector && prediction) {
    collector.push({ label: prediction.label, confidences: prediction.confidences });
  }

  if (mode !== 'practice') return;

  const direction = prediction && isDirection(prediction.label) ? prediction.label : null;
  stage.setFacing(direction);
  stage.setPointer(direction);
  dom.practiceResult.textContent = direction
    ? `${CLASS_META[direction].icon} ${CLASS_META[direction].ja}`
    : prediction
      ? `${CLASS_META.neutral.icon} ${CLASS_META.neutral.ja}`
      : '—';
}

function renderGame(state: GameState): void {
  gamePanel.update(state, classifier.isReady(), classifier.missingClasses());
  if (mode !== 'game') return;

  stage.setBadge(state.chant);
  stage.setMood(
    state.phase === 'match-over' ? (state.winner === 'player' ? 'lose' : 'win') : 'normal',
  );

  const round = state.round;
  if (state.phase === 'reveal' && round && round.outcome !== 'undecided') {
    // 矢印 = 攻めた側が指さした方向、顔 = 守った側が向いた方向。
    const attackerDirection = state.attacker === 'player' ? round.playerDirection : round.cpuDirection;
    const defenderDirection = state.attacker === 'player' ? round.cpuDirection : round.playerDirection;
    stage.setPointer(attackerDirection);
    stage.setFacing(defenderDirection);
    stage.setCaption(state.attacker === 'player' ? '守り: CPU' : '守り: あなた');
    return;
  }

  stage.setPointer(null);
  stage.setFacing(null);
  stage.setCaption(
    state.attacker === 'player' ? '守り: CPU' : state.attacker === 'cpu' ? '守り: あなた' : '',
  );
}

function setupTabs(): void {
  dom.tabs.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const next = target.dataset.mode;
    if (next === 'train' || next === 'practice' || next === 'game') applyMode(next);
  });
}

function applyMode(next: Mode): void {
  mode = next;
  capturingLabel = null;

  for (const tab of dom.tabs.querySelectorAll<HTMLElement>('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.mode === next);
  }
  dom.trainPanel.hidden = next !== 'train';
  dom.practicePanel.hidden = next !== 'practice';
  dom.gamePanel.hidden = next !== 'game';

  stage.setBadge(null);
  stage.setPointer(null);
  stage.setFacing(null);
  stage.setMood('normal');
  stage.setCaption(
    next === 'practice' ? 'あなたの指さしについてくる' : next === 'train' ? '学習中…' : '',
  );

  if (next === 'game') {
    game.reset();
  }
}

function refreshCounts(): void {
  trainPanel.update(classifier.counts());
  gamePanel.update(game.getState(), classifier.isReady(), classifier.missingClasses());
}

function scheduleSave(): void {
  if (!extractor) return;
  const activeExtractor = extractor;
  window.clearTimeout(saveTimer);
  dom.saveState.textContent = '保存待ち…';
  saveTimer = window.setTimeout(async () => {
    try {
      await saveDataset(
        classifier.exportDataset(),
        activeExtractor.name,
        activeExtractor.featureDim,
      );
      dom.saveState.textContent = `保存しました（${classifier.total()} 枚）`;
    } catch (error) {
      console.warn('保存に失敗しました', error);
      dom.saveState.textContent = '保存に失敗しました';
    }
  }, SAVE_DEBOUNCE_MS);
}

async function onClearAll(): Promise<void> {
  if (!window.confirm('学習したデータをすべて消します。よろしいですか？')) return;
  classifier.clearAll();
  refreshCounts();
  bars.update(null);
  window.clearTimeout(saveTimer);
  try {
    await clearDataset();
    dom.saveState.textContent = '学習データを消しました';
  } catch (error) {
    console.warn('保存データの削除に失敗しました', error);
  }
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dom.error.textContent = message;
  dom.error.hidden = false;
  dom.status.textContent = 'エラー';
  console.error(error);
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} が見つかりません`);
  return element as T;
}
