import type { AnyLabel, Domain } from '../ml/labels';

export type ValidationSessionId = string;

/**
 * ユーザーが意図的に開始した1回の検証試行。
 * confusion matrix等はこの生レコードから後で算出する。
 */
export interface ValidationSessionRecord {
  validationSessionId: ValidationSessionId;
  /** Unix epoch milliseconds. */
  timestamp: number;
  sharedDataEnabled: boolean;
  domain: Domain;
  expectedLabel: AnyLabel;
  /** KNNが結果を返せなかった場合はnull。 */
  predictedLabel: AnyLabel | null;
  /** predictedLabel自身のconfidence。予測不能時はnull。 */
  confidence: number | null;
  activeDatasetRevision: number;
}
