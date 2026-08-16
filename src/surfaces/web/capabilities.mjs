import { defineSurfaceCapabilities } from "../../capabilities/surface-caps.mjs";

// Playwright on the chrome channel cannot model native app background and
// foreground lifecycle. Keeping app_lifecycle absent makes those steps lower
// to an explicit skip instead of a silent no op.
export const WEB_SURFACE_SUPPORTS = Object.freeze([
  "file_upload",
  "network_control",
  "permission_control",
  "clipboard_control",
  "clock_control",
  "raw_escape"
]);

export function webSurfaceCapabilities() {
  return defineSurfaceCapabilities({
    surface: "web",
    supports: WEB_SURFACE_SUPPORTS
  });
}
