import { queryD1 } from './backup-cloudflare.mjs';

export function auditLegacyConfiguration(manifest, options, runner) {
  const rows = queryD1(`
    SELECT p.source_kind,
      COUNT(*) AS provenance_rows,
      COUNT(DISTINCT COALESCE(p.mailbox_id, '') || ':' || p.target_key) AS target_rows,
      SUM(CASE p.source_kind
        WHEN 'label' THEN EXISTS (
          SELECT 1 FROM mailbox_labels AS l
          WHERE l.id = p.target_key AND l.mailbox_id = p.mailbox_id
        )
        WHEN 'message_label' THEN EXISTS (
          SELECT 1 FROM message_labels AS ml
          WHERE p.target_key = ml.message_id || ':' || ml.label_id
            AND ml.mailbox_id = p.mailbox_id
        )
        WHEN 'mail_rule' THEN EXISTS (
          SELECT 1 FROM mail_rules AS r
          WHERE r.id = p.target_key AND r.mailbox_id = p.mailbox_id
        )
        WHEN 'user_preference' THEN EXISTS (
          SELECT 1 FROM user_preferences AS up WHERE up.user_id = p.target_key
        ) ELSE 0 END
      ) AS existing_rows
    FROM migration_configuration_sources AS p
    WHERE p.batch_id = '${manifest.batchId}'
    GROUP BY p.source_kind ORDER BY p.source_kind
  `, options, runner);
  const actual = new Map(rows.map((row) => [String(row.source_kind), row]));
  const expected = [
    ['label', manifest.configuration.target.labelSources, manifest.configuration.target.labels],
    ['message_label', manifest.configuration.target.messageLabels,
      manifest.configuration.target.messageLabels],
    ['mail_rule', manifest.configuration.target.rules, manifest.configuration.target.rules],
    ['user_preference', manifest.configuration.target.preferences,
      manifest.configuration.target.preferences],
  ];
  for (const [kind, provenance, targets] of expected) {
    const row = actual.get(kind);
    if (
      Number(row?.provenance_rows ?? 0) !== provenance
      || Number(row?.target_rows ?? 0) !== targets
      || Number(row?.existing_rows ?? 0) !== provenance
    ) throw new Error(`target D1 configuration mismatch: ${kind}`);
    actual.delete(kind);
  }
  if (actual.size !== 0) throw new Error('target D1 contains unexpected configuration provenance');
  return {
    labels: manifest.configuration.target.labels,
    messageLabels: manifest.configuration.target.messageLabels,
    rules: manifest.configuration.target.rules,
    preferences: manifest.configuration.target.preferences,
  };
}
