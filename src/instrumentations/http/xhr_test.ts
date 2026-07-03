import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vars } from "../../vars";
import { instrumentXhr } from "./xhr";
import { sendSpan } from "../../transport";
import type { Span } from "../../types/otlp";

vi.mock("../../transport", () => ({
  sendSpan: vi.fn(),
}));

/**
 * A controllable stand-in for the browser's XMLHttpRequest. jsdom's own XHR implementation does
 * not give deterministic control over readyState transitions, response headers, or event timing,
 * so we install this fake via vi.stubGlobal and drive it explicitly from each test.
 */
class FakeXMLHttpRequest extends EventTarget {
  static readonly UNSENT = 0;
  static readonly OPENED = 1;
  static readonly HEADERS_RECEIVED = 2;
  static readonly LOADING = 3;
  static readonly DONE = 4;

  readyState = FakeXMLHttpRequest.UNSENT;
  status = 0;
  statusText = "";
  responseHeaders: Record<string, string> = {};
  requestHeaders: Record<string, string> = {};
  method?: string;
  url?: string;
  async?: boolean;
  sentBody?: unknown;
  onreadystatechange: (() => void) | null = null;

  open(method: string, url: string, async?: boolean) {
    this.method = method;
    this.url = url;
    this.async = async ?? true;
    this.readyState = FakeXMLHttpRequest.OPENED;
    this.requestHeaders = {};
    this.status = 0;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }

  send(body?: unknown) {
    this.sentBody = body;
  }

  getAllResponseHeaders(): string {
    return Object.entries(this.responseHeaders)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
  }

  // --- Test-only helpers to drive the fake through a request lifecycle ---

  respond(status: number, headers: Record<string, string> = {}) {
    this.status = status;
    this.statusText = String(status);
    this.responseHeaders = headers;
    this.readyState = FakeXMLHttpRequest.DONE;
    this.dispatchEvent(new Event("loadend"));
  }

  triggerError() {
    this.status = 0;
    this.readyState = FakeXMLHttpRequest.DONE;
    this.dispatchEvent(new Event("error"));
    this.dispatchEvent(new Event("loadend"));
  }

  triggerTimeout() {
    this.status = 0;
    this.readyState = FakeXMLHttpRequest.DONE;
    this.dispatchEvent(new Event("timeout"));
    this.dispatchEvent(new Event("loadend"));
  }

  triggerAbort() {
    this.status = 0;
    this.readyState = FakeXMLHttpRequest.DONE;
    this.dispatchEvent(new Event("abort"));
    this.dispatchEvent(new Event("loadend"));
  }
}

describe("xhr test", () => {
  let NativeXHR: typeof XMLHttpRequest;

  beforeEach(() => {
    NativeXHR = globalThis.XMLHttpRequest;
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    vi.stubGlobal("location", { origin: "http://localhost:3000", href: "http://localhost:3000/" });
  });

  afterEach(() => {
    vi.stubGlobal("XMLHttpRequest", NativeXHR);
    vi.resetAllMocks();
    vars.propagators = undefined;
    vars.headersToCapture = [];
    vars.ignoreUrls = [];
  });

  it("should inject traceparent header for same-origin requests", () => {
    vars.propagators = [{ type: "traceparent", match: [] }];
    instrumentXhr();

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open("GET", "/api/test");
    xhr.send();

    expect(xhr.requestHeaders["traceparent"]).toBeDefined();
  });

  it("should inject traceparent header for matching cross-origin requests", () => {
    vars.propagators = [{ type: "traceparent", match: [new RegExp("http://foo.bar/")] }];
    instrumentXhr();

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open("GET", "http://foo.bar/foo");
    xhr.send();

    expect(xhr.requestHeaders["traceparent"]).toBeDefined();
  });

  it("should inject xray header in X-Ray format for matching cross-origin requests", () => {
    vars.propagators = [{ type: "xray", match: [new RegExp("http://foo.bar/")] }];
    instrumentXhr();

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open("GET", "http://foo.bar/foo");
    xhr.send();

    expect(xhr.requestHeaders["X-Amzn-Trace-Id"]).toMatch(
      /^Root=1-[0-9a-f]{8}-[0-9a-f]{24};Parent=[0-9a-f]{16};Sampled=1$/
    );
  });

  it("should inject no headers for non-matching cross-origin requests", () => {
    vars.propagators = [];
    instrumentXhr();

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open("GET", "http://foo.bar/foo");
    xhr.send();

    expect(xhr.requestHeaders["traceparent"]).toBeUndefined();
    expect(xhr.requestHeaders["X-Amzn-Trace-Id"]).toBeUndefined();
  });

  it("should not create a span or inject headers for ignored URLs", () => {
    vars.ignoreUrls = [/you-cant-see-this/];
    vars.propagators = [{ type: "traceparent", match: [] }];
    instrumentXhr();

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open("GET", "/you-cant-see-this");
    xhr.send();

    expect(xhr.requestHeaders["traceparent"]).toBeUndefined();
    expect(sendSpan).not.toHaveBeenCalled();
  });

  // unskipped in the completion commit (Task 4)
  it.skip("should capture matching request headers as span attributes", () => {
    vars.headersToCapture = [/x-test-header/];
    instrumentXhr();

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open("GET", "/api/test");
    xhr.setRequestHeader("x-test-header", "hello");
    xhr.send();
    xhr.respond(200);

    const sendSpanMock = sendSpan as unknown as ReturnType<typeof vi.fn>;
    const span = sendSpanMock.mock.calls[0]![0] as Span;
    expect(span.attributes).toContainEqual({
      key: "http.request.header.x-test-header",
      value: { stringValue: "hello" },
    });
  });

  // unskipped in the completion commit (Task 4)
  it.skip("normalizes well-known methods to uppercase and records HTTP_METHOD_OTHER for unknown methods", () => {
    instrumentXhr();

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open("get", "/api/test");
    xhr.send();
    xhr.respond(200);

    const sendSpanMock = sendSpan as unknown as ReturnType<typeof vi.fn>;
    const span = sendSpanMock.mock.calls[0]![0] as Span;
    expect(span.name).toBe("HTTP GET");
    expect(span.attributes).toContainEqual({ key: "http.request.method", value: { stringValue: "GET" } });
  });

  // unskipped in the completion commit (Task 4)
  it.skip("is safe to call instrumentXhr() twice (double-instrumentation guard)", () => {
    instrumentXhr();
    instrumentXhr();

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open("GET", "/api/test");
    xhr.send();
    xhr.respond(200);

    const sendSpanMock = sendSpan as unknown as ReturnType<typeof vi.fn>;
    expect(sendSpanMock).toHaveBeenCalledTimes(1);
  });
});
