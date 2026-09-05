import './styles.css';
import { DataApplicationService, type DatasetSummary } from './app/dataApplicationService';
import { ModelService, type ModelServiceStatus } from './app/modelService';
import { createModelValidationService } from './app/modelValidationService';
import { createIndexedDbDatabase, type DatabasePort } from './data/database';
import { type JudgeSample } from './game/judge';
import {
  MatchGame,
  type FirstAttacker,
  type MatchGameState,
  type TargetScore,
} from './game/stateMachine';
import {
  DOMAIN_LABELS,
  FACE_LABELS,
  POINTER_LABELS,
  type AnyLabel,
  type Domain,
  type Direction,
} from './ml/labels';
import { createMobileNetExtractor, type FeatureExtractor } from './ml/featureExtractor';
import type { TrainingStatus } from './training/trainingSession';
import { isCameraReady, startCamera, type CameraHandle } from './ui/camera';
import type {
  ValidationService,
  ValidationTrialResult,
} from './validation/validationService';

type Screen = 'battle' | 'training' | 'validation' | 'settings';
type BootPhase =
  | 'initializing'
  | 'camera-loading'
  | 'camera-unavailable'
  | 'model-loading'
  | 'ready'
  | 'error';
type ToastKind = 'normal' | 'success' | 'warning';

interface ToastState {
  message: string;
  kind: ToastKind;
}

const app = requireElement<HTMLDivElement>('app');
const video = document.createElement('video');
video.id = 'cameraVideo';
video.className = 'camera-video';
video.playsInline = true;
video.muted = true;
video.autoplay = true;
video.setAttribute('aria-label', 'カメラ映像');

const importInput = document.createElement('input');
importInput.type = 'file';
importInput.accept = '.zip,application/zip';
importInput.hidden = true;
document.body.append(importInput);

let bootPhase: BootPhase = 'initializing';
let bootError = '';
let screen: Screen = 'battle';
let menuOpen = false;
let cameraHandle: CameraHandle | null = null;
let extractor: FeatureExtractor | null = null;
let database: DatabasePort | null = null;
let model: ModelService | null = null;
let modelStatus: ModelServiceStatus | null = null;
let dataApplication: DataApplicationService | null = null;
let validation: ValidationService<HTMLVideoElement | HTMLCanvasElement | HTMLImageElement> | null = null;
let game: MatchGame | null = null;
let gameState: MatchGameState | null = null;
let datasetSummary: DatasetSummary | null = null;
let trainingStatus: TrainingStatus = idleTrainingStatus();
let firstAttacker: FirstAttacker = 'player-first';
let targetScore: TargetScore = 3;
let trainingDomain: Domain = 'pointer';
let trainingLabel: AnyLabel = 'up';
let trainingCue = '';
let trainingResultMessage = '';
let guidedTraining = false;
let setupComplete = false;
let validationDomain: Domain = 'pointer';
let validationLabel: AnyLabel = 'up';
let validationBusy = false;
let validationResult: ValidationTrialResult | null = null;
let settingsBusy = false;
let toast: ToastState | null = null;
let toastTimer: number | undefined;
let trainingCueTimers: number[] = [];

app.addEventListener('click', (event) => void handleClick(event));
app.addEventListener('change', (event) => void handleChange(event));
importInput.addEventListener('change', () => void importSelectedDataset());
window.addEventListener('beforeunload', dispose);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  model?.cancelTraining();
  if (game?.isRunning()) game.cancel();
});

render();
void boot();

async function boot(): Promise<void> {
  try {
    bootPhase = 'camera-loading';
    render();
    cameraHandle = await startCamera(video);
    const stream = video.srcObject;
    if (stream instanceof MediaStream) {
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          if (bootPhase !== 'ready') return;
          bootError = 'カメラの映像が停止しました。';
          bootPhase = 'camera-unavailable';
          render();
        });
      }
    }

    bootPhase = 'model-loading';
    render();
    extractor = await createMobileNetExtractor();
    database = createIndexedDbDatabase();

    const nextModel = new ModelService({
      db: database,
      extractor,
      onStatusChanged(status) {
        modelStatus = status;
        render();
      },
      onTrainingStatusChanged(status) {
        trainingStatus = status;
        render();
      },
    });
    model = nextModel;
    await nextModel.initialize();
    modelStatus = nextModel.getStatus();

    dataApplication = new DataApplicationService(database, nextModel);
    validation = createModelValidationService(nextModel);
    game = new MatchGame(
      {
        collect: collectGameSamples,
        sleep,
        randomDirection: randomDirection,
      },
      (state) => {
        gameState = state;
        render();
      },
    );
    gameState = game.getState();
    trainingStatus = nextModel.getTrainingStatus();
    await refreshDatasetSummary();

    bootPhase = 'ready';
    render();
  } catch (error) {
    bootError = errorMessage(error);
    bootPhase = cameraHandle ? 'error' : 'camera-unavailable';
    render();
  }
}

