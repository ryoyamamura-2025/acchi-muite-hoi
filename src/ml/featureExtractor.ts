import * as tf from '@tensorflow/tfjs';

/** 特徴抽出はインターフェースにしておく（将来 MediaPipe の landmark に差し替えられるように）。 */
export interface FeatureExtractor {
  readonly name: string;
  readonly featureDim: number;
  /** `[1, featureDim]` のテンソルを返す。呼び出し側が dispose する責任を持つ。 */
  infer(source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement): tf.Tensor2D;
  dispose(): void;
}

/**
 * MobileNet v1 alpha=0.25 の重みは `public/models/` に同梱している。
 * tfhub.dev が廃止されたため `@tensorflow-models/mobilenet` の既定 URL は使えず、
 * ローカル同梱にすることでオフラインでも動く。
 */
const MODEL_URL = `${import.meta.env.BASE_URL}models/mobilenet_v1_0.25_224/model.json`;

/** ここで打ち切ると `[1, 7, 7, 256]`。flatten して 12544 次元の特徴量になる。 */
const TRUNCATION_LAYER = 'conv_pw_13_relu';

const INPUT_SIZE = 224;

export async function createMobileNetExtractor(): Promise<FeatureExtractor> {
  const full = await tf.loadLayersModel(MODEL_URL);
  const truncated = tf.model({
    inputs: full.inputs,
    outputs: full.getLayer(TRUNCATION_LAYER).output as tf.SymbolicTensor,
  });

  const outputShape = truncated.outputs[0].shape;
  const featureDim = outputShape.slice(1).reduce<number>((acc, d) => acc * (d ?? 1), 1);

  const run = (input: tf.Tensor4D): tf.Tensor2D =>
    tf.tidy(() => (truncated.predict(input) as tf.Tensor).reshape<tf.Tensor2D>([1, featureDim]));

  // シェーダのコンパイルを済ませておく（初回推論のカクつきを避ける）。
  tf.tidy(() => run(tf.zeros([1, INPUT_SIZE, INPUT_SIZE, 3])).dataSync());

  return {
    name: 'mobilenet_v1_0.25_224/conv_pw_13_relu',
    featureDim,
    infer(source) {
      return tf.tidy(() => run(preprocess(source)));
    },
    dispose() {
      truncated.dispose();
      full.dispose();
    },
  };
}

/**
 * 中央を正方形に切り出して 224x224 にリサイズし、[-1, 1] に正規化する。
 * 左右反転しているのは、プレビューの鏡表示と特徴量を一致させるため
 * （「右」というラベルが画面上の右と常に対応する）。
 */
function preprocess(source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement): tf.Tensor4D {
  return tf.tidy(() => {
    const pixels = tf.browser.fromPixels(source);
    const [height, width] = pixels.shape;
    const size = Math.min(height, width);
    const top = Math.floor((height - size) / 2);
    const left = Math.floor((width - size) / 2);

    const cropped = pixels.slice([top, left, 0], [size, size, 3]);
    const resized = tf.image.resizeBilinear(cropped, [INPUT_SIZE, INPUT_SIZE]);
    const mirrored = tf.reverse(resized, [1]);
    return mirrored.toFloat().div(127.5).sub(1).expandDims<tf.Tensor4D>(0);
  });
}
