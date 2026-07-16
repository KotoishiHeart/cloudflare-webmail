import PostalMime, { type Email } from 'postal-mime';
import { errorType } from './inbound-errors.js';
import { hex } from './hashing.js';

const MAX_MIME_NESTING_DEPTH = 64;
const MAX_MIME_HEADERS_BYTES = 512 * 1024;

export type ParsedStagedEmail = {
  email: Email | null;
  rawSha256: string;
  parseErrorType: string | null;
};

export async function parseAndHashRawEmail(
  raw: ReadableStream<Uint8Array>,
): Promise<ParsedStagedEmail> {
  const [parseInput, digestInput] = raw.tee();
  if (!supportsDigestStream(crypto)) {
    throw new Error('The Workers runtime does not expose crypto.DigestStream');
  }
  const digestStream = new crypto.DigestStream('SHA-256');
  const parsePromise = PostalMime.parse(parseInput, {
    attachmentEncoding: 'arraybuffer',
    maxNestingDepth: MAX_MIME_NESTING_DEPTH,
    maxHeadersSize: MAX_MIME_HEADERS_BYTES,
  });
  const digestWrite = digestInput.pipeTo(digestStream);

  const [parseResult, writeResult, digestResult] = await Promise.allSettled([
    parsePromise,
    digestWrite,
    digestStream.digest,
  ]);
  if (writeResult.status === 'rejected') throw writeResult.reason;
  if (digestResult.status === 'rejected') throw digestResult.reason;

  return {
    email: parseResult.status === 'fulfilled' ? parseResult.value : null,
    rawSha256: hex(digestResult.value),
    parseErrorType: parseResult.status === 'rejected' ? errorType(parseResult.reason) : null,
  };
}

type CryptoWithDigestStream = Crypto & {
  DigestStream: new (algorithm: string | SubtleCryptoHashAlgorithm) => DigestStream;
};

function supportsDigestStream(value: Crypto): value is CryptoWithDigestStream {
  return 'DigestStream' in value;
}
