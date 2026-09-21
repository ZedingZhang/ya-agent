import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  assertImageCount as nativeAssertImageCount,
  detectImageMimeType as nativeDetectImageMimeType,
  externalImageUrl as nativeExternalImageUrl,
  fileApiImageId as nativeFileApiImageId,
  imageDataUrlPart as nativeImageDataUrlPart,
  isHttpUrl as nativeIsHttpUrl,
  isImageDetail as nativeIsImageDetail,
  isSchemeUrl as nativeIsSchemeUrl,
} from "ya-core";
import type { ImageDetail, UserImageContentPart } from "./types";

export const MAX_IMAGES_PER_REQUEST = 600;
export const MAX_IMAGE_URL_LENGTH = 8_192;
export const MAX_INLINE_IMAGE_BYTES = 32 * 1_024 * 1_024;
// A 32 MiB binary image expands to about 42.7 MiB as base64, leaving room
// beneath DeepSeek's 48 MiB JSON request-body limit for prompts and metadata.
export const MAX_INLINE_IMAGE_TOTAL_BYTES = 32 * 1_024 * 1_024;

export const SUPPORTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export interface ImageFileInfo {
  path: string;
  name: string;
  size: number;
  mimeType: SupportedImageMimeType;
  modifiedAtMilliseconds: number;
}

export function isImageDetail(value: unknown): value is ImageDetail {
  return typeof value === "string" && nativeIsImageDetail(value);
}

/** The file signature decides the type; the extension is never trusted. */
export function detectImageMimeType(bytes: Uint8Array): SupportedImageMimeType | undefined {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return (nativeDetectImageMimeType(buffer) ?? undefined) as SupportedImageMimeType | undefined;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

function imageHeader(path: string): Buffer {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(12);
    const length = readSync(descriptor, header, 0, header.length, 0);
    return header.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

export function assertImageCount(count: number): void {
  nativeAssertImageCount(count);
}

function assertInlineTotal(bytes: number): void {
  if (bytes > MAX_INLINE_IMAGE_TOTAL_BYTES) {
    throw new Error("Local and data-URL images may total at most 32 MiB so the encoded request stays below DeepSeek's 48 MiB body limit.");
  }
}

export function inspectImageFile(source: string): ImageFileInfo {
  let path: string;
  try {
    path = realpathSync(resolve(expandHome(source)));
  } catch {
    throw new Error(`Image does not exist: ${source}`);
  }
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`Image is not a regular file: ${source}`);
  if (stats.size === 0) throw new Error(`Image is empty: ${source}`);
  if (stats.size > MAX_INLINE_IMAGE_BYTES) throw new Error(`Image exceeds DeepSeek's 32 MiB inline limit: ${source}`);
  const mimeType = detectImageMimeType(imageHeader(path));
  if (!mimeType) throw new Error(`Unsupported image content: ${source}. Use JPEG, PNG, GIF, or WebP.`);
  return { path, name: basename(path), size: stats.size, mimeType, modifiedAtMilliseconds: stats.mtimeMs };
}

export function inspectImageFiles(sources: string[]): ImageFileInfo[] {
  assertImageCount(sources.length);
  const files = sources.map(inspectImageFile);
  assertInlineTotal(files.reduce((total, file) => total + file.size, 0));
  return files;
}

function imagePartFromFile(file: ImageFileInfo, detail: ImageDetail): UserImageContentPart {
  const bytes = readFileSync(file.path);
  if (bytes.length !== file.size || detectImageMimeType(bytes) !== file.mimeType) {
    throw new Error(`Image changed after selection: ${file.path}. Choose it again.`);
  }
  const afterRead = inspectImageFile(file.path);
  assertSameImageFile(file, afterRead);
  return {
    type: "image_url",
    image_url: { url: `data:${file.mimeType};base64,${bytes.toString("base64")}`, detail },
  };
}

function assertSameImageFile(selected: ImageFileInfo, current: ImageFileInfo): void {
  if (
    selected.path !== current.path
    || selected.size !== current.size
    || selected.mimeType !== current.mimeType
    || selected.modifiedAtMilliseconds !== current.modifiedAtMilliseconds
  ) {
    throw new Error(`Image changed after selection: ${selected.path}. Choose it again.`);
  }
}

function imagePartFromDataUrl(source: string, detail: ImageDetail): { part: UserImageContentPart; bytes: number } {
  const inline = nativeImageDataUrlPart(source);
  return {
    part: { type: "image_url", image_url: { url: inline.url, detail } },
    bytes: inline.bytes,
  };
}

export function imageContentPartsFromFiles(files: ImageFileInfo[], detail: ImageDetail = "auto"): UserImageContentPart[] {
  if (!isImageDetail(detail)) throw new Error("Image detail must be low, high, original, or auto.");
  const currentFiles = inspectImageFiles(files.map((file) => file.path));
  files.forEach((file, index) => assertSameImageFile(file, currentFiles[index]!));
  return currentFiles.map((file) => imagePartFromFile(file, detail));
}

export function imageContentPartsFromSources(sources: string[], detail: ImageDetail = "auto"): UserImageContentPart[] {
  if (!isImageDetail(detail)) throw new Error("Image detail must be low, high, original, or auto.");
  assertImageCount(sources.length);
  const parts: UserImageContentPart[] = [];
  let inlineBytes = 0;
  for (const rawSource of sources) {
    const source = rawSource.trim();
    if (!source) throw new Error("Image source cannot be empty.");
    if (source.startsWith("file-api-")) {
      parts.push({ type: "file", file_id: nativeFileApiImageId(source) });
      continue;
    }
    if (source.startsWith("data:")) {
      const inline = imagePartFromDataUrl(source, detail);
      inlineBytes += inline.bytes;
      assertInlineTotal(inlineBytes);
      parts.push(inline.part);
      continue;
    }
    if (nativeIsHttpUrl(source)) {
      parts.push({ type: "image_url", image_url: { url: nativeExternalImageUrl(source), detail } });
      continue;
    }
    if (nativeIsSchemeUrl(source)) {
      throw new Error("External images require an HTTP(S) URL.");
    }
    const file = inspectImageFile(source);
    inlineBytes += file.size;
    assertInlineTotal(inlineBytes);
    parts.push(imagePartFromFile(file, detail));
  }
  return parts;
}
