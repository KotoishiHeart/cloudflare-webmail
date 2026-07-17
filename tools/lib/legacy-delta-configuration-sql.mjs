import {
  renderLegacyDeltaLabelSql,
  renderLegacyDeltaRuleSql,
} from './legacy-delta-label-rule-sql.mjs';
import {
  renderLegacyDeltaMessageLabelSql,
  renderLegacyDeltaPreferenceSql,
} from './legacy-delta-preference-label-sql.mjs';

export function renderLegacyConfigurationDelta(operations, delta) {
  return [
    ...operations.labelUpserts.map((operation) => (
      renderLegacyDeltaLabelSql(operation, delta)
    )),
    ...operations.ruleMutations.map((operation) => (
      renderLegacyDeltaRuleSql(operation, delta)
    )),
    ...operations.preferenceMutations.map((operation) => (
      renderLegacyDeltaPreferenceSql(operation, delta)
    )),
    ...operations.messageLabelMutations.map((operation) => (
      renderLegacyDeltaMessageLabelSql(operation, delta)
    )),
    ...operations.labelDeletes.map((operation) => (
      renderLegacyDeltaLabelSql(operation, delta)
    )),
  ];
}
