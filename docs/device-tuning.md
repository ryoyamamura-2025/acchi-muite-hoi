# Phase 8 — スマホ実機調整プロトコル

Phase 1〜7で実装したバックエンドを、実機計測に基づいて最終調整するための手順。

## 調整値

初期値は `src/config/tuning.ts` に集約している。

- Pointer similarity threshold: 0.98
- Face similarity threshold: 0.98
- Pointer KNN k: 5
- Face KNN k: 5
- Pointer confidence threshold: 0.6
- Face confidence threshold: 0.6
- Pointer min valid ratio: 0.5
- Face min valid ratio: 0.5
- training candidate interval: 300ms
- game judge window: 500ms

これらは設計上の初期値であり、実機結果を優先して変更する。

## 1. 学習サンプル選別

Pointer / Faceを別々に確認する。

各クラスを3〜5回学習し、次を確認する。

- 同じ姿勢を繰り返したときに重複サンプルが増え続けない
- 少し位置・距離・角度を変えたときは新しいサンプルが採用される
- 100件到達後もクラス上限を超えない
- 学習1回あたりの処理時間がスマホ操作として許容できる

まず0.98を使い、重複が多すぎる場合はthresholdを下げ、多様なサンプルまで落ちる場合は上げる。

## 2. KNN / 判定閾値

Validation機能で、Pointer / Faceそれぞれ各クラス10試行以上を取る。

比較候補例:

- k: 3 / 5 / 7
- confidence: 0.5 / 0.6 / 0.7
- min valid ratio: 0.4 / 0.5 / 0.6

見る指標:

- 正解率
- 誤判定率
- 判定不能率
- `neutral` / `front` が方向に誤判定される割合

誤判定を減らすことを、判定不能を減らすことより優先する。

## 3. Training timing

初期値:

- session: 3000ms
- stable lead-in: 600ms
- stable lead-out: 600ms
- candidate interval: 300ms

確認項目:

- 3秒が長すぎないか
- session開始直後/終了直前のブレが候補に混ざらないか
- 1 sessionで十分な候補数が得られるか
- 端末発熱やフレーム落ちが目立たないか

## 4. Game judge window

500msは固定値ではない。`MatchGame`は任意の正の`captureMs`を受け付ける。

比較候補例:

- 350ms
- 500ms
- 650ms

確認項目:

- 「ほい！」に対する体感遅延
- 十分な推論フレーム数が取れるか
- モーションブラーによる判定不能率
- 方向を変え終わった後のフレームが入りすぎないか

## 5. 最終確認

少なくとも以下をスマホ実機で通す。

1. LocalのみでPointer / Faceを学習
2. Shared OFFで対戦
3. Dataset export
4. 別installationでimport
5. Shared ONでImportedを含む対戦
6. Pointer / Face validation
7. 1点勝負 player-first / cpu-first
8. 3点勝負 player-first / cpu-first
9. undecided時に得点・攻守が変化しないこと
10. 学習cancel / カメラ停止 / 再読み込み後のデータ整合性

最終採用値を変更した場合は `src/config/tuning.ts` を更新し、`npm test` と `npm run build` を通してから確定する。
