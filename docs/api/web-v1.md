# Web API v1

All routes except `GET /healthz` require a valid Cloudflare Access application
JWT. A missing or invalid token is rejected before routing. JSON responses use
`Cache-Control: no-store` and have the shape `{ ok, data }` or `{ ok, error }`.

## Routes

| Method | Route | Required capability | Result |
| --- | --- | --- | --- |
| `GET` | `/api/session` | linked identity | User email, system-admin flag, and authorized mailboxes |
| `GET` | `/api/mailboxes/:id/messages` | read | Cursor-paginated message summaries |
| `POST` | `/api/mailboxes/:id/messages` | operate | Persist and enqueue a new outbound message |
| `GET` | `/api/messages/:id` | read | Message metadata and attachment links |
| `GET` | `/api/messages/:id/body` | read | R2 body stream as safe plain text |
| `GET` | `/api/messages/:id/raw` | read | Original RFC 822 download stream |
| `GET` | `/api/messages/:id/attachments/:ordinal` | read | Forced binary download stream |
| `PATCH` | `/api/messages/:id` | operate | Update read, starred, archived, or deleted flags |
| `GET` | `/api/mailboxes/:id/labels` | read | List mailbox labels and message counts |
| `POST` | `/api/mailboxes/:id/labels` | manage | Create a mailbox label |
| `PATCH, DELETE` | `/api/mailboxes/:id/labels/:labelId` | manage | Update or remove a mailbox label |
| `PUT` | `/api/messages/:id/labels` | operate | Replace manual label assignments |
| `GET, PATCH` | `/api/preferences` | linked identity | Read or update validated user preferences |
| `GET, POST` | `/api/mailboxes/:id/rules` | manage | List or create mailbox rules |
| `PATCH, DELETE` | `/api/mailboxes/:id/rules/:ruleId` | manage | Update or remove one rule |
| `POST` | `/api/mailboxes/:id/rules/:ruleId/preview` | manage | Freeze up to 200 existing matches |
| `GET` | `/api/mailboxes/:id/rule-runs` | manage | List recent preview/apply/incoming/undo runs |
| `GET` | `/api/mailboxes/:id/rule-runs/:runId` | manage | Read one run and its message sample |
| `POST` | `/api/mailboxes/:id/rule-runs/:runId/apply` | manage | Apply a frozen preview exactly once |
| `POST` | `/api/mailboxes/:id/rule-runs/:runId/undo` | manage | Optimistically undo an applied run |

The list route accepts
`folder=inbox|outbox|sent|starred|archive|trash|all`, a limit from 1
through 50, and the returned `before` plus `beforeId` cursor. `PATCH` accepts a
bounded `application/json` body containing one or more boolean fields:
`isRead`, `isStarred`, `isArchived`, and `isDeleted`. It also requires the
request `Origin` to match the application origin.

`POST` also requires a matching `Origin`, `Content-Type: application/json`, and
a UUID `Idempotency-Key`. Its body contains `to`, optional `cc` and `bcc`
address arrays, plus `subject` and a nonempty `text` body. `composeMode` is
`new`, `reply`, or `forward`; replies and forwards also require a
`sourceMessageId` in the selected mailbox. Reply headers are derived from that
stored source and cannot be supplied by the client. A combined maximum of 50
unique recipients and 512 KiB of UTF-8 text is accepted. The result is
`202` for a newly queued message and `200` for the existing record when the
same idempotency key is retried.

When files are present, `POST` instead accepts `multipart/form-data` containing
one JSON `payload` field with the fields above and repeated `attachments` file
fields. The entire request is bounded to 22 MiB before multipart parsing.
Uploads allow at most eight files, 10 MiB per file, and 20 MiB combined;
executable and script extensions or MIME types are rejected. Calls without
files continue to use the JSON representation.

The message list accepts an optional `label` UUID and returns the labels for
each message. Label names are unique only within one mailbox. Label mutations
require a matching `Origin`; deleting a label also removes its assignments.
`PUT /api/messages/:id/labels` accepts `{ "labelIds": [...] }` with at most 20
IDs, all from the message mailbox.

Preference patches accept only `theme`, `pageSize`, `defaultFolder`,
`showHtmlByDefault`, and `compactLayout`. Unknown or invalid fields reject the
entire request rather than being silently ignored.

Rule mutations require a matching `Origin` and mailbox-owner access. Supported
conditions are sender, recipient, subject, participant domain, bounded keyword
search, attachment presence, raw byte range, and direction. Supported actions
are star, archive, trash, and up to ten existing mailbox label IDs. Archive and
trash cannot be selected together. Existing-mail apply is available only when
the rule enables `applyExisting`, and fails with `409 stale_preview` if the rule
was edited after preview. Undo preserves any flag or label change made after
the original run instead of replacing current state unconditionally.

Unauthorized message IDs return the same not-found response as nonexistent
IDs. Responses never expose R2 storage keys.
