# あっち向いてホイ モバイル版 — バックエンド仕様・実装計画

## 1. 目的

既存の `acchi-muite-hoi` を、スマートフォンを主対象とした「あっち向いてホイ」アプリへ再構成する。

本書の対象は以下のみ。

- カメラ入力
- 特徴抽出
- 学習サンプル収集・選別
- KNN分類
- 学習データ保存
- 端末間データ共有
- 検証データ
- ゲーム進行・勝敗判定

UI/UX、画面デザイン、ナビゲーション、ビジュアル表現は対象外とする。

現時点ではクラウドバックエンドを持たず、学習・推論・保存はブラウザ内で完結させる。

---

## 2. 基本アーキテクチャ

```text
Camera
  ↓
FeatureExtractor
  ↓
Sample Collection / Inference
  ├── Pointer Dataset → Pointer KNN
  └── Face Dataset    → Face KNN
                         ↓
                    Game Judge
```

特徴抽出器はPointer / Faceで共有する。

```text
1 × MobileNet FeatureExtractor
       ├─ PointerClassifier
       └─ FaceClassifier
```

MobileNetを2つロードしない。

現行の `src/ml/featureExtractor.ts` にある `FeatureExtractor` 境界は維持・発展させる。

---

## 3. 特徴抽出

初期実装では現行方式を維持する。

- MobileNet v1 alpha=0.25
- `conv_pw_13_relu` まで使用
- 224 × 224入力
- 出力特徴量: 12,544次元
- Float32
- MobileNet自体の重み更新は行わない

つまり「学習」はMobileNetのfine-tuningではなく、抽出した特徴ベクトルをKNNの教師サンプルとして蓄積する方式。

将来的に特徴抽出器を変更できる設計は維持する。

以下の互換性が失われた場合は旧学習データを削除して再学習する。

- `extractorName`
- `featureDim`
- `datasetVersion`

旧Extractor用Datasetを複数世代保持する必要はない。

---

## 4. 分類器

分類器は2系統に完全分離する。

### PointerClassifier

ユーザーが攻撃するときに使用。

ラベル:

- `up`
- `right`
- `down`
- `left`
- `neutral`

`neutral` は指を差していない待機状態。

### FaceClassifier

ユーザーが守備するときに使用。

ラベル:

- `up`
- `right`
- `down`
- `left`
- `front`

`front` は正面を向いている状態。

### 初期パラメータ

Pointer / Faceは別々に設定値を持つ。

| Parameter | Pointer | Face |
| --- | ---: | ---: |
| KNN k | 5 | 5 |
| confidence threshold | 0.6 | 0.6 |
| min valid ratio | 0.5 | 0.5 |
| sample similarity threshold | 0.98 | 0.98 |

値はすべて初期値であり、実機検証によって変更可能にする。

---

## 5. 学習データ収集

従来の「ボタン押下中に100msごとに全サンプルを保存」は廃止する。

新方式では、短いガイド付きセッションから多様な代表サンプルだけを保存する。

### 1回の学習セッション

基本時間: 約3秒

撮影中にユーザーへ2回程度、姿勢を少し変えるガイドを提示する。

ガイド候補例:

- 少し手を高く
- 少し手を低く
- 少し左へ
- 少し右へ
- 少し近づける
- 少し離す

実際のガイド内容・表示方法はUI側で決める。

### サンプル候補生成

- 約300ms間隔で特徴抽出
- 撮影開始直後と終了直前は候補から除外
- 中央の安定区間のみ使用
- すべてのフレームを保存しない

---

## 6. サンプル重複排除

新規特徴ベクトルは、同じラベルの既存サンプルとのコサイン類似度を計算する。

```text
new sample
 ↓
same-class samplesと比較
 ↓
最大類似度 >= threshold
 ├─ Yes → 重複として破棄
 └─ No  → 採用候補
```

初期threshold:

```text
Pointer: 0.98
Face:    0.98
```

Pointer / Faceで別々に調整可能。

他クラスとの類似度は保存可否には使用しない。必要であれば検証情報として利用する。

