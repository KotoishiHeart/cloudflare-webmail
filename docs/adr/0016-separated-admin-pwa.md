# ADR 0016: Separate administration console and static-only PWA cache

Status: accepted

## Decision

Cross-mailbox administration is a separate browser entrypoint at
`/admin.html`, not another mode inside the mail-reading application. The mail
shell reveals its link only when `/api/session` reports an explicit system
administrator grant, while every administration API independently repeats the
authorization check. Users, mailbox routing, event diagnostics, and retention
are implemented as separate UI modules with no message-body access.

Both shells register one service worker. Its cache allowlist contains only
versioned application HTML, JavaScript, CSS, the manifest, and icons. Requests
under `/api/`, `/healthz`, raw messages, bodies, and attachments are always
network-only and retain their `no-store` response policy. Navigations use the
network first and may fall back to a content-free shell; no mailbox data is
available offline.

The primary landmarks have skip links, asynchronous status changes switch to
assertive alerts for errors, form controls share visible focus treatment, tabs
expose their selection state, and reduced-motion preferences disable UI
transitions.

## Consequences

The administration bundle does not increase the normal mail orchestration
module or expose global data to ordinary users. A cached shell can be visible
offline on a previously authenticated browser profile, but it contains no user
or mail records and all protected data operations fail without a live Access
session.

Static filenames are not content-hashed, so releases that change cached assets
must increment the service-worker cache name. The deployment checklist verifies
that every precache entry exists and that no API path is present.
