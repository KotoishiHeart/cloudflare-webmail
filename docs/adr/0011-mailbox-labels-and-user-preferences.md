# ADR 0011: Mailbox-scoped labels and user-ID preferences

## Status

Accepted

## Context

The archived application used globally named labels and early settings notes
proposed using a Cloudflare Access email address as the preference key. Global
labels can leak organization between otherwise independent mailboxes, and an
email address is mutable identity data rather than a durable owner key.

## Decision

Labels belong to a mailbox. Both `messages` and `mailbox_labels` expose a
unique `(id, mailbox_id)` key, and `message_labels` references both composite
keys. D1 therefore rejects a label assignment that crosses a mailbox boundary
even if application authorization is bypassed.

Mailbox readers may list labels, operators may apply existing labels to
messages, and only owners with the `manage` capability may create, edit, or
delete the shared label vocabulary. Manual assignments and future rule-owned
assignments are distinguished by nullable `source_rule_id`; replacing manual
labels does not remove a rule-owned assignment.

Preferences are stored by the internal `users.id` resolved from the verified
Access issuer and subject. The supported settings are deliberately limited to
behaviors the rebuilt UI can apply: color theme, page size, default folder,
safe HTML default, and compact layout. Missing rows return stable defaults.

## Consequences

- The same label name may exist independently in different mailboxes.
- Deleting a mailbox or label cascades its assignments without touching other
  mailboxes.
- Label list filtering uses immutable label IDs rather than ambiguous names.
- Access email changes do not orphan user preferences.
- New preference fields require an explicit forward migration and validation;
  arbitrary JSON is not stored.
