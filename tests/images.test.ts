import { truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_IMAGES_PER_REQUEST,
  MAX_IMAGE_URL_LENGTH,
  MAX_INLINE_IMAGE_TOTAL_BYTES,
  detectImageMimeType,
  imageContentPartsFromFiles,
  imageContentPartsFromSources,
  inspectImageFile,
  inspectImageFiles,
} from "../src/images";
import { tempHome, type TempHome } from "./helpers";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const GIF = Buffer.from("GIF89a!", "ascii");
const WEBP = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii")]);

describe("vision image inputs", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome("ya-images-"); });
  afterEach(() => home.cleanup());

  it("detects supported formats by file signature instead of extension", () => {
    expect(detectImageMimeType(PNG)).toBe("image/png");
    expect(detectImageMimeType(JPEG)).toBe("image/jpeg");
    expect(detectImageMimeType(GIF)).toBe("image/gif");
    expect(detectImageMimeType(WEBP)).toBe("image/webp");
    expect(detectImageMimeType(Buffer.from("not an image"))).toBeUndefined();
  });

  it("encodes a verified local image and applies the requested detail", () => {
    const path = join(home.path, "actually-a-png.txt");
    writeFileSync(path, PNG);
    const file = inspectImageFile(path);
    expect(file).toMatchObject({ name: "actually-a-png.txt", size: PNG.length, mimeType: "image/png" });
    expect(imageContentPartsFromSources([path], "high")).toEqual([{
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG.toString("base64")}`, detail: "high" },
    }]);
  });

  it("rechecks GUI-selected files instead of trusting stale metadata", () => {
    const path = join(home.path, "image.png");
    writeFileSync(path, PNG);
    const file = inspectImageFile(path);
    expect(() => imageContentPartsFromFiles([{ ...file, size: 1, mimeType: "image/jpeg" }])).toThrow(/changed after selection/u);
    expect(imageContentPartsFromFiles([file])).toEqual([{
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG.toString("base64")}`, detail: "auto" },
    }]);
    writeFileSync(path, Buffer.from("not an image"));
    expect(() => imageContentPartsFromFiles([file])).toThrow(/Unsupported image content/u);
  });

  it("accepts canonical data URLs, HTTP URLs, and DeepSeek Files API IDs", () => {
    const dataUrl = `data:image/jpeg;base64,${PNG.toString("base64")}`;
    expect(imageContentPartsFromSources([
      dataUrl,
      "https://example.com/a%20chart.png",
      "file-api-AbC_123",
    ], "original")).toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${PNG.toString("base64")}`, detail: "original" },
      },
      {
        type: "image_url",
        image_url: { url: "https://example.com/a%20chart.png", detail: "original" },
      },
      { type: "file", file_id: "file-api-AbC_123" },
    ]);
  });

  it("rejects spoofed content, unsupported schemes, invalid IDs, and oversized URLs", () => {
    const fake = join(home.path, "fake.png");
    writeFileSync(fake, "plain text");
    expect(() => imageContentPartsFromSources([fake])).toThrow(/Unsupported image content/u);
    expect(() => imageContentPartsFromSources(["ftp://example.com/image.png"])).toThrow(/HTTP\(S\)/u);
    expect(() => imageContentPartsFromSources(["file-api-invalid!"])).toThrow(/Invalid DeepSeek Files API/u);
    expect(() => imageContentPartsFromSources([`https://example.com/${"a".repeat(MAX_IMAGE_URL_LENGTH)}`])).toThrow(/8192/u);
    expect(() => imageContentPartsFromSources(["data:image/png;base64,bm90IGFuIGltYWdl"])).toThrow(/does not contain supported/u);
  });

  it("enforces image-count and conservative aggregate inline limits", () => {
    expect(() => imageContentPartsFromSources(Array.from(
      { length: MAX_IMAGES_PER_REQUEST + 1 },
      (_, index) => `file-api-${index}`,
    ))).toThrow(/at most 600/u);

    const first = join(home.path, "first.png");
    const second = join(home.path, "second.png");
    writeFileSync(first, PNG);
    writeFileSync(second, PNG);
    truncateSync(first, MAX_INLINE_IMAGE_TOTAL_BYTES / 2 + 1);
    truncateSync(second, MAX_INLINE_IMAGE_TOTAL_BYTES / 2 + 1);
    expect(() => inspectImageFiles([first, second])).toThrow(/total at most 32 MiB/u);
  });
});
