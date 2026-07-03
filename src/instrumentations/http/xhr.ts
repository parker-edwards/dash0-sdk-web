import { debug, observeResourcePerformance, parseUrl, win, wrap } from "../../utils";
import { isUrlIgnored } from "../../utils/ignore-rules";
import { addAttribute, endSpan, InProgressSpan, recordException, setSpanStatus, startSpan } from "../../utils/otel";
import {
  ERROR_TYPE,
  HTTP_REQUEST_METHOD,
  HTTP_REQUEST_METHOD_ORIGINAL,
  HTTP_RESPONSE_STATUS_CODE,
  SPAN_STATUS_ERROR,
  SPAN_STATUS_UNSET,
} from "../../semantic-conventions";
import { vars, PropagatorType } from "../../vars";
import { httpRequestHeaderKey, httpResponseHeaderKey } from "../../utils/otel/http";
import { sendSpan } from "../../transport";
import {
  addResourceNetworkEvents,
  addResourceSize,
  addTraceContextHttpHeaders,
  determinePropagatorTypes,
  endSpanOnAbort,
  HTTP_METHOD_OTHER,
  isWellKnownHttpMethod,
} from "./utils";
import { addCommonAttributes, addUrlAttributes } from "../../attributes";

type XhrFailureKind = "error" | "timeout" | "abort";

type XhrState = {
  method: string;
  originalMethod: string;
  isWellKnownMethod: boolean;
  url: string;
  ignored: boolean;
  span?: InProgressSpan;
  propagatorTypes: PropagatorType[];
  capturedRequestHeaders?: Record<string, string>;
  completed: boolean;
  failureKind?: XhrFailureKind;
  performanceObserver?: ReturnType<typeof observeResourcePerformance>;
};

const XHR_STATE = Symbol("dash0XhrState");

type InstrumentedXhr = XMLHttpRequest & { [XHR_STATE]?: XhrState };

export function instrumentXhr() {
  if (!win || !win.XMLHttpRequest) {
    debug("Browser does not support XMLHttpRequest, skipping instrumentation");
    return;
  }

  const proto = win.XMLHttpRequest.prototype;
  wrap(proto, "open", wrapOpen);
  wrap(proto, "setRequestHeader", wrapSetRequestHeader);
  wrap(proto, "send", wrapSend);
}

function wrapOpen(original: XMLHttpRequest["open"]): XMLHttpRequest["open"] {
  return function (this: InstrumentedXhr, method: string, url: string | URL, ...rest: unknown[]) {
    const stringUrl = String(url);
    const originalMethod = method ?? "GET";
    const isWellKnownMethodMatchingLeniently = isWellKnownHttpMethod(originalMethod.toUpperCase());
    const normalizedMethod = isWellKnownMethodMatchingLeniently ? originalMethod.toUpperCase() : HTTP_METHOD_OTHER;

    // A new open() call on a reused XHR instance resets state -- any prior span for this instance
    // has already been sent (or will never be, if the previous request never completed) and this
    // open() is treated as the start of a brand-new request with its own span.
    this[XHR_STATE] = {
      method: normalizedMethod,
      originalMethod,
      isWellKnownMethod: isWellKnownHttpMethod(originalMethod),
      url: stringUrl,
      ignored: isUrlIgnored(stringUrl),
      propagatorTypes: determinePropagatorTypes(stringUrl),
      completed: false,
    };

    return original.apply(this, [method, url, ...rest] as Parameters<XMLHttpRequest["open"]>);
  };
}

function wrapSetRequestHeader(original: XMLHttpRequest["setRequestHeader"]): XMLHttpRequest["setRequestHeader"] {
  return function (this: InstrumentedXhr, name: string, value: string) {
    original.call(this, name, value);

    const state = this[XHR_STATE];
    if (!state || state.ignored) return;

    (state.capturedRequestHeaders ??= {})[name] = value;
  };
}

