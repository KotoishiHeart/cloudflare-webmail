# ADR 0012: Mailbox rules with frozen previews and optimistic undo

## Status

Accepted

## Context

The archived application supported sender, recipient, subject, domain,
keyword, attachment, size, and direction conditions. It could star, archive,
trash, or label matching mail. Existing-mail runs stored a preview, but the
apply path read the rule's current action JSON. Editing a rule after preview
could therefore apply actions that the operator had never reviewed. Its undo
also restored every recorded flag unconditionally, overwriting changes made
after the rule run.

## Decision

Rules belong to one mailbox and are managed only by mailbox owners. Conditions
and actions are validated typed objects; matching uses escaped portable
`LIKE` predicates and the existing bounded search document rather than a
provider-specific search extension. Rule-to-label references are normalized
in `mail_rule_labels`, so D1 prevents cross-mailbox references and prevents a
referenced label from being deleted accidentally.

Each rule has a monotonically increasing revision. Preview runs freeze the
revision, conditions, actions, and at most 200 matching message IDs. Existing
mail can be changed only by applying that stored preview. Apply rejects a
preview when the rule revision changed, and one preview can create at most one
apply run.

Every applied message stores before and after state. Undo restores a flag only
when its current value still equals the value written by the rule. A label is
removed only when the rule originally added it and it is still owned by that
rule. Later user changes therefore win.

Incoming rules run by priority after canonical D1 persistence. A unique
`(rule_id, target_message_id, mode)` receipt and per-message run matches make a
Queue retry resumable. Rule errors are logged and do not discard or quarantine
an otherwise valid email. `stopProcessing` ends evaluation after the first
matching rule that requests it.

## Consequences

- Existing-mail changes always have a reviewable, immutable target set.
- Preview runs are deliberately capped at 200 messages; larger reorganizations
  require repeated reviewed runs rather than one unbounded Worker request.
- Deleting a rule preserves its run history and existing rule labels. Deleting
  a label referenced by a live rule is rejected until the rule is changed.
- Incoming duplicates may evaluate rules again, but completed rule/message
  receipts prevent duplicate effects.
- Runtime Worker integration tests are required before production migration;
  local SQLite schema validation alone does not substitute for D1 verification.