async function handleClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLElement>('[data-action]');
  if (!button || button.hasAttribute('disabled')) return;

  const action = button.dataset.action;
  switch (action) {
    case 'reload':
      window.location.reload();
      return;
    case 'menu-toggle':
      menuOpen = !menuOpen;
      render();
      return;
    case 'menu-close':
      menuOpen = false;
      render();
      return;
    case 'navigate': {
      const next = button.dataset.screen;
      if (!isScreen(next)) return;
      await navigate(next);
      return;
    }
    case 'set-first': {
      const next = button.dataset.value;
      if (next === 'player-first' || next === 'cpu-first') {
        firstAttacker = next;
        render();
      }
      return;
    }
    case 'set-score': {
      const next = Number(button.dataset.value);
      if (next === 1 || next === 3) {
        targetScore = next;
        render();
      }
      return;
    }
    case 'start-match':
      startMatch();
      return;
    case 'rematch':
      game?.reset();
      startMatch();
      return;
    case 'end-match':
      game?.reset();
      render();
      return;
    case 'start-setup':
      guidedTraining = true;
      setupComplete = false;
      selectNextGuidedClass();
      screen = 'training';
      menuOpen = false;
      render();
      return;
    case 'select-domain': {
      const domain = button.dataset.domain;
      if (domain !== 'pointer' && domain !== 'face') return;
      guidedTraining = false;
      trainingDomain = domain;
      trainingLabel = DOMAIN_LABELS[domain][0];
      trainingResultMessage = '';
      render();
      return;
    }
    case 'select-label': {
      const domain = button.dataset.domain;
      const label = button.dataset.label;
      if ((domain !== 'pointer' && domain !== 'face') || !label) return;
      if (!DOMAIN_LABELS[domain].includes(label as never)) return;
      guidedTraining = false;
      trainingDomain = domain;
      trainingLabel = label as AnyLabel;
      trainingResultMessage = '';
      render();
      return;
    }
    case 'start-training':
      await startTraining();
      return;
    case 'cancel-training':
      model?.cancelTraining();
      return;
    case 'validation-domain': {
      const domain = button.dataset.domain;
      if (domain !== 'pointer' && domain !== 'face') return;
      validationDomain = domain;
      validationLabel = DOMAIN_LABELS[domain][0];
      validationResult = null;
      render();
      return;
    }
    case 'validation-label': {
      const label = button.dataset.label;
      if (!label || !DOMAIN_LABELS[validationDomain].includes(label as never)) return;
      validationLabel = label as AnyLabel;
      validationResult = null;
      render();
      return;
    }
    case 'run-validation':
      await runValidation();
      return;
    case 'export-data':
      await exportDataset();
      return;
    case 'import-data':
      importInput.value = '';
      importInput.click();
      return;
    case 'clear-local':
      await clearLocalDataset();
      return;
    case 'clear-imported':
      await clearImportedDataset();
      return;
    case 'reset-app':
      await resetApplication();
      return;
  }
}

async function handleChange(event: Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.dataset.action !== 'toggle-shared') return;
  await setSharedDataEnabled(target.checked);
}

async function navigate(next: Screen): Promise<void> {
  if (next !== 'battle' && game?.isRunning()) {
    const shouldLeave = window.confirm('対戦をやめて移動しますか？');
    if (!shouldLeave) return;
    game.cancel();
  }
  if (next !== 'training' && isTrainingActive(trainingStatus)) {
    const shouldLeave = window.confirm('いまの学習をやめて移動しますか？');
    if (!shouldLeave) return;
    model?.cancelTraining();
  }

  screen = next;
  menuOpen = false;
  setupComplete = false;
  if (next === 'settings') await refreshDatasetSummary();
  render();
}

function startMatch(): void {
  if (!model || !game || !canUseCamera()) return;
  if (!model.canPlay()) {
    showToast('まず うごきを おぼえさせよう', 'warning');
    return;
  }
  if (model.getStatus().state !== 'ready' || game.isRunning()) return;

  void game.startMatch({ firstAttacker, targetScore }).catch((error) => {
    showToast('対戦をつづけられませんでした', 'warning');
    console.error(error);
  });
}

async function startTraining(): Promise<void> {
  if (!model || !canUseCamera() || isTrainingActive(trainingStatus)) return;
  if (!DOMAIN_LABELS[trainingDomain].includes(trainingLabel as never)) return;

  trainingResultMessage = '';
  trainingCue = trainingInstruction(trainingDomain, trainingLabel);
  clearTrainingCueTimers();
  trainingCueTimers = [
    window.setTimeout(() => {
      trainingCue = 'すこし かくどを かえて！';
      render();
    }, 900),
    window.setTimeout(() => {
      trainingCue = 'もうすこし うごかして！';
      render();
    }, 1900),
  ];
  render();

  const result = await model.startTraining(trainingDomain, trainingLabel, () => video);
  clearTrainingCueTimers();
  trainingCue = '';

  if (result.kind === 'completed') {
    trainingResultMessage =
      result.acceptedCount > 0 ? 'おぼえたよ！' : 'このうごきは もう おぼえてるよ！';
    await refreshDatasetSummary();
    if (guidedTraining) {
      const previousDomain = trainingDomain;
      const previousLabel = trainingLabel;
      const next = nextMissingClass();
      if (!next) {
        setupComplete = true;
        trainingResultMessage = 'じゅんび できた！';
      } else if (next.domain !== previousDomain || next.label !== previousLabel) {
        trainingDomain = next.domain;
        trainingLabel = next.label;
        trainingResultMessage = 'いいね！ つぎの うごきへ';
      }
    }
  } else if (result.kind === 'cancelled') {
    trainingResultMessage = 'また あとで つづけよう';
  } else {
    trainingResultMessage = 'うまく おぼえられなかったよ。もういっかい！';
  }
  render();
}

async function runValidation(): Promise<void> {
  if (!validation || !model || !canUseCamera() || validationBusy) return;
  if (model.getStatus().state !== 'ready') return;

  validationBusy = true;
  validationResult = null;
  render();
  try {
    validationResult = await validation.runTrial(validationDomain, validationLabel, video);
  } catch (error) {
    showToast('検証を実行できませんでした', 'warning');
    console.error(error);
  } finally {
    validationBusy = false;
    render();
  }
}