function wrapSend(original: XMLHttpRequest["send"]): XMLHttpRequest["send"] {
  return function (this: InstrumentedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    const state = this[XHR_STATE];
    if (!state || state.ignored) {
      return original.call(this, body as any);
    }

    const span = startSpan(`HTTP ${state.method}`);
    addCommonAttributes(span.attributes);
    addUrlAttributes(span.attributes, state.url);
    addAttribute(span.attributes, HTTP_REQUEST_METHOD, state.method);
    if (!state.isWellKnownMethod) {
      addAttribute(span.attributes, HTTP_REQUEST_METHOD_ORIGINAL, state.originalMethod);
    }
    state.span = span;

    if (state.propagatorTypes.length > 0) {
      try {
        addTraceContextHttpHeaders(
          (name, value) => this.setRequestHeader(name, value),
          this,
          span,
          state.propagatorTypes
        );
      } catch (e) {
        // setRequestHeader throws InvalidStateError if called before open() succeeded, or after
        // send(). This should not normally happen since we only reach here from within send()
        // itself with state populated by a prior open(), but guard defensively.
        debug("failed to inject trace context headers on XMLHttpRequest", e);
      }
    }

    if (vars.headersToCapture.length > 0 && state.capturedRequestHeaders) {
      for (const [name, value] of Object.entries(state.capturedRequestHeaders)) {
        if (vars.headersToCapture.some((rxp) => rxp.test(name))) {
          addAttribute(span.attributes, httpRequestHeaderKey(name), value);
        }
      }
    }

    const performanceObserver = observeResourcePerformance({
      resourceMatcher: ({ initiatorType, name }) =>
        initiatorType === "xmlhttprequest" && name === parseUrl(state.url).href,
      maxWaitForResourceMillis: vars.maxWaitForResourceTimingsMillis,
      maxToleranceForResourceTimingsMillis: vars.maxToleranceForResourceTimingsMillis,
      onEnd: ({ duration, resource }) => {
        if (resource) {
          addResourceNetworkEvents(span, resource);
          addResourceSize(span, resource);
        }
        sendSpan(endSpan(span, undefined, duration * 1000000));
      },
    });
    state.performanceObserver = performanceObserver;
    performanceObserver.start();

    this.addEventListener("error", () => {
      state.failureKind = "error";
    });
    this.addEventListener("timeout", () => {
      state.failureKind = "timeout";
    });
    this.addEventListener("abort", () => {
      state.failureKind = "abort";
    });
    this.addEventListener("loadend", () => onLoadEnd(this, state));

    return original.call(this, body as any);
  };
}

function onLoadEnd(xhr: InstrumentedXhr, state: XhrState) {
  if (state.completed) return;
  state.completed = true;

  const span = state.span;
  if (!span) return;

  const performanceObserver = state.performanceObserver;

  if (state.failureKind === "abort") {
    performanceObserver?.cancel();
    endSpanOnAbort(span);
    return;
  }

  let status = 0;
  try {
    status = xhr.status;
  } catch (_e) {
    // Reading .status can throw in some environments if accessed at the wrong readyState.
    status = 0;
  }

  if (state.failureKind === "error" || state.failureKind === "timeout" || status === 0) {
    performanceObserver?.cancel();
    const failureKind = state.failureKind ?? "error";
    recordException(span, { name: failureKind, message: `XMLHttpRequest failed: ${state.url}` });
    addAttribute(span.attributes, ERROR_TYPE, failureKind);
    sendSpan(endSpan(span, { code: SPAN_STATUS_ERROR, message: `XMLHttpRequest failed: ${state.url}` }, undefined));
    return;
  }

  setSpanStatus(span, status >= 200 && status < 400 ? SPAN_STATUS_UNSET : SPAN_STATUS_ERROR);
  addAttribute(span.attributes, HTTP_RESPONSE_STATUS_CODE, String(status));
  tryCaptureResponseHeaders(xhr, span);

  if (!performanceObserver) {
    sendSpan(endSpan(span, undefined, undefined));
    return;
  }
  performanceObserver.end();
}

function tryCaptureResponseHeaders(xhr: XMLHttpRequest, span: InProgressSpan) {
  try {
    if (!vars.headersToCapture.length) return;

    const raw = xhr.getAllResponseHeaders();
    if (!raw) return;

    raw
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .forEach((line) => {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) return;

        const name = line.substring(0, separatorIndex).trim();
        const value = line.substring(separatorIndex + 1).trim();

        if (vars.headersToCapture.some((rxp) => rxp.test(name))) {
          addAttribute(span.attributes, httpResponseHeaderKey(name), value);
        }
      });
  } catch (_e) {
    debug("unable to capture http response headers due to CORS policy");
  }
}
