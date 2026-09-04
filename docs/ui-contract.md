# あっち向いてホイ モバイル版 — UI / バックエンド契約

## 1. 目的

この文書は、UI設計とバックエンド実装の境界を定義する。

UI側は `docs/backend-spec.md` の内部実装詳細を理解しなくても、この契約だけを満たせば成立することを目標とする。

この文書は以下を定義する。

- UIから実行できる操作
- UIが受け取る状態
- UI側で必ず扱う必要がある概念
- UIから隠蔽する内部実装詳細

画面構成、ビジュアル、配色、アニメーション、ナビゲーション方式、コンポーネント構成はこの文書では規定しない。

---

## 2. UIが必ず扱う主要領域

UIは少なくとも以下の3領域を扱う。

- 対戦
- 学習
- 検証

これらを別画面・タブ・モーダル等のどの形で表現するかはUI側で自由に決めてよい。

---

## 3. UIが知る必要のある学習概念

学習には2種類ある。

### Pointer

攻撃時に使う指さし分類。

ラベル:

- 上
- 右
- 下
- 左
- 待機

### Face

守備時に使う顔向き分類。

ラベル:

- 上
- 右
- 下
- 左
- 正面

UIはPointer / Faceを区別して学習を開始できる必要がある。

KNN、MobileNet、特徴量、コサイン類似度などの内部概念をUIに露出する必要はない。

---

## 4. 学習セッション

1回の学習は約3秒の短いセッションとして扱う。

UIは以下を担当する。

- 対象domain（Pointer / Face）の選択
- 対象labelの選択
- 学習開始
- 撮影中のガイド表示
- 学習中状態の表示
- 完了 / キャンセル / エラーの通知

撮影中には2回程度、姿勢や位置を少し変えるよう促す。

ガイド内容・見せ方はUI側で決めてよい。

例:

- 少し手を高く
- 少し低く
- 少し近づいて
- 少し離れて

UIはフレーム数や保存サンプル選別アルゴリズムを意識しない。

---

## 5. UIが取得できる学習状態

UIは少なくとも以下を取得できる必要がある。

```text
Pointer:
  up
  right
  down
  left
  neutral

Face:
  up
  right
  down
  left
  front
```

各クラスについて最低限以下を取得する。

- Active Dataset上のサンプル件数
- Local Dataset上のサンプル件数
- 対戦解禁条件を満たしているか

Imported件数の詳細表示は必須ではないが、設定・検証画面で必要になった場合に取得可能な設計とする。

---

## 6. 対戦可否

UIはバックエンドから単一の `canPlay` 相当の状態を受け取れる必要がある。

対戦解禁条件はバックエンド側が判定する。

UI側で各件数を見て独自に判定してはいけない。

現在の条件は、Active DatasetについてPointer / Faceとも全5クラスが各10件以上。

Imported Datasetだけで条件を満たしている場合も対戦可能。

UIは必要に応じて、不足クラス一覧を取得して学習導線へ案内できる。

---

## 7. 対戦開始時にUIが指定する設定

対戦開始時にUIは以下を指定する。

### 先攻 / 後攻

- player-first
- cpu-first

### 勝利条件

- 1点勝負
- 3点先取

じゃんけんは存在しない。

---

## 8. ゲーム進行としてUIが受け取る状態

UIはゲームstate machineの内部実装を知らず、表示に必要な状態だけを受け取る。

最低限、以下の状態を表現できる必要がある。

- 対戦前
- 対戦準備中
- プレイヤー攻撃
- CPU攻撃
- 「あっち向いて…」
- 「ほい！」判定中
- 判定結果
- 判定不能 / 再試行
- 得点
- 試合終了

表示用データとして最低限以下を取得可能にする。

- 現在の攻撃側
- 現在の守備側
- プレイヤースコア
- CPUスコア
- 目標スコア
- CPUが出した方向（公開タイミングはゲームロジック側が制御）
- プレイヤー判定方向
- 判定結果
- 勝者
- 掛け声 / ゲームメッセージに相当する状態

UIが独自に勝敗判定してはいけない。

---

## 9. 判定不能

バックエンドが方向を確定できなかった場合、ゲームstateは判定不能として返る。

この場合:

- 得点は変わらない
- 攻守も変わらない
- 同じ手を再試行する

UIは「失敗」扱いでゲームを終了させず、再試行を表現できればよい。

---

## 10. 共有データ

アプリ全体で共有データON/OFFを1つ持つ。

UIは以下を実行できる必要がある。

- 現在の共有データ設定を取得
- ONへ変更
- OFFへ変更

切替後、バックエンドはActive DatasetとPointer / Face KNNを再構築する。

再構築中は推論・対戦不可。

UIは再構築中状態を表示できる必要がある。

UIがActive Datasetの選抜処理を行ってはいけない。

---

## 11. Import / Export

UIは以下の操作を提供できる必要がある。

### Export

現在端末のLocal Datasetを書き出す。

Imported DatasetはExportされない。

UIは内部ZIP構造、Float32、SHA-256などを意識しない。

### Import

ユーザーが選択したDatasetファイルをバックエンドへ渡す。

Import結果として最低限以下を区別できるようにする。

