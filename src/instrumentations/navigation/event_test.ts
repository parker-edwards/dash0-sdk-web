import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyValue, LogRecord } from "../../types/otlp";

vi.mock("../../transport", () => ({
  sendLog: vi.fn(),
}));

import { sendLog } from "../../transport";
import { transmitPageViewEvent } from "./event";
import { vars } from "../../vars";

const sendLogMock = sendLog as unknown as ReturnType<typeof vi.fn>;

describe("transmitPageViewEvent", () => {
  beforeEach(() => {
    sendLogMock.mockClear();
    vars.pageViewInstrumentation = { trackVirtualPageViews: true, includeParts: [] };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("transmits an initial page view with type=INITIAL and change_state=pushState", () => {
    transmitPageViewEvent("1700000000000000000", new URL("https://example.com/landing"));

    expect(sendLogMock).toHaveBeenCalledTimes(1);
    const log = sendLogMock.mock.calls[0]![0] as LogRecord;

    expect(log.timeUnixNano).toBe("1700000000000000000");
    expect(log.severityNumber).toBe(9);
    expect(log.severityText).toBe("INFO");
    expect(log.attributes).toEqual(
      expect.arrayContaining([{ key: "event.name", value: { stringValue: "browser.page_view" } }])
    );

    const bodyValues = log.body?.kvlistValue?.values as KeyValue[];
    expect(bodyValues).toEqual(
      expect.arrayContaining([
        { key: "type", value: { doubleValue: 0 } },
        { key: "change_state", value: { stringValue: "pushState" } },
      ])
    );
  });

  it("transmits a virtual page view with type=VIRTUAL and change_state=replaceState when replaced", () => {
    transmitPageViewEvent("1700000000000000000", new URL("https://example.com/settings"), true, true);

    const log = sendLogMock.mock.calls[0]![0] as LogRecord;
    const bodyValues = log.body?.kvlistValue?.values as KeyValue[];
    expect(bodyValues).toEqual(
      expect.arrayContaining([
        { key: "type", value: { doubleValue: 1 } },
        { key: "change_state", value: { stringValue: "replaceState" } },
      ])
    );
  });

  it("applies generateMetadata title and attributes when provided", () => {
    vars.pageViewInstrumentation = {
      trackVirtualPageViews: true,
      includeParts: [],
      generateMetadata: () => ({ title: "Custom Title", attributes: { "app.screen": "settings" } }),
    };

    transmitPageViewEvent("1700000000000000000", new URL("https://example.com/settings"), true);

    const log = sendLogMock.mock.calls[0]![0] as LogRecord;
    expect(log.attributes).toEqual(expect.arrayContaining([{ key: "app.screen", value: { stringValue: "settings" } }]));
    const bodyValues = log.body?.kvlistValue?.values as KeyValue[];
    expect(bodyValues).toEqual(expect.arrayContaining([{ key: "title", value: { stringValue: "Custom Title" } }]));
  });
});