async function setSharedDataEnabled(enabled: boolean): Promise<void> {
  if (!model || settingsBusy) return;
  settingsBusy = true;
  render();
  try {
    await model.setSharedDataEnabled(enabled);
    await refreshDatasetSummary();
    showToast(enabled ? '共有データを使います' : 'この端末のデータだけを使います', 'success');
  } catch (error) {
    showToast('共有データ設定を変更できませんでした', 'warning');
    console.error(error);
  } finally {
    settingsBusy = false;
    render();
  }
}

async function exportDataset(): Promise<void> {
  if (!model || settingsBusy) return;
  settingsBusy = true;
  render();
  try {
    const exported = await model.exportLocalDataset();
    const bytes = new Uint8Array(exported.bytes);
    const blob = new Blob([bytes.buffer], { type: exported.mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exported.fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast(`この端末のデータ ${exported.sampleCount}件を書き出しました`, 'success');
  } catch (error) {
    showToast('データを書き出せませんでした', 'warning');
    console.error(error);
  } finally {
    settingsBusy = false;
    render();
  }
}

async function importSelectedDataset(): Promise<void> {
  const file = importInput.files?.[0];
  if (!file || !model || settingsBusy) return;

  settingsBusy = true;
  render();
  try {
    const result = await model.importDataset(await file.arrayBuffer());
    if (result.kind === 'error') {
      showToast(importErrorMessage(result.code), 'warning');
      return;
    }
    await refreshDatasetSummary();
    showToast(`${result.importedSampleCount}件を読み込みました`, 'success');
  } catch (error) {
    showToast('データを読み込めませんでした', 'warning');
    console.error(error);
  } finally {
    settingsBusy = false;
    render();
  }
}

async function clearLocalDataset(): Promise<void> {
  if (!dataApplication || settingsBusy) return;
  if (!window.confirm('この端末でおぼえたデータを削除しますか？\n読み込んだデータは残ります。')) return;

  settingsBusy = true;
  render();
  try {
    await dataApplication.clearLocalDataset();
    await refreshDatasetSummary();
    showToast('この端末の学習データを削除しました', 'success');
  } catch (error) {
    showToast('データを削除できませんでした', 'warning');
    console.error(error);
  } finally {
    settingsBusy = false;
    render();
  }
}

async function clearImportedDataset(): Promise<void> {
  if (!dataApplication || settingsBusy) return;
  if (!window.confirm('読み込んだ共有データをすべて削除しますか？\nこの端末でおぼえたデータは残ります。')) return;

  settingsBusy = true;
  render();
  try {
    await dataApplication.clearImportedDataset();
    await refreshDatasetSummary();
    showToast('読み込んだデータを削除しました', 'success');
  } catch (error) {
    showToast('データを削除できませんでした', 'warning');
    console.error(error);
  } finally {
    settingsBusy = false;
    render();
  }
}

async function resetApplication(): Promise<void> {
  if (!dataApplication || settingsBusy) return;
  const firstConfirm = window.confirm(
    '完全初期化すると、学習・共有データ・検証記録・設定をすべて削除します。続けますか？',
  );
  if (!firstConfirm) return;
  if (!window.confirm('元に戻せません。本当に完全初期化しますか？')) return;

  settingsBusy = true;
  render();
  try {
    await dataApplication.resetApplication();
    window.location.reload();
  } catch (error) {
    settingsBusy = false;
    showToast('完全初期化できませんでした', 'warning');
    console.error(error);
    render();
  }
}

async function refreshDatasetSummary(): Promise<void> {
  if (!dataApplication) return;
  try {
    datasetSummary = await dataApplication.getDatasetSummary();
  } catch (error) {
    console.warn('Dataset summaryを取得できませんでした', error);
  }
}

async function collectGameSamples(domain: Domain, durationMs: number): Promise<JudgeSample[]> {
  const activeModel = model;
  if (!activeModel || !canUseCamera()) return [];

  const samples: JudgeSample[] = [];
  const deadline = performance.now() + durationMs;
  while (performance.now() < deadline) {
    const startedAt = performance.now();
    try {
      const prediction =
        domain === 'pointer'
          ? await activeModel.predictPointer(video)
          : await activeModel.predictFace(video);
      if (prediction) {
        samples.push({ label: prediction.label, confidences: prediction.confidences });
      }
    } catch (error) {
      console.warn('ゲーム推論を継続できませんでした', error);
      break;
    }
    const elapsed = performance.now() - startedAt;
    const remaining = Math.min(80 - elapsed, deadline - performance.now());
    if (remaining > 0) await sleep(remaining);
  }
  return samples;
}

function render(): void {
  if (bootPhase !== 'ready') {
    app.innerHTML = renderBootScreen();
    mountVideo();
    return;
  }

  const blocked = modelStatus?.state === 'rebuilding-classifiers' || settingsBusy;
  app.innerHTML = `
    <main class="app-shell ${blocked ? 'is-blocked' : ''}">
      ${renderCurrentScreen()}
      ${menuOpen ? renderMenu() : ''}
      ${modelStatus?.state === 'error' ? renderModelError() : ''}
      ${blocked ? renderBlockingLayer() : ''}
      ${toast ? renderToast(toast) : ''}
      <div class="orientation-guard" role="status">
        <div class="orientation-guard__icon">↻</div>
        <strong>たてに もどしてね</strong>
      </div>
    </main>
  `;
  mountVideo();
}

function renderCurrentScreen(): string {
  switch (screen) {
    case 'battle':
      return renderBattleScreen();
    case 'training':
      return renderTrainingScreen();
    case 'validation':
      return renderValidationScreen();
    case 'settings':
      return renderSettingsScreen();
  }
}

function renderBootScreen(): string {
  const hasCamera = bootPhase !== 'camera-unavailable';
  const title =
    bootPhase === 'camera-loading'
      ? 'カメラを じゅんび中'
      : bootPhase === 'model-loading'
        ? 'ゲームを じゅんび中'
        : bootPhase === 'camera-unavailable'
          ? 'カメラが つかえないよ'
          : bootPhase === 'error'
            ? 'じゅんび できなかったよ'
            : 'はじめる じゅんび中';
  const message =
    bootPhase === 'camera-unavailable'
      ? 'ブラウザのカメラ設定を確認して、もういちど開いてください。'
      : bootPhase === 'error'
        ? 'ページを開きなおすと直ることがあります。'
        : 'ちょっとだけ まってね';

  return `
    <main class="boot-screen">
      <div class="boot-mascot">${mascotMarkup('normal', null, null)}</div>
      <h1>${title}</h1>
      <p>${message}</p>
      ${
        bootPhase === 'camera-unavailable' || bootPhase === 'error'
          ? `<button class="primary-button" data-action="reload">もういちど</button>`
          : '<div class="loading-dots" aria-label="読み込み中"><span></span><span></span><span></span></div>'
      }
      ${
        bootError
          ? `<details class="error-details"><summary>くわしい情報</summary><p>${escapeHtml(bootError)}</p></details>`
          : ''
      }
      <div id="cameraSlot" class="boot-camera ${hasCamera ? '' : 'is-hidden'}"></div>
    </main>
  `;
}

function renderBattleScreen(): string {
  const state = gameState;
  const idle = !state || state.phase === 'idle';
  const matchOver = state?.phase === 'match-over';
  const target = state?.targetScore ?? targetScore;
  const score = state?.score ?? { player: 0, cpu: 0 };
  const canPlay = model?.canPlay() ?? false;
  const headline = battleHeadline(state);
  const subline = battleSubline(state);
  const phaseClass = state ? `phase-${state.phase}` : 'phase-idle';
  const cpuPose = cpuPoseForState(state);
  const mood = matchOver ? (state?.winner === 'player' ? 'surprised' : 'happy') : resultMood(state);

  return `
    <section class="battle-screen ${phaseClass}">
      <header class="battle-topbar">
        <div class="scoreboard" aria-label="スコア">
          ${scoreSide('YOU', score.player, target, 'player')}
          <div class="scoreboard__vs">VS</div>
          ${scoreSide('CPU', score.cpu, target, 'cpu')}
        </div>
        <button class="icon-button menu-button" data-action="menu-toggle" aria-label="メニューを開く">•••</button>
      </header>

      <div class="battle-stage">
        <div class="battle-copy ${state?.phase === 'judging' ? 'is-pop' : ''}">
          <h1>${headline}</h1>
          ${subline ? `<p>${subline}</p>` : ''}
        </div>
        <div class="mascot-stage ${state?.phase === 'judging' ? 'is-hoi' : ''}">
          ${mascotMarkup(mood, cpuPose.face, cpuPose.pointer)}
        </div>
        ${renderBattleResultDirections(state)}
      </div>

      <div class="battle-bottom">
        ${
          idle
            ? renderBattleSetup(canPlay)
            : matchOver
              ? renderMatchOver(state)
              : renderBattleCamera(state)
        }
      </div>
    </section>
  `;
}

function renderBattleSetup(canPlay: boolean): string {
  if (!canPlay) {
    return `
      <div class="setup-callout">
        <p class="setup-callout__eyebrow">はじめるまえに</p>
        <strong>まず うごきを おぼえさせよう</strong>
        <p>ゆびと かおの むきを おしえてね</p>
        <button class="primary-button primary-button--large" data-action="start-setup">おぼえさせる</button>
      </div>
    `;
  }

  return `
    <div class="match-options">
      <div class="option-row">
        <span class="option-label">さいしょは</span>
        <div class="segmented-control" role="group" aria-label="先攻・後攻">
          ${segmentButton('あなたから', 'set-first', 'player-first', firstAttacker === 'player-first')}
          ${segmentButton('CPUから', 'set-first', 'cpu-first', firstAttacker === 'cpu-first')}
        </div>
      </div>
      <div class="option-row">
        <span class="option-label">しょうぶ</span>
        <div class="segmented-control" role="group" aria-label="勝利条件">
          ${segmentButton('1てん', 'set-score', '1', targetScore === 1)}
          ${segmentButton('3てん', 'set-score', '3', targetScore === 3)}
        </div>
      </div>
      <button class="primary-button primary-button--large start-button" data-action="start-match">スタート！</button>
    </div>
  `;
}

function renderBattleCamera(state: MatchGameState): string {
  const hint =
    state.phase === 'player-attack'
      ? 'ゆびを さして！'
      : state.phase === 'cpu-attack'
        ? 'かおを むけて！'
        : state.phase === 'chant'
          ? state.attacker === 'player'
            ? 'ゆびの じゅんび'
            : 'かおの じゅんび'
          : state.phase === 'judging'
            ? 'そのまま！'
            : state.phase === 'retry'
              ? 'おなじ うごきで もういちど'
              : '';

  return `
    <div class="battle-camera-row">
      <div class="camera-frame camera-frame--battle ${state.phase === 'judging' ? 'is-active' : ''}">
        <div id="cameraSlot" class="camera-slot"></div>
        <span class="camera-label">YOU</span>
      </div>
      <div class="battle-action-hint">${hint}</div>
    </div>
  `;
}

function renderMatchOver(state: MatchGameState): string {
  return `
    <div class="match-over-actions">
      <strong>${state.winner === 'player' ? 'やったね！' : 'もう いっかい？'}</strong>
      <button class="primary-button primary-button--large" data-action="rematch">もういっかい</button>
      <button class="text-button" data-action="end-match">おわる</button>
    </div>
  `;
}

function renderTrainingScreen(): string {
  const active = isTrainingActive(trainingStatus);
  const readyCount = datasetSummary
    ? Object.values(datasetSummary[trainingDomain]).filter((item) => item.ready).length
    : 0;
  const setupTitle = guidedTraining ? 'じゅんびを しよう' : 'うごきを おぼえさせる';
  const instruction = trainingInstruction(trainingDomain, trainingLabel);
  const selectedReady = classIsReady(trainingDomain, trainingLabel);

  if (active) {
    return `
      <section class="sub-screen training-screen is-capturing">
        ${subHeader('おぼえ中', false)}
        <div class="capture-stage">
          <div class="capture-instruction">
            <span class="direction-glyph direction-glyph--large">${labelGlyph(trainingLabel)}</span>
            <h1>${trainingCue || instruction}</h1>
          </div>
          <div class="camera-frame camera-frame--training is-active">
            <div id="cameraSlot" class="camera-slot"></div>
          </div>
          <div class="capture-progress"><span></span></div>
          <button class="text-button text-button--light" data-action="cancel-training">やめる</button>
        </div>
      </section>
    `;
  }

  return `
    <section class="sub-screen training-screen">
      ${subHeader(setupTitle)}
      <div class="sub-scroll training-content">
        ${
          setupComplete
            ? `<div class="setup-complete">
                ${mascotMarkup('happy', null, null)}
                <h1>じゅんび できた！</h1>
                <p>これで たいせんできるよ</p>
                <button class="primary-button primary-button--large" data-action="navigate" data-screen="battle">たいせんへ</button>
              </div>`
            : `
              <div class="training-progress-row">
                <div>
                  <span>${domainChildName(trainingDomain)}</span>
                  <strong>${readyCount} / 5 おぼえた</strong>
                </div>
                ${guidedTraining ? '<span class="guided-badge">じゅんばんに やろう</span>' : ''}
              </div>

              <div class="domain-switch" role="group" aria-label="学習する種類">
                ${domainButton('pointer', 'ゆびのむき', trainingDomain === 'pointer')}
                ${domainButton('face', 'かおのむき', trainingDomain === 'face')}
              </div>

              <div class="direction-picker">
                ${DOMAIN_LABELS[trainingDomain]
                  .map((label) => trainingLabelButton(trainingDomain, label, label === trainingLabel))
                  .join('')}
              </div>

              <div class="training-camera-block">
                <div class="camera-frame camera-frame--training">
                  <div id="cameraSlot" class="camera-slot"></div>
                </div>
                <div class="training-prompt">
                  <span class="direction-glyph direction-glyph--large">${labelGlyph(trainingLabel)}</span>
                  <div>
                    <span>${selectedReady ? 'もっと おぼえさせる' : 'このうごきを おしえてね'}</span>
                    <strong>${instruction}</strong>
                  </div>
                </div>
              </div>

              ${trainingResultMessage ? `<p class="friendly-result">${trainingResultMessage}</p>` : ''}
              <button class="primary-button primary-button--large" data-action="start-training">3びょう おぼえる</button>
            `
        }
      </div>
    </section>
  `;
}

function renderValidationScreen(): string {
  const result = validationResult;
  return `
    <section class="sub-screen validation-screen">
      ${subHeader('検証')}
      <div class="sub-scroll adult-content">
        <div class="section-intro">
          <h1>認識テスト</h1>
          <p>正解の向きを指定して、現在の認識結果を1回確認します。</p>
        </div>

        <div class="adult-section">
          <span class="field-label">種類</span>
          <div class="segmented-control segmented-control--wide">
            ${validationDomainButton('pointer', 'ゆび', validationDomain === 'pointer')}
            ${validationDomainButton('face', 'かお', validationDomain === 'face')}
          </div>
        </div>

        <div class="adult-section">
          <span class="field-label">正解ラベル</span>
          <div class="validation-labels">
            ${DOMAIN_LABELS[validationDomain]
              .map((label) => validationLabelButton(label, label === validationLabel))
              .join('')}
          </div>
        </div>

        <div class="camera-frame camera-frame--validation">
          <div id="cameraSlot" class="camera-slot"></div>
        </div>
        <p class="validation-instruction">${trainingInstruction(validationDomain, validationLabel)}</p>
        <button class="primary-button" data-action="run-validation" ${validationBusy ? 'disabled' : ''}>
          ${validationBusy ? '判定中…' : 'この向きで判定する'}
        </button>

        ${result ? renderValidationResult(result) : ''}
      </div>
    </section>
  `;
}

function renderValidationResult(result: ValidationTrialResult): string {
  const matched = result.decided && result.predictedLabel === result.expectedLabel;
  return `
    <div class="validation-result ${matched ? 'is-match' : ''}">
      <div class="validation-result__headline">
        <strong>${result.decided ? (matched ? '一致しました' : '別の向きとして判定') : '判定できませんでした'}</strong>
      </div>
      <dl>
        <div><dt>正解</dt><dd>${adultLabelName(result.expectedLabel)}</dd></div>
        <div><dt>判定</dt><dd>${result.predictedLabel ? adultLabelName(result.predictedLabel) : '判定なし'}</dd></div>
        <div><dt>信頼度</dt><dd>${result.confidence === null ? '—' : `${Math.round(result.confidence * 100)}%`}</dd></div>
      </dl>
    </div>
  `;
}

function renderSettingsScreen(): string {
  const sharedEnabled = modelStatus?.sharedDataEnabled ?? false;
  const summary = datasetSummary;
  return `
    <section class="sub-screen settings-screen">
      ${subHeader('設定')}
      <div class="sub-scroll adult-content settings-content">
        <section class="settings-group">
          <div class="settings-row settings-row--toggle">
            <div>
              <strong>共有データを使う</strong>
              <p>読み込んだデータも認識に使います。</p>
            </div>
            <label class="switch">
              <input type="checkbox" data-action="toggle-shared" ${sharedEnabled ? 'checked' : ''} ${settingsBusy ? 'disabled' : ''} />
              <span></span>
            </label>
          </div>
        </section>

        <section class="settings-group">
          <div class="settings-heading">
            <div><strong>学習データ</strong><p>Local と Imported は別に管理されます。</p></div>
          </div>
          <div class="dataset-totals">
            <div><span>この端末</span><strong>${summary?.totals.local ?? '—'}</strong></div>
            <div><span>読み込み</span><strong>${summary?.totals.imported ?? '—'}</strong></div>
            <div><span>使用中</span><strong>${summary?.totals.active ?? '—'}</strong></div>
          </div>
          ${summary ? renderDatasetDetails(summary) : ''}
        </section>

        <section class="settings-group">
          <div class="settings-heading"><strong>データの出し入れ</strong></div>
          <button class="settings-action" data-action="export-data">
            <span><b>書き出す</b><small>この端末で学習したデータのみ</small></span><span>↗</span>
          </button>
          <button class="settings-action" data-action="import-data">
            <span><b>読み込む</b><small>Dataset ZIPを追加・更新</small></span><span>＋</span>
          </button>
        </section>

        <section class="settings-group settings-group--danger">
          <div class="settings-heading"><strong>データ削除</strong><p>削除する範囲を確認して実行してください。</p></div>
          <button class="settings-action" data-action="clear-local">
            <span><b>この端末の学習データを削除</b><small>読み込んだデータは残ります</small></span><span>›</span>
          </button>
          <button class="settings-action" data-action="clear-imported">
            <span><b>読み込んだデータを削除</b><small>この端末の学習データは残ります</small></span><span>›</span>
          </button>
          <button class="danger-button" data-action="reset-app">完全初期化</button>
        </section>
      </div>
    </section>
  `;
}

function renderDatasetDetails(summary: DatasetSummary): string {
  return `
    <details class="dataset-details">
      <summary>クラス別の件数を見る</summary>
      <div class="dataset-table-wrap">
        ${datasetDomainTable('ゆび', 'pointer', summary)}
        ${datasetDomainTable('かお', 'face', summary)}
      </div>
    </details>
  `;
}

function datasetDomainTable(domainName: string, domain: Domain, summary: DatasetSummary): string {
  const rows = DOMAIN_LABELS[domain]
    .map((label) => {
      const item = summary[domain][label as never] as {
        active: number;
        local: number;
        imported: number;
      };
      return `<tr><th>${adultLabelName(label)}</th><td>${item.local}</td><td>${item.imported}</td><td>${item.active}</td></tr>`;
    })
    .join('');
  return `
    <table class="dataset-table">
      <caption>${domainName}</caption>
      <thead><tr><th>向き</th><th>Local</th><th>Imported</th><th>Active</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMenu(): string {
  return `
    <div class="menu-scrim" data-action="menu-close">
      <nav class="app-menu" aria-label="メニュー">
        <div class="app-menu__handle"></div>
        <button data-action="navigate" data-screen="training"><span>↗</span><strong>学習</strong><small>うごきを おぼえさせる</small></button>
        <button data-action="navigate" data-screen="validation"><span>✓</span><strong>検証</strong><small>認識をテストする</small></button>
        <button data-action="navigate" data-screen="settings"><span>⚙</span><strong>設定</strong><small>データと共有</small></button>
      </nav>
    </div>
  `;
}

function renderModelError(): string {
  return `
    <div class="model-error-banner" role="alert">
      <span>ゲームの準備で問題が起きました</span>
      <button data-action="reload">開きなおす</button>
    </div>
  `;
}

function renderBlockingLayer(): string {
  const rebuilding = modelStatus?.state === 'rebuilding-classifiers';
  return `
    <div class="blocking-layer" role="status">
      <div class="blocking-pill">
        <span class="mini-spinner"></span>
        <strong>${rebuilding ? 'データを じゅんび中…' : '処理中…'}</strong>
      </div>
    </div>
  `;
}

function renderToast(state: ToastState): string {
  return `<div class="toast toast--${state.kind}" role="status">${escapeHtml(state.message)}</div>`;
}

function renderBattleResultDirections(state: MatchGameState | null): string {
  if (!state || state.phase !== 'result' || !state.result || state.result.outcome === 'undecided') return '';
  return `
    <div class="result-directions" aria-label="判定した方向">
      <span>YOU <b>${directionGlyph(state.result.playerDirection)}</b></span>
      <span>CPU <b>${directionGlyph(state.result.cpuDirection)}</b></span>
    </div>
  `;
}

function scoreSide(label: string, score: number, target: TargetScore, side: 'player' | 'cpu'): string {
  const dots = Array.from({ length: target }, (_, index) =>
    `<i class="score-dot ${index < score ? 'is-filled' : ''}"></i>`,
  ).join('');
  return `
    <div class="score-side score-side--${side}">
      <span>${label}</span>
      <div class="score-dots">${dots}</div>
    </div>
  `;
}

function subHeader(title: string, showBack = true): string {
  return `
    <header class="sub-header">
      ${showBack ? '<button class="icon-button back-button" data-action="navigate" data-screen="battle" aria-label="対戦へ戻る">‹</button>' : '<span class="sub-header__spacer"></span>'}
      <strong>${title}</strong>
      <span class="sub-header__spacer"></span>
    </header>
  `;
}

function segmentButton(label: string, action: string, value: string, selected: boolean): string {
  return `<button class="segment ${selected ? 'is-selected' : ''}" data-action="${action}" data-value="${value}" aria-pressed="${selected}">${label}</button>`;
}

function domainButton(domain: Domain, label: string, selected: boolean): string {
  return `<button class="domain-button ${selected ? 'is-selected' : ''}" data-action="select-domain" data-domain="${domain}" aria-pressed="${selected}">${label}</button>`;
}

function validationDomainButton(domain: Domain, label: string, selected: boolean): string {
  return `<button class="segment ${selected ? 'is-selected' : ''}" data-action="validation-domain" data-domain="${domain}" aria-pressed="${selected}">${label}</button>`;
}

function trainingLabelButton(domain: Domain, label: AnyLabel, selected: boolean): string {
  const ready = classIsReady(domain, label);
  return `
    <button class="direction-button ${selected ? 'is-selected' : ''} ${ready ? 'is-ready' : ''}" data-action="select-label" data-domain="${domain}" data-label="${label}" aria-pressed="${selected}">
      <span>${labelGlyph(label)}</span>
      <small>${childLabelName(label)}</small>
      ${ready ? '<i>✓</i>' : ''}
    </button>
  `;
}

function validationLabelButton(label: AnyLabel, selected: boolean): string {
  return `<button class="validation-label ${selected ? 'is-selected' : ''}" data-action="validation-label" data-label="${label}" aria-pressed="${selected}"><span>${labelGlyph(label)}</span>${adultLabelName(label)}</button>`;
}

function mascotMarkup(
  mood: 'normal' | 'happy' | 'surprised',
  face: Direction | null,
  pointer: Direction | null,
): string {
  const faceClass = face ? `face-${face}` : 'face-front';
  const pointerClass = pointer ? `pointer-${pointer}` : 'pointer-rest';
  return `
    <div class="mascot mascot--${mood} ${faceClass} ${pointerClass}" aria-label="CPUキャラクター">
      <div class="mascot__shadow"></div>
      <div class="mascot__ear mascot__ear--left"></div>
      <div class="mascot__ear mascot__ear--right"></div>
      <div class="mascot__body">
        <div class="mascot__face">
          <span class="mascot__eye mascot__eye--left"></span>
          <span class="mascot__eye mascot__eye--right"></span>
          <span class="mascot__mouth"></span>
        </div>
        <div class="mascot__belly"></div>
      </div>
      <div class="mascot__arm mascot__arm--left"></div>
      <div class="mascot__arm mascot__arm--right"><span class="mascot__hand"></span></div>
      <div class="mascot__foot mascot__foot--left"></div>
      <div class="mascot__foot mascot__foot--right"></div>
    </div>
  `;
}

function battleHeadline(state: MatchGameState | null): string {
  if (!state || state.phase === 'idle') return 'あっち向いて ホイ！';
  switch (state.phase) {
    case 'preparing':
      return 'じゅんび！';
    case 'player-attack':
      return 'ゆびを さして！';
    case 'cpu-attack':
      return 'かおを むけて！';
    case 'chant':
      return 'あっちむいて…';
    case 'judging':
      return 'ほい！';
    case 'retry':
      return 'もういっかい！';
    case 'result':
      if (state.result?.outcome === 'player-point') return 'やった！ 1てん';
      if (state.result?.outcome === 'cpu-point') return 'CPUの 1てん';
      return 'こうしゅ こうたい！';
    case 'match-over':
      return state.winner === 'player' ? 'かった！' : 'まけた！';
    case 'idle':
      return 'あっち向いて ホイ！';
  }
}

function battleSubline(state: MatchGameState | null): string {
  if (!state || state.phase === 'idle') return 'CPUと しょうぶしよう';
  if (state.phase === 'retry') return 'おなじ うごきで もういちど';
  if (state.phase === 'result' && state.result?.outcome === 'miss') return 'つぎは こうげきが かわるよ';
  if (state.phase === 'match-over') return state.winner === 'player' ? 'ナイス！' : 'つぎは かとう！';
  if (state.phase === 'preparing' && state.pointNumber > 1) return `${state.pointNumber}ポイントめ`;
  return '';
}

function resultMood(state: MatchGameState | null): 'normal' | 'happy' | 'surprised' {
  if (!state || state.phase !== 'result') return state?.phase === 'retry' ? 'surprised' : 'normal';
  if (state.result?.outcome === 'cpu-point') return 'happy';
  if (state.result?.outcome === 'player-point') return 'surprised';
  return 'normal';
}

function cpuPoseForState(state: MatchGameState | null): {
  face: Direction | null;
  pointer: Direction | null;
} {
  if (!state || state.phase !== 'result' || !state.cpuDirection) return { face: null, pointer: null };
  return state.attacker === 'player'
    ? { face: state.cpuDirection, pointer: null }
    : { face: null, pointer: state.cpuDirection };
}

function trainingInstruction(domain: Domain, label: AnyLabel): string {
  if (domain === 'pointer') {
    switch (label) {
      case 'up':
        return 'ゆびを うえに さして！';
      case 'right':
        return 'ゆびを みぎに さして！';
      case 'down':
        return 'ゆびを したに さして！';
      case 'left':
        return 'ゆびを ひだりに さして！';
      case 'neutral':
        return 'ゆびを ささずに まって！';
      case 'front':
        return 'ゆびを ささずに まって！';
    }
  }
  switch (label) {
    case 'up':
      return 'かおを うえに むけて！';
    case 'right':
      return 'かおを みぎに むけて！';
    case 'down':
      return 'かおを したに むけて！';
    case 'left':
      return 'かおを ひだりに むけて！';
    case 'front':
      return 'まえを むいて！';
    case 'neutral':
      return 'まえを むいて！';
  }
}

function classIsReady(domain: Domain, label: AnyLabel): boolean {
  if (!datasetSummary) return false;
  if (domain === 'pointer' && POINTER_LABELS.includes(label as (typeof POINTER_LABELS)[number])) {
    return datasetSummary.pointer[label as (typeof POINTER_LABELS)[number]].ready;
  }
  if (domain === 'face' && FACE_LABELS.includes(label as (typeof FACE_LABELS)[number])) {
    return datasetSummary.face[label as (typeof FACE_LABELS)[number]].ready;
  }
  return false;
}

function selectNextGuidedClass(): void {
  const next = nextMissingClass();
  if (!next) {
    setupComplete = true;
    return;
  }
  trainingDomain = next.domain;
  trainingLabel = next.label;
}

function nextMissingClass(): { domain: Domain; label: AnyLabel } | null {
  if (!model) return { domain: 'pointer', label: 'up' };
  const missing = model.getMissingTrainingClasses();
  const pointer = POINTER_LABELS.find((label) => missing.pointer.includes(label));
  if (pointer) return { domain: 'pointer', label: pointer };
  const face = FACE_LABELS.find((label) => missing.face.includes(label));
  if (face) return { domain: 'face', label: face };
  return null;
}

function mountVideo(): void {
  const slot = document.getElementById('cameraSlot');
  if (!slot) return;
  slot.append(video);
}

function canUseCamera(): boolean {
  return bootPhase === 'ready' && isCameraReady(video);
}

function isTrainingActive(status: TrainingStatus): boolean {
  return ['preparing', 'capturing', 'processing', 'saving'].includes(status.state);
}

function clearTrainingCueTimers(): void {
  for (const timer of trainingCueTimers) window.clearTimeout(timer);
  trainingCueTimers = [];
}

function showToast(message: string, kind: ToastKind = 'normal'): void {
  toast = { message, kind };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast = null;
    render();
  }, 2600);
  render();
}

function importErrorMessage(code: string): string {
  switch (code) {
    case 'invalid-format':
      return 'このファイルは読み込めません';
    case 'checksum-mismatch':
      return 'ファイルが壊れているようです';
    case 'dataset-version-mismatch':
      return '別バージョンのデータです';
    case 'extractor-incompatible':
      return 'このアプリでは使えないデータです';
    case 'limit-exceeded':
      return 'データが上限を超えるため登録できません';
    default:
      return 'データを読み込めませんでした';
  }
}

function labelGlyph(label: AnyLabel): string {
  switch (label) {
    case 'up':
      return '↑';
    case 'right':
      return '→';
    case 'down':
      return '↓';
    case 'left':
      return '←';
    case 'neutral':
      return '●';
    case 'front':
      return '◎';
  }
}

function directionGlyph(direction: Direction | null): string {
  return direction ? labelGlyph(direction) : '—';
}

function childLabelName(label: AnyLabel): string {
  switch (label) {
    case 'up':
      return 'うえ';
    case 'right':
      return 'みぎ';
    case 'down':
      return 'した';
    case 'left':
      return 'ひだり';
    case 'neutral':
      return 'やすみ';
    case 'front':
      return 'まえ';
  }
}

function adultLabelName(label: AnyLabel): string {
  switch (label) {
    case 'up':
      return '上';
    case 'right':
      return '右';
    case 'down':
      return '下';
    case 'left':
      return '左';
    case 'neutral':
      return '待機';
    case 'front':
      return '正面';
  }
}

function domainChildName(domain: Domain): string {
  return domain === 'pointer' ? 'ゆびのむき' : 'かおのむき';
}

function randomDirection(): Direction {
  const directions: Direction[] = ['up', 'right', 'down', 'left'];
  return directions[Math.floor(Math.random() * directions.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character,
  );
}

function isScreen(value: string | undefined): value is Screen {
  return value === 'battle' || value === 'training' || value === 'validation' || value === 'settings';
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} が見つかりません`);
  return element as T;
}

function idleTrainingStatus(): TrainingStatus {
  return {
    state: 'idle',
    domain: null,
    label: null,
    captureSessionId: null,
    candidateCount: 0,
    acceptedCount: 0,
    errorMessage: null,
  };
}

function dispose(): void {
  clearTrainingCueTimers();
  window.clearTimeout(toastTimer);
  game?.cancel();
  cameraHandle?.stop();
  model?.dispose();
  extractor = null;
  database = null;
}