---

## 7. Local Datasetの上限管理

各Classifier・各クラスは最大100サンプル。

Pointer:

```text
up       100
right    100
down     100
left     100
neutral  100
```

Face:

```text
up       100
right    100
down     100
left     100
front    100
```

最大500サンプル / Classifier。

### 上限到達後

新規サンプルが十分異なる良質なサンプルだった場合は、一旦101件として評価する。

101件の中から最も類似したサンプルペアを特定し、その2件のうち古い方を削除する。

目的は「最新100件」ではなく「多様性の高い代表100件」を維持すること。

---

## 8. 類似度キャッシュ

全サンプルペアを毎回再計算しない。

クラスごとにサンプル間のコサイン類似度をキャッシュする。

新規サンプル追加時には、新規サンプル × 既存最大100件だけ計算する。

類似度キャッシュはIndexedDBに保存してよい。

ただしキャッシュは派生データであり、破損・欠損した場合は元特徴量から再生成可能とする。

---

## 9. 学習セッションの保存

1回の3秒学習を1つの論理トランザクションとして扱う。

```text
撮影開始
 ↓
候補をメモリ上に保持
 ↓
撮影終了
 ↓
重複排除
 ↓
採用サンプル決定
 ↓
IndexedDBへまとめてcommit
```

途中で以下が発生した場合、そのセッションのデータは保存しない。

- カメラ停止
- アプリ離脱
- エラー
- セッションキャンセル

採用サンプルが0件でもエラーとはしない。「既存サンプルと十分類似していたため追加なし」と正常終了する。

---

## 10. サンプルメタデータ

各サンプルは最低限以下を保持する。

```text
id
domain                 pointer | face
label
feature
capturedAt
captureSessionId
sourceInstallationId
```

`installationId` は初回起動時にランダム生成する。

これは物理端末IDではなく、そのブラウザ × そのサイトのインストール相当ID。

Local Datasetを削除してもinstallationIdは維持する。完全初期化時のみinstallationIdも削除し、新規発行する。

---

## 11. Datasetの3層構造

### Local Dataset

現在のinstallation自身が収集したデータ。実データを保持する。

### Imported Dataset

他installationからインポートされたデータ。実データを保持し、元の `sourceInstallationId` を維持する。

### Active Dataset

現在KNNに投入する代表サンプル。

特徴ベクトルをコピー保存せず、採用されたsample ID一覧のみ保存する。

```text
ActiveIndex
  pointer:
    up: [...]
    right: [...]
    ...
  face:
    up: [...]
    ...
```

これによりActive Datasetによるストレージ容量の二重化を避ける。

---

## 12. 共有データON/OFF

アプリ全体で1つの設定を持つ。

### OFF

```text
Active候補 = Local Dataset
```

### ON

```text
Active候補 = Local Dataset + Imported Dataset
```

候補集合から、クラスごとに多様性の高い最大100サンプルを選ぶ。

サンプルの由来は選抜時の優先順位へ使用しない。自分由来・他人由来をKNN上では1サンプルとして対等に扱う。

共有ON/OFF変更時:

```text
Active再選抜
 ↓
Pointer KNN再構築
 ↓
Face KNN再構築
```

再構築中は推論・対戦を一時停止する。

---

## 13. 対戦解禁条件

Local Datasetの有無では判定しない。現在のActive Datasetを使用する。

Pointer全5クラス: 各10件以上

Face全5クラス: 各10件以上

を満たせば対戦可能。

したがってImported Datasetだけでも条件を満たせば対戦できる。

---

## 14. Imported Dataset上限

Imported Datasetは無制限に増やさない。

### sourceInstallation単位

1 sourceにつき、各domain / 各class 最大100件。

### Imported全体

各domain / 各class 最大500件。

上限を超えるインポートは自動削減しない。ファイル全体を拒否する。

部分登録は禁止。Importは原子的に行う。

```text
全検証成功
 → 全データcommit

1条件でも失敗
 → 何も変更しない
```

---

