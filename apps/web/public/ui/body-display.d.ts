export type DisplayBody = {
  text: string;
  html: string | null;
};

export function shouldShowHtmlByDefault(
  body: DisplayBody,
  showHtmlByDefault: boolean,
): boolean;
