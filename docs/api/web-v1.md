# Web API v1

All routes except `GET /healthz` require a valid Cloudflare Access application
JWT. A missing or invalid token is rejected before routing. JSON responses use
`Cache-Control: no-store` and have the shape `{ ok, data }` or `{ ok, error }`.

## Routes

| Method | Route | Required capability | Result |
| --- | --- | --- | --- |
| `GET` | `/api/session` | linked identity | User display email and authorized mailboxes |
| `GET` | `/api/mailboxes/:id/messages` | read | Cursor-paginated message summaries |
| `GET` | `/api/messages/:id` | read | Message metadata and attachment links |
| `GET` | `/api/messages/:id/body` | read | R2 body stream as safe plain text |
| `GET` | `/api/messages/:id/raw` | read | Original RFC 822 download stream |
| `GET` | `/api/messages/:id/attachments/:ordinal` | read | Forced binary download stream |
| `PATCH` | `/api/messages/:id` | operate | Update read, starred, archived, or deleted flags |

The list route accepts `folder=inbox|starred|archive|trash|all`, a limit from 1
through 50, and the returned `before` plus `beforeId` cursor. `PATCH` accepts a
bounded `application/json` body containing one or more boolean fields:
`isRead`, `isStarred`, `isArchived`, and `isDeleted`. It also requires the
request `Origin` to match the application origin.

Unauthorized message IDs return the same not-found response as nonexistent
IDs. Responses never expose R2 storage keys.