## 15. 同一端末データの再Import

同じ `sourceInstallationId` の新しいDatasetを読み込んだ場合、既存のそのsource由来Imported Datasetを丸ごと置換する。

ただし以下をすべて通過してから置換する。

1. 新Datasetを事前検証
2. 上限確認
3. チェックサム確認
4. 互換性確認

失敗した場合、既存Imported Datasetを残す。

---

## 16. Export / Import

現段階ではサーバー同期を実装しない。端末間共有はファイルベースとする。

### Export対象

Local Datasetのみ。

### Exportしないもの

- 生画像
- Imported Dataset
- Active Index
- similarity cache
- KNN内部状態
- validation log

### ファイル形式

ZIP:

```text
dataset.zip
├── manifest.json
├── pointer.bin
└── face.bin
```

`manifest.json` に以下を含める。

- datasetVersion
- extractorName
- featureDim
- installationId
- export日時
- サンプルメタデータ
- 各featureのbinary offset
- encoding情報
- pointer.bin SHA-256
- face.bin SHA-256

`.bin` にはFloat32特徴ベクトルを連続配置する。

エンディアンなど低レベル仕様は実装側で固定し、manifestに明示する。

SHA-256はファイル破損・不整合検知に使用する。送信元証明までは行わない。

---

## 17. IndexedDB構造

概念上、以下のstoreへ分離する。

```text
meta
localSamples
importedSamples
activeIndex
similarityCache
validationSessions
```

### meta

例:

```text
installationId
datasetVersion
extractorName
featureDim
sharedDataEnabled
settings
```

### localSamples

自端末由来のPointer / Faceサンプル。

### importedSamples

他端末由来サンプル。

### activeIndex

現在KNNへ投入するsample ID。

### similarityCache

再生成可能な類似度キャッシュ。

### validationSessions

検証結果。

現行 `src/ml/storage.ts` の単一KNN Dataset保存は全面再設計する。

---

## 18. 検証データ

毎フレームの推論ログは保存しない。

検証セッションでユーザーが正解ラベルを指定し、意図的に実施した試行のみ記録する。

最低限:

```text
validationSessionId
timestamp
sharedDataEnabled
domain
expectedLabel
predictedLabel
confidence
activeDatasetRevision
```

これによって将来的に以下の性能比較が可能。

- Localのみ
- 共有あり
- Pointer
- Face
- クラス別

confusion matrix等は保存データから後から算出可能とし、必須の永続データにはしない。

---

## 19. 対戦中の推論

1フレーム判定は使用しない。

「ほい！」後500msの複数推論結果から方向を決める。

### Pointer

ユーザーが攻撃時に使用。

### Face

ユーザーが守備時に使用。

### 初期判定条件

- 判定窓: 500ms
- 多数決
- 最多票同数ならconfidence合計で決定
- winning label平均confidence >= 0.6
- 有効方向フレーム率 >= 0.5
- 条件不足ならundecided

Pointer / Faceのthresholdは別設定。

判定不能の場合は、得点・攻守を変更せず、その手だけ再試行する。

---

## 20. ゲームルール

じゃんけんは完全削除する。

### 対戦開始設定

ユーザーが選択:

- 先攻 / 後攻
- 1点勝負 / 3点先取

### 1ポイントの流れ

```text
先攻が攻撃
 ↓
一致？
 ├─ Yes → 先攻側が1点
 └─ No  → 攻守交代
              ↓
          後攻が攻撃
              ↓
          一致？
           ...
```

どちらかが当てるまで攻守交代を続ける。

### 得点後

3点先取の場合、次のポイントでは開始時の先攻・後攻を入れ替える。

```text
Point 1: Player starts attack
Point 2: CPU starts attack
Point 3: Player starts attack
...
```

### CPU方向

ユーザーの推論結果を見てからCPU方向を決定してはいけない。

「あっち向いて…」開始時点でCPU方向をランダム決定し、その手が終了するまで固定する。

#### ユーザー攻撃

```text
User PointerClassifier
vs
CPU Face Direction(random fixed)
```

