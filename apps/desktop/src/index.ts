export type {
  DesktopState,
  DesktopConnectionStatus,
  DesktopApiClient,
} from "./types.js";
export {
  DesktopError,
  createDesktopError,
  DESKTOP_ERROR_CODES,
  DESKTOP_ERROR_MESSAGES,
} from "./errors.js";
export { DesktopController } from "./controller.js";
export {
  mountDesktopUi,
  type DesktopUi,
} from "./ui.js";
export {
  bootstrapDesktopUi,
  bootstrapDesktopUiFromDocument,
  DESKTOP_API_CLIENT_GLOBAL,
} from "./browser-entry.js";
export {
  createLoopbackDesktopApiClient,
  type LoopbackDesktopApiClientOptions,
} from "./local-api-client.js";
export { renderDesktopPage } from "./render.js";
