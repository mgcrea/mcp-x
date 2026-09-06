import { MAX_WEIGHTED_LENGTH, weightedLength } from "#/compose/weighted";

/**
 * X's web intent: a documented, credential-free URL that opens the composer
 * pre-filled. Nothing is posted until a human clicks Post, which is why it
 * needs no auth, consumes no API quota and costs nothing.
 *
 * The path is `/intent/tweet`, not `/intent/post`. X renamed Tweet to Post
 * throughout its docs prose but never changed the URL, and `/intent/post` is
 * undocumented with known edge-case bugs. `twitter.com` 301s to `x.com`, so
 * there is no reason to emit the legacy domain.
 */
export const INTENT_BASE_URL = "https://x.com/intent/tweet";

export type IntentInput = {
  text: string;
  /** Appended by the composer and counted against the 280. */
  url?: string | undefined;
  /** Without the leading '#'. */
  hashtags?: string[] | undefined;
  /** Handle without the leading '@'. */
  via?: string | undefined;
  /** The post id being replied to. */
  inReplyTo?: string | undefined;
  lang?: string | undefined;
};

const stripLeading = (value: string, char: string): string =>
  value.startsWith(char) ? value.slice(1) : value;

/**
 * What the composer will actually contain, in X's documented assembly order:
 * text, then url, then hashtags, then "via @handle".
 *
 * Validating `text` alone and then handing back a URL the composer rejects is
 * exactly the bug this module exists to prevent, so counting happens on this
 * string rather than on the input.
 */
export const assembleComposerText = (input: IntentInput): string => {
  const parts = [input.text.trim()];
  if (input.url) parts.push(input.url);
  for (const tag of input.hashtags ?? []) {
    const clean = stripLeading(tag.trim(), "#");
    if (clean) parts.push(`#${clean}`);
  }
  if (input.via) parts.push(`via @${stripLeading(input.via.trim(), "@")}`);
  return parts.filter(Boolean).join(" ");
};

export const buildIntentUrl = (input: IntentInput): string => {
  const params = new URLSearchParams();
  if (input.text) params.set("text", input.text);
  if (input.url) params.set("url", input.url);
  const hashtags = (input.hashtags ?? []).map((t) => stripLeading(t.trim(), "#")).filter(Boolean);
  // Documented as a comma-separated list *without* the '#' characters.
  if (hashtags.length > 0) params.set("hashtags", hashtags.join(","));
  if (input.via) params.set("via", stripLeading(input.via.trim(), "@"));
  if (input.inReplyTo) params.set("in_reply_to", input.inReplyTo);
  if (input.lang) params.set("lang", input.lang);
  return `${INTENT_BASE_URL}?${params.toString()}`;
};

export type IntentValidation = {
  valid: boolean;
  weighted: number;
  remaining: number;
  composed: string;
  intent_url: string;
  /** The links X will shorten to t.co, each counted as 23. Empty when there are none. */
  urls: string[];
  warnings: string[];
  error?: string;
};

export const validateIntent = (input: IntentInput): IntentValidation => {
  const composed = assembleComposerText(input);
  const { weighted, remaining, valid, urls } = weightedLength(composed);
  const warnings: string[] = [];

  if (urls.length > 0) {
    warnings.push(
      `${urls.length} URL${urls.length > 1 ? "s" : ""} counted as ${urls.length * 23} characters ` +
        `(X rewrites every link to a fixed-length t.co URL, whatever its real length).`,
    );
  }
  if ((input.hashtags?.length ?? 0) > 4) {
    warnings.push("More than four hashtags reads as spam and tends to suppress reach.");
  }
  if (input.via?.trim().startsWith("@")) {
    warnings.push("Stripped the leading '@' from `via` — X expects a bare handle.");
  }
  if (input.inReplyTo && !/^\d+$/.test(input.inReplyTo)) {
    warnings.push(
      `inReplyTo "${input.inReplyTo}" is not a post id. Ids are digits only — the trailing ` +
        "number in a post's URL.",
    );
  }

  return {
    valid,
    weighted,
    remaining,
    composed,
    intent_url: buildIntentUrl({ ...input, text: input.text.trim() }),
    urls: urls.map((u) => u.url),
    warnings,
    ...(valid
      ? {}
      : {
          error:
            weighted === 0
              ? "The post is empty."
              : `The assembled post is ${weighted} weighted characters, ${-remaining} over X's ` +
                `${MAX_WEIGHTED_LENGTH} limit. Note that the url, hashtags and via parts all count.`,
        }),
  };
};