一致 → Player point

#### CPU攻撃

```text
CPU Pointer Direction(random fixed)
vs
User FaceClassifier
```

一致 → CPU point

---

## 21. 起動処理

概念的な順序:

```text
IndexedDB meta読み込み
 ↓
Dataset version / extractor compatibility確認
 ↓
Local / Imported / Active Index読み込み
 ↓
Camera準備
 ↓
MobileNetロード
 ↓
Active IndexからPointer KNN構築
 ↓
Active IndexからFace KNN構築
 ↓
Ready
```

準備完了までは対戦不可。

Pointer / Face KNNは両方RAMへ保持する。

Active Datasetはそれぞれ最大500件なので、Imported Datasetの人数が増えても推論対象件数は増加しない。

---

## 22. データ削除

### Local Dataset削除

Localサンプルのみ削除。installationId維持。

### Imported Dataset削除

Importedのみ削除。Local維持。

### 完全初期化

以下をすべて削除する。

- Local
- Imported
- Active
- cache
- validation
- settings
- installationId

次回起動時に新installationIdを生成。

---

## 23. エラー処理原則

以下は実装時に安全側で処理する。

- Camera permission denied
- Camera stream interruption
- MobileNet load failure
- IndexedDB failure
- Storage quota不足
- Import ZIP破損
- checksum mismatch
- datasetVersion mismatch
- extractor mismatch
- featureDim mismatch
- Import上限超過
- app background化
- 学習セッション途中終了

学習・Importなど複数データを更新する操作は、中途半端な状態を残さない。

---

## 24. 現行コードから残すもの

基本的に維持:

- Vite + TypeScript
- TensorFlow.js
- MobileNetモデル
- FeatureExtractorという抽象境界
- カメラ取得ロジックの有用部分
- 複数フレーム判定という考え方
- 純粋関数としてテストする思想

---

## 25. 大幅に作り直すもの

### `src/ml/classifier.ts`

現在は単一KNNを直接保持している。新構成ではPointer / Faceへ分離し、Dataset管理をClassifierから切り離す。

### `src/ml/storage.ts`

単一KNN Dataset保存から、Local / Imported / Active Index / cache / metadata / validationへ全面再設計。

### `src/ml/labels.ts`

Pointer / Faceそれぞれのlabel体系を定義する。

### `src/game/stateMachine.ts`

じゃんけん関連をすべて削除する。

- Hand
- randomHand
- judgeJanken
- janken phase
- janken reveal

「ポイント内で攻守交代」「ポイントごとに開始攻守交代」の新state machineへ変更する。

### `src/main.ts`

現状はUI、ML、ゲームstateを直接結合しているため、新実装ではアプリケーションサービス層を介し、UIからKNNやIndexedDBを直接触らせない。

---

## 26. 推奨モジュール構造

厳密なファイル名は実装時に調整可能だが、責務は以下程度に分離する。

```text
src/
  ml/
    featureExtractor.ts
    classifier.ts
    similarity.ts
    sampleSelector.ts
    types.ts

  data/
    database.ts
    datasetRepository.ts
    activeDataset.ts
    installation.ts

  sharing/
    exportDataset.ts
    importDataset.ts
    manifest.ts

  training/
    trainingSession.ts

  validation/
    validationService.ts

  game/
    judge.ts
    stateMachine.ts
    types.ts

  app/
    modelService.ts
```

重要なのはファイル数ではなく、以下の依存方向を作ること。

```text
UI → Application/Core API → Dataset / ML
```

---

## 27. 実装フェーズ

### Phase 1 — 型・Dataset基盤

実装:

- Pointer / Face label定義
- Sample型
- installationId
- 新IndexedDB schema
- Local / Imported repository
- Active Index

テスト:

- 保存・復元
- Local / Imported分離
- 完全初期化
- installationId維持

### Phase 2 — Sample Selector

実装:

- cosine similarity
- thresholdによる重複排除
- 最大100件
- 最類似ペア削除
- similarity cache

