export function shouldShowHtmlByDefault(body, showHtmlByDefault) {
  return body.html !== null && (showHtmlByDefault || body.text === '');
}
