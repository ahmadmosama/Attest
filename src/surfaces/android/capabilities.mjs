import { defineSurfaceCapabilities } from "../../capabilities/surface-caps.mjs";

// What the adb backend can honestly do, and nothing else.
//
// Every absence below is a thing plain adb cannot do correctly, not a thing
// left for later. An absent capability makes the op refuse with
// E_UNSUPPORTED_OP or lower to an explicit skip, which is the whole point: a
// silently no-opped step is a green gate that verified nothing.
//
//   app_lifecycle    HOME keyevent backgrounds, `am start` foregrounds. Real.
//   raw_escape       an adb argv the scenario declared with a written reason. Real.
//
//   file_upload        there is no file chooser to drive from adb. `adb push`
//                      moves a file onto the device but does not answer the
//                      app's picker intent, so claiming it would be a lie.
//   network_control    `svc wifi disable` needs privileges the emulator does
//                      not grant a shell user on a google_apis image, and the
//                      emulator console port needs an auth token. Deferred to
//                      the phase that wires the console, not faked here.
//   permission_control `pm grant` only accepts a manifest declared runtime
//                      permission and the scenario vocabulary is browser
//                      shaped (geolocation, camera). Mapping between them is a
//                      guess per app, and a wrong guess grants nothing while
//                      reporting success.
//   clipboard_control  no stable shell surface across API levels.
//   clock_control      setting the device clock needs root on a user build.
export const ANDROID_SURFACE_SUPPORTS = Object.freeze(["app_lifecycle", "raw_escape"]);

export function androidSurfaceCapabilities() {
  return defineSurfaceCapabilities({
    surface: "android",
    supports: ANDROID_SURFACE_SUPPORTS
  });
}
