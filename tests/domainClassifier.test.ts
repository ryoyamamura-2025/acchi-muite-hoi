import * as tf from '@tensorflow/tfjs';
import { describe, expect, it } from 'vitest';
import { FaceClassifier, PointerClassifier } from '../src/ml/classifier';
import type { Sample } from '../src/ml/types';

function sample(
  domain: 'pointer' | 'face',
  label: string,
  id: string,
  feature: [number, number],
): Sample {
  return {
    domain,
    label,
    id,
    feature: new Float32Array(feature),
    capturedAt: 1,
    captureSessionId: 'session',
    sourceInstallationId: 'installation',
  } as Sample;
}

describe('Pointer / Face KNN classifiers', () => {
  it('PointerとFaceを別々のdatasetから再構築する', async () => {
    const pointer = new PointerClassifier(2, 1);
    const face = new FaceClassifier(2, 1);

    pointer.rebuild([
      sample('pointer', 'up', 'p-up', [1, 0]),
      sample('pointer', 'right', 'p-right', [0, 1]),
    ]);
    face.rebuild([
      sample('face', 'front', 'f-front', [1, 0]),
      sample('face', 'left', 'f-left', [0, 1]),
    ]);

    const feature = tf.tensor2d([1, 0], [1, 2]);
    try {
      expect((await pointer.predict(feature))?.label).toBe('up');
      expect((await face.predict(feature))?.label).toBe('front');
    } finally {
      feature.dispose();
      pointer.dispose();
      face.dispose();
    }
  });

  it('異なるdomainのsampleをrebuildへ渡すと拒否する', () => {
    const pointer = new PointerClassifier(2);
    try {
      expect(() => pointer.rebuild([sample('face', 'front', 'wrong', [1, 0])])).toThrow();
    } finally {
      pointer.dispose();
    }
  });
});