テスト:

- 類似サンプル拒否
- 異なるサンプル採用
- 100→101件時の正しい削除
- 古い方が削除されること
- Pointer / Face設定分離

### Phase 3 — Training Session

実装:

- 3秒セッション
- 中央安定区間
- 約300ms候補生成
- session buffer
- 一括commit
- cancel / error rollback

ガイド文言そのものはUI責務。

### Phase 4 — Pointer / Face KNN

実装:

- MobileNet共有
- Pointer KNN
- Face KNN
- Active Indexから再構築
- shared ON/OFF
- readiness判定

テスト:

- Active各10件条件
- Importedのみでもreadyになる
- OFFではImportedがActiveに入らない
- ONでActive再構築される

### Phase 5 — Import / Export

実装:

- ZIP生成
- manifest
- Float32 binary
- SHA-256
- atomic import
- 同source置換
- 上限拒否

テスト:

- 正常往復
- checksum failure
- extractor mismatch
- version mismatch
- duplicate import
- same source replacement
- limit exceededで全拒否
- Importedが再Exportされないこと

### Phase 6 — Game State Machine

実装:

- じゃんけん撤去
- 先攻/後攻
- 1 / 3 point
- 攻守交代
- pointごとの開始攻守交代
- CPU方向事前固定
- undecided retry

state machineはUI非依存の純粋ロジックとしてテストする。

### Phase 7 — Validation

実装:

- expected label指定試行
- predicted label
- confidence
- session保存
- shared ON/OFF状態記録

高度な分析UIは作らない。

### Phase 8 — 実機調整

コード完成後、スマホ実機で以下を測定する。

#### Sample selection

- Pointer similarity threshold 0.98
- Face similarity threshold 0.98

#### KNN

- k = 5
- confidence = 0.6
- valid ratio = 0.5

#### Timing

- training candidate interval ≈300ms
- game judge window = 500ms

ここは設計値を正解とみなさず、実測で調整する。

---

## 28. 将来拡張

今回の実装ではFederated Learning自体は行わない。

ただし以下を分離することで将来拡張可能にする。

```text
Local Dataset
Imported Dataset
Active Dataset
Classifier
```

将来の候補:

### Stage 1

他端末の特徴量を共有するKNN。

### Stage 2

MobileNet固定 + 小型NN分類ヘッド。

### Stage 3

各端末で分類ヘッドを学習し、重み更新のみを統合するFederated Learning。

今回の父端末 / 娘端末データ共有は、将来の連合学習に進む前の実験として、「他人由来の学習情報を加えることで、未知人物に対する認識性能が改善するか」を確認できる構成にする。

---

## 29. 今回やらないこと

- UI全面改修
- PWAデザイン
- クラウド同期
- ユーザーアカウント
- サーバーAPI
- 本格的Federated Learning
- MobileNet fine-tuning
- 特徴量圧縮
- Face landmark / Hand landmarkへの変更
- 生画像共有
- 電子署名による送信元認証

---

## 30. 実装完了条件

1. Pointer / Faceを独立学習できる
2. ガイド付き3秒撮影から代表サンプルだけ保存できる
3. 各クラス最大100件を維持できる
4. 再起動後も学習データが復元される
5. Local / Imported / Activeが分離される
6. shared ON/OFFでActiveを再構築できる
7. DatasetをExport / Importできる
8. 同source再Importで安全に置換できる
9. Import上限超過時に全拒否できる
10. Pointer / Face各10件以上で対戦可能になる
11. Importedだけでも対戦可能
12. 500ms複数フレームで勝敗判定できる
13. 判定不能時に同じ手を再試行できる
14. 先攻/後攻が機能する
15. 1点 / 3点先取を切り替えられる
16. ポイント内で攻守交代する
17. ポイント獲得後、次ポイントの開始攻守が入れ替わる
18. じゃんけん関連コードがゲーム進行から完全に除去される
19. Dataset・Import・ゲームstateの主要ロジックにユニットテストがある
20. `npm test` と `npm run build` が成功する
