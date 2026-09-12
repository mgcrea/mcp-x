import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

import { PreconditionError } from "#/client/errors";
import { expandTilde } from "#/config";

// The article tools read two kinds of local file on the caller's say-so: a
// Markdown document, and the images it references. Both then leave the machine
// for X. So each read is fenced to the one shape it is for — a Markdown file
// by extension, an image by its actual leading bytes — and a model that is
// talked into passing `~/.ssh/id_ed25519` gets a refusal naming what it found,
// not an upload.

/** X's ceiling for a `tweet_image` upload. Checked before reading, so a huge file is never buffered. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Far past any Article; this bounds the read, not the writing. */
export const MAX_MARKDOWN_BYTES = 1024 * 1024;

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];

export type ImageFormat = "png" | "jpeg" | "webp";

export type LocalImage = { path: string; bytes: Buffer; format: ImageFormat };

/**
 * Identify an image by its signature, never by its name. GIFs are recognised
 * only to be refused by name: Article images accept `tweet_image` alone, and X
 * rejects an animated one after the upload has already been paid for.
 */
export const sniffImage = (bytes: Uint8Array): ImageFormat | "gif" | undefined => {
  const at = (offset: number, ...expected: number[]): boolean =>
    expected.every((byte, i) => bytes[offset + i] === byte);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  return undefined;
};

const decode = (src: string): string => {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
};

/**
 * Where a path written in Markdown actually lives. Relative paths resolve
 * against the Markdown file's directory, exactly as a site generator reads
 * them — `../../assets/cover.jpg` in a blog post means relative to the post.
 */
export const resolveLocalPath = (src: string, baseDir?: string): string => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
    throw new PreconditionError(
      `${src} is a remote URL. Images are not downloaded on your behalf — save it locally and ` +
        "reference the file instead.",
      { src },
    );
  }
  const path = expandTilde(decode(src));
  if (isAbsolute(path)) return path;
  if (!baseDir) {
    throw new PreconditionError(
      `${src} is a relative path, which needs markdownPath to resolve against. Pass the ` +
        "Markdown as a file, or use an absolute path.",
      { src },
    );
  }
  return resolve(baseDir, path);
};

const sizeOf = (path: string): number => {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw new PreconditionError(`${path} is not a file.`, { path });
    return stats.size;
  } catch (err) {
    if (err instanceof PreconditionError) throw err;
    throw new PreconditionError(`Cannot read ${path}: ${(err as Error).message}`, { path });
  }
};

/** Read an image for upload, refusing anything that is not a PNG, JPEG or WebP under 5 MB. */
export const readLocalImage = (path: string): LocalImage => {
  const size = sizeOf(path);
  if (size > MAX_IMAGE_BYTES) {
    throw new PreconditionError(
      `${path} is ${(size / 1024 / 1024).toFixed(1)} MB; X accepts Article images up to 5 MB.`,
      { path, bytes: size },
    );
  }
  const bytes = readFileSync(path);
  const format = sniffImage(bytes);
  if (format === "gif") {
    throw new PreconditionError(
      `${path} is a GIF. X Articles accept PNG, JPEG and WebP images only.`,
      { path },
    );
  }
  if (!format) {
    throw new PreconditionError(
      `${path} is not a PNG, JPEG or WebP image (checked by content, not by name), so it was ` +
        "not uploaded.",
      { path },
    );
  }
  return { path, bytes, format };
};

/** Read a Markdown document. Absolute paths only: under a supervisor the working directory is anyone's guess. */
export const readMarkdownFile = (src: string): { path: string; text: string } => {
  const path = expandTilde(src);
  if (!isAbsolute(path)) {
    throw new PreconditionError(
      `markdownPath must be absolute, got ${JSON.stringify(src)}. This server's working ` +
        "directory is not yours.",
      { markdownPath: src },
    );
  }
  if (!MARKDOWN_EXTENSIONS.includes(extname(path).toLowerCase())) {
    throw new PreconditionError(
      `markdownPath must be a ${MARKDOWN_EXTENSIONS.join(", ")} file; ${path} is not. Its ` +
        "contents would be sent to X.",
      { markdownPath: path },
    );
  }
  const size = sizeOf(path);
  if (size > MAX_MARKDOWN_BYTES) {
    throw new PreconditionError(`${path} is larger than 1 MB, which is not an Article.`, {
      markdownPath: path,
      bytes: size,
    });
  }
  return { path, text: readFileSync(path, "utf8") };
};
