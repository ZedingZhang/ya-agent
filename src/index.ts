export { VERSION } from "./version";
export {
  ModelConfig,
  VALID_MODELS,
  assertImageInputSupported,
  isVisionModel,
  loadConfig,
  modelId,
  saveConfig,
} from "./config";
export { DeepSeekClient, DeepSeekError } from "./deepseek";
export {
  MAX_IMAGES_PER_REQUEST,
  MAX_IMAGE_URL_LENGTH,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGE_TOTAL_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  assertImageCount,
  detectImageMimeType,
  imageContentPartsFromFiles,
  imageContentPartsFromSources,
  inspectImageFile,
  inspectImageFiles,
  isImageDetail,
} from "./images";
export type { ImageFileInfo, SupportedImageMimeType } from "./images";
export { runTask } from "./service";
export { runCommand } from "./commands";
export type { CommandEvent, CommandOptions, CommandResult } from "./commands";
export { LocalWorkspace, LOCAL_RUN_TOOL } from "./local";
export type { LocalWorkspaceOptions } from "./local";
export type {
  ChatFileContentPart,
  ChatImageUrlContentPart,
  ChatTextContentPart,
  ImageDetail,
  UserContentPart,
  UserImageContentPart,
} from "./types";
