import { defineSurfaceCapabilities } from "../../capabilities/surface-caps.mjs";

// What the simctl backend actually drives today.
//
// simctl can do more than adb here: `simctl privacy` grants permissions and
// `simctl status_bar` overrides the clock. Neither is declared, because a
// capability is declared once the adapter implements it, not once the tool
// could. Declaring one the adapter does not drive is the same lie as no-opping
// a step, and it would be a lie nobody could catch locally, since this surface
// only ever executes on CI.
//
//   app_lifecycle    `simctl launch` and terminate. Real.
//   raw_escape       a declared simctl argv with a written reason. Real.
//
//   file_upload        no picker to drive from simctl.
//   network_control    the simulator shares the host network; there is no per
//                      app switch to flip.
//   permission_control implementable through `simctl privacy`, and deliberately
//                      not claimed until it is written and exercised on CI.
//   clipboard_control  `simctl pbcopy` exists and is likewise not claimed yet.
//   clock_control      `simctl status_bar` overrides the displayed clock, not
//                      the clock the app reads, so it would not mean what the
//                      capability says.
export const IOS_SURFACE_SUPPORTS = Object.freeze(["app_lifecycle", "raw_escape"]);

export function iosSurfaceCapabilities() {
  return defineSurfaceCapabilities({
    surface: "ios",
    supports: IOS_SURFACE_SUPPORTS
  });
}
