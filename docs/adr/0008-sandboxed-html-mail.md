# ADR 0008: Parser-sanitized HTML mail in an isolated frame

## Status

Accepted

## Context

HTML email is untrusted active content. Inserting stored HTML into the webmail
DOM can execute event handlers, submit forms, load tracking pixels, apply CSS to
mislead the user, or exploit malformed markup that bypasses regular-expression
filters. Showing only source text avoids that risk but does not preserve the
archived application's useful HTML view.

## Decision

The authorized body endpoint offers `format=html` only when a stored HTML body
exists and is at most 2 MiB. A Workers `HTMLRewriter` parses the document and:

- removes executable, embedded, form, media, style, SVG, MathML, and template
  elements;
- removes every event, style, remote-fetch, form-action, and legacy fetching
  attribute;
- permits only HTTP(S), mailto, and fragment links, forcing external links to
  use `noopener noreferrer nofollow`;
- wraps the parsed fragment in a document with `default-src 'none'`, no
  referrer, no forms, no frames, and no network-capable content.

The browser never assigns this output to the application DOM. It assigns the
sanitized document to `srcdoc` on an iframe without `allow-scripts`,
`allow-same-origin`, `allow-forms`, or top-navigation privileges. Popups are
allowed only so an explicitly clicked safe link can escape the sandbox. Text
and HTML views can be switched when both bodies exist.

## Consequences

- Remote images, fonts, CSS, and tracking requests are intentionally blocked.
- Complex email layouts lose styling, but readable semantic HTML is retained.
- Oversized HTML falls back to a stored text body when available.
- Sanitizer regressions are tested with script tags, event handlers,
  entity-obfuscated JavaScript links, remote images, and remote CSS URLs.