- 成功
- ファイル形式不正
- 破損 / checksum不一致
- Dataset version不一致
- Extractor互換性なし
- 上限超過
- その他のImportエラー

Import失敗時に既存データは変更されない。

同じsourceInstallation由来のDatasetを再Importした場合の置換処理はバックエンド責務。

---

## 12. データ削除

UIから以下の3操作を区別して呼べる必要がある。

### Local Dataset削除

自端末で学習したデータのみ削除。

### Imported Dataset削除

他端末から読み込んだデータのみ削除。

### 完全初期化

学習・共有・検証・設定・installationIdを含めてすべて初期化。

UIはIndexedDB storeを直接操作しない。

---

## 13. 検証

UIはPointer / Faceそれぞれについて検証試行を開始できる。

1試行につきUIは正解ラベルを指定する。

バックエンドから最低限以下を受け取る。

- expectedLabel
- predictedLabel
- confidence
- 判定成立 / 不成立

バックエンドは検証セッションを保存できる。

UI側でconfusion matrix等を表示するかどうかは自由。

毎フレームの推論ログ表示・保存は必須ではない。

---

## 14. アプリ全体の準備状態

UIはアプリ全体の状態を最低限以下に区別できる必要がある。

```text
initializing
camera-unavailable
model-loading
rebuilding-classifiers
ready
error
```

実際の型名は実装時に変更可能。

重要なのは、UIが「今操作可能か」を内部実装を知らず判断できること。

---

## 15. 学習処理状態

学習操作には最低限以下の状態がある。

```text
idle
preparing
capturing
processing
saving
completed
cancelled
error
```

UIは内部サンプル選別処理やIndexedDB transactionを直接制御しない。

---

## 16. UIから隠蔽する内部実装

以下は原則としてUIから直接触らせない。

- TensorFlow.js
- MobileNet
- KNN classifier object
- k値
- feature vector
- 12,544次元という内部仕様
- cosine similarity
- similarity cache
- sample replacement algorithm
- IndexedDB schema
- Active Indexのsample ID
- SHA-256計算
- Import binary layout
- dataset transaction
- CPU方向の乱数決定タイミングの内部処理

必要ならデバッグ用UIで表示してよいが、本番UIの設計要件にはしない。

---

## 17. UI向けApplication APIの考え方

具体的な関数名は実装時に決めるが、UIからは概念的に以下のような操作が可能であればよい。

```text
getAppState()
getTrainingStatus()
getDatasetSummary()
canPlay()
getMissingTrainingClasses()

startTraining(domain, label)
cancelTraining()

setSharedDataEnabled(enabled)

exportLocalDataset()
importDataset(file)
clearLocalDataset()
clearImportedDataset()
resetApplication()

startMatch({ firstAttacker, targetScore })
getGameState()

startValidation(domain, expectedLabel)
```

UIはこのApplication API相当の層を介し、ML / Dataset / IndexedDB / Game内部モジュールを直接呼ばない。

---

## 18. イベント / 状態通知

UIがポーリングだけに依存しなくても済むよう、状態変更を購読できる構造が望ましい。

概念例:

```text
onAppStateChanged
onTrainingStateChanged
onDatasetChanged
onGameStateChanged
onValidationResult
```

実装方式はEventTarget、callback、store等どれでもよい。

UIフレームワークに依存するAPIにはしない。

---

## 19. UI設計側で自由に決めてよいこと

この契約を満たす限り、以下はUI設計側で自由。

- 何画面に分けるか
- タブ / ボトムナビ / メニュー等のナビゲーション
- 対戦画面のレイアウト
- カメラ表示サイズ
- 学習フローの画面遷移
- Pointer / Face学習を一連のウィザードにするか別々にするか
- 学習件数の見せ方
- 共有データ設定をどこに置くか
- Import / Exportを通常導線に置くか設定画面に置くか
- キャラクター表現
- 色・フォント・イラスト
- アニメーション
- 音・振動
- ゲーム演出
- 判定不能時の表現

---

## 20. UI設計時に変更してはいけないバックエンド前提

UI都合だけで以下を変更しない。

- PointerとFaceが別分類であること
- 対戦にはPointer / Face双方の判定が必要であること
- じゃんけんが存在しないこと
- 先攻 / 後攻を選べること
- 1点 / 3点先取を選べること
- 1ポイント中は決着まで攻守交代すること
- 3点先取ではポイントごとに開始攻守が入れ替わること
- 判定不能では得点・攻守を変更しないこと
- Importedだけでも対戦解禁可能であること
- 共有ON/OFFがアプリ全体で1設定であること
- Local / Importedを別管理すること
- Export対象はLocalのみであること

これらを変更したい場合は `backend-spec.md` とこの契約を同時に更新する。

---

## 21. UI設計者が最初に読むべき内容

UIを新規設計するときは、原則としてこの `ui-contract.md` を入口にする。

内部仕様を確認する必要が生じた場合のみ `backend-spec.md` を参照する。

関係は以下。

```text
backend-spec.md
  └─ 内部ロジック・データ・ML・ゲーム仕様

ui-contract.md
  └─ UIとバックエンドの境界

UI design docs
  └─ 画面構成・体験・ビジュアル
```

UI設計ドキュメントはこの契約に依存してよいが、バックエンド内部実装へ直接依存しないことを推奨する。
