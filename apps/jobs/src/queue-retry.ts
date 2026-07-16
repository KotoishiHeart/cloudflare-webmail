const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;
const UTC_DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const RESET_SETTLE_SECONDS = 60;

export function queueRetryDelay(error: unknown, attempts: number, now: number): number {
  if (isD1DailyLimitError(error)) return d1ResetDelay(now);
  const exponent = Math.max(0, Math.min(7, Math.floor(attempts) - 1));
  return Math.min(30 * (2 ** exponent), 3600);
}

export function isD1DailyLimitError(error: unknown): boolean {
  const message = errorMessages(error).join(' ');
  const d1Context = /\bD1\b|rows?\s+(?:read|written|write)|database quer(?:y|ies)/iu.test(message);
  if (!d1Context) return false;
  return /(?:daily|per[ -]day).{0,100}(?:limit|quota)/iu.test(message)
    || /(?:limit|quota).{0,100}(?:daily|per[ -]day)/iu.test(message)
    || /free (?:plan|tier).{0,120}(?:limit|quota).{0,120}rows?\s+(?:read|written|write)/iu
      .test(message);
}

function d1ResetDelay(now: number): number {
  const timestamp = Number.isFinite(now) && now >= 0 ? now : Date.now();
  const nextUtcDay = (Math.floor(timestamp / UTC_DAY_MILLISECONDS) + 1)
    * UTC_DAY_MILLISECONDS;
  const seconds = Math.ceil((nextUtcDay - timestamp) / 1000) + RESET_SETTLE_SECONDS;
  return Math.max(RESET_SETTLE_SECONDS, Math.min(MAX_QUEUE_DELAY_SECONDS, seconds));
}

function errorMessages(value: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = value;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
      continue;
    }
    if (typeof current !== 'object') {
      messages.push(String(current));
      break;
    }
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string') messages.push(candidate.message);
    current = candidate.cause;
  }
  return messages;
}
