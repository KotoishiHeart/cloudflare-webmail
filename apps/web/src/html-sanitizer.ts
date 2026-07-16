const REMOVED_ELEMENTS = [
  'script', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'textarea', 'select', 'option', 'meta', 'link', 'base', 'style',
  'svg', 'math', 'video', 'audio', 'source', 'track', 'template',
] as const;

const FETCHING_ATTRIBUTES = new Set([
  'src', 'srcset', 'background', 'poster', 'ping', 'formaction',
  'xlink:href', 'action', 'data', 'codebase', 'archive', 'lowsrc',
  'dynsrc', 'usemap',
]);

const DISPLAY_CSP = [
  "default-src 'none'",
  "style-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export async function sanitizeEmailHtml(html: string): Promise<string> {
  let rewriter = new HTMLRewriter().on('*', {
    element(element) {
      const attributes = Array.from(element.attributes);
      for (const [name, value] of attributes) {
        if (name === undefined || value === undefined) continue;
        const normalized = name.toLowerCase();
        if (
          normalized === 'style'
          || normalized.startsWith('on')
          || FETCHING_ATTRIBUTES.has(normalized)
        ) {
          element.removeAttribute(name);
          continue;
        }
        if (normalized === 'href') sanitizeHref(element, value);
      }
    },
  });
  for (const tag of REMOVED_ELEMENTS) {
    rewriter = rewriter.on(tag, { element: (element) => { element.remove(); } });
  }
  for (const tag of ['html', 'head', 'body']) {
    rewriter = rewriter.on(tag, { element: (element) => { element.removeAndKeepContent(); } });
  }
  const fragment = await rewriter.transform(new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })).text();
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${DISPLAY_CSP}">`
    + `<meta name="referrer" content="no-referrer">`
    + `</head><body>${fragment}</body></html>`;
}

function sanitizeHref(element: Element, value: string): void {
  const normalized = decodeScheme(value)
    .replace(/[\u0000-\u0020\u007f]+/gu, '')
    .toLowerCase();
  if (
    !normalized.startsWith('https:')
    && !normalized.startsWith('http:')
    && !normalized.startsWith('mailto:')
    && !normalized.startsWith('#')
  ) {
    element.removeAttribute('href');
    element.removeAttribute('target');
    element.removeAttribute('rel');
    return;
  }
  element.setAttribute('href', value.trim());
  element.setAttribute('target', '_blank');
  element.setAttribute('rel', 'noopener noreferrer nofollow');
}

function decodeScheme(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/giu, (_match, hex: string) => decodePoint(hex, 16))
    .replace(/&#([0-9]+);?/gu, (_match, decimal: string) => decodePoint(decimal, 10))
    .replace(/&colon;/giu, ':')
    .replace(/&(?:tab|newline);/giu, '');
}

function decodePoint(value: string, radix: number): string {
  const point = Number.parseInt(value, radix);
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
    ? String.fromCodePoint(point)
    : '';
}
