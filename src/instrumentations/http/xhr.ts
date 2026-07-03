import { debug, win } from "../../utils";

export function instrumentXhr() {
  if (!win || !win.XMLHttpRequest) {
    debug("Browser does not support XMLHttpRequest, skipping instrumentation");
    return;
  }
  // Implementation added in Task 3.
}
