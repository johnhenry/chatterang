/**
 * Whisper's tokenizer, decode side only.
 *
 * Only decode: the prompt this pipeline sends is a handful of control tokens
 * addressed by id (`<|startoftranscript|>`, a language, `<|transcribe|>`), so
 * nothing here ever has to run BPE merges over text. That is a real saving —
 * byte-level BPE encoding is the half of a tokenizer that is easy to get
 * subtly wrong — and it is stated rather than assumed, because a future
 * initial-prompt feature would need the other half and it is not here.
 *
 * The vocabulary is `tokenizer.json`, which is a companion asset rather than
 * something embedded: the id -> string table is model-specific (whisper-base's
 * has 51865 entries; large-v3's is larger and its language set differs), and a
 * table baked in here would be a second definition able to disagree with the
 * weights.
 */

/**
 * GPT-2's byte-to-unicode map.
 *
 * Byte-level BPE cannot have raw control bytes in its vocabulary strings, so
 * every byte is displayed as a printable code point: the 188 already-printable
 * bytes stand for themselves, and the other 68 are mapped to U+0100 and up.
 * Decoding is that map, inverted.
 */
function byteDecoder(): Map<number, number> {
  const printable: number[] = [];
  for (let b = 0x21; b <= 0x7e; b += 1) printable.push(b);
  for (let b = 0xa1; b <= 0xac; b += 1) printable.push(b);
  for (let b = 0xae; b <= 0xff; b += 1) printable.push(b);

  const map = new Map<number, number>();
  let next = 0;
  for (let b = 0; b < 256; b += 1) {
    if (printable.includes(b)) {
      map.set(b, b);
    } else {
      map.set(0x100 + next, b);
      next += 1;
    }
  }
  return map;
}

const BYTE_DECODER = byteDecoder();

/** The shape of `tokenizer.json` this file reads. Everything else is ignored. */
interface TokenizerJson {
  readonly added_tokens?: readonly { readonly id: number; readonly content: string }[];
  readonly model?: { readonly vocab?: Readonly<Record<string, number>> };
}

export interface WhisperSpecialTokens {
  readonly startOfTranscript: number;
  readonly endOfText: number;
  readonly transcribe: number;
  readonly translate: number;
  readonly noTimestamps: number;
  /** First timestamp token; `<|0.00|>`. Every id at or above it is one. */
  readonly timestampBegin: number;
  /** BCP-47-ish language code -> its `<|xx|>` token id. */
  readonly languages: ReadonlyMap<string, number>;
}

export class WhisperTokenizer {
  /** id -> the token's raw string, byte-level encoded for ordinary tokens. */
  readonly #tokens: (string | undefined)[];
  /** ids whose content is a `<|…|>` control marker. */
  readonly #special: Set<number>;
  readonly special: WhisperSpecialTokens;

  private constructor(
    tokens: (string | undefined)[],
    special: Set<number>,
    specials: WhisperSpecialTokens,
  ) {
    this.#tokens = tokens;
    this.#special = special;
    this.special = specials;
  }

  /** The largest id this vocabulary defines, plus one. */
  get size(): number {
    return this.#tokens.length;
  }

  /**
   * Build from the parsed contents of a `tokenizer.json`.
   *
   * @throws Error when the file is not a Whisper vocabulary — a missing
   *   `<|startoftranscript|>` means the companion is some other model's, and
   *   decoding against it would produce fluent text in the wrong vocabulary
   *   rather than an error.
   */
  static fromJson(raw: unknown): WhisperTokenizer {
    const json = raw as TokenizerJson;
    const vocab = json.model?.vocab;
    const added = json.added_tokens ?? [];
    if (vocab === undefined || Object.keys(vocab).length === 0) {
      throw new Error('The tokenizer companion has no `model.vocab`; it is not a tokenizer.json.');
    }

    const tokens: (string | undefined)[] = [];
    const special = new Set<number>();
    const place = (id: number, content: string): void => {
      while (tokens.length <= id) tokens.push(undefined);
      tokens[id] = content;
    };
    for (const [content, id] of Object.entries(vocab)) place(id, content);
    for (const token of added) {
      place(token.id, token.content);
      if (/^<\|.*\|>$/.test(token.content)) special.add(token.id);
    }

    const byContent = new Map<string, number>();
    for (const [id, content] of tokens.entries()) {
      if (content !== undefined && !byContent.has(content)) byContent.set(content, id);
    }

    const need = (content: string): number => {
      const id = byContent.get(content);
      if (id === undefined) {
        throw new Error(
          `The tokenizer companion has no "${content}" token, so it is not a Whisper ` +
            'vocabulary. Point `companions.tokenizer` at the tokenizer.json that ships with ' +
            'these weights.',
        );
      }
      return id;
    };

    const languages = new Map<string, number>();
    for (const [id, content] of tokens.entries()) {
      const match = /^<\|([a-z]{2,3})\|>$/.exec(content ?? '');
      if (match) languages.set(match[1]!, id);
    }

    const specials: WhisperSpecialTokens = {
      startOfTranscript: need('<|startoftranscript|>'),
      endOfText: need('<|endoftext|>'),
      transcribe: need('<|transcribe|>'),
      translate: need('<|translate|>'),
      noTimestamps: need('<|notimestamps|>'),
      timestampBegin: need('<|0.00|>'),
      languages,
    };

    return new WhisperTokenizer(tokens, special, specials);
  }

  isSpecial(id: number): boolean {
    return this.#special.has(id);
  }

  isTimestamp(id: number): boolean {
    return id >= this.special.timestampBegin;
  }

  /** Seconds a timestamp token names. Whisper's grid is 20 ms. */
  timestampSeconds(id: number): number {
    return (id - this.special.timestampBegin) * 0.02;
  }

  /**
   * Text for a run of ordinary tokens.
   *
   * Byte-level: each token's characters map back to bytes, the bytes are
   * concatenated across the whole run, and only then decoded as UTF-8. Decoding
   * token by token would split multi-byte characters — every non-ASCII language
   * would come out as replacement characters.
   */
  decode(ids: readonly number[], options: { skipSpecial?: boolean } = {}): string {
    const skipSpecial = options.skipSpecial ?? true;
    const bytes: number[] = [];
    let text = '';
    const flush = (): void => {
      if (bytes.length === 0) return;
      text += new TextDecoder('utf-8').decode(new Uint8Array(bytes));
      bytes.length = 0;
    };

    for (const id of ids) {
      const content = this.#tokens[id];
      if (content === undefined) continue;
      if (this.#special.has(id)) {
        if (skipSpecial) continue;
        flush();
        text += content;
        continue;
      }
      for (const character of content) {
        const byte = BYTE_DECODER.get(character.codePointAt(0) ?? 0);
        // A code point outside the byte-level alphabet is not decodable as a
        // byte. Dropping it silently would corrupt the run, so the character
        // is passed through as itself after flushing what came before.
        if (byte === undefined) {
          flush();
          text += character;
        } else {
          bytes.push(byte);
        }
      }
    }
    flush();
    return text;
  }
}
