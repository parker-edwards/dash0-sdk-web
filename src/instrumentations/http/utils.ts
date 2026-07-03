import {
  addAttribute,
  addSpanEvent,
  addW3CTraceContextHttpHeaders,
  addXRayTraceContextHttpHeaders,
  endSpan,
  errorToSpanStatus,
  Exception,
  InProgressSpan,
  recordException,
} from "../../utils/otel";
import { domHRTimestampToNanos, hasKey, isSameOrigin, PerformanceTimingNames } from "../../utils";
import { matchesAny } from "../../utils/ignore-rules";
import { HTTP_RESPONSE_BODY_SIZE, WEB_REQUEST_CANCELLED } from "../../semantic-conventions";
import { vars, PropagatorType } from "../../vars";
import { sendSpan } from "../../transport";

// SEE: https://github.com/open-telemetry/semantic-conventions/blob/main/docs/attributes-registry/http.md?plain=1#L67
const KNOWN_HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"];
export const HTTP_METHOD_OTHER = "_OTHER";

export function isWellKnownHttpMethod(method: string): boolean {
  return KNOWN_HTTP_METHODS.includes(method);
}

export function addResourceNetworkEvents(span: InProgressSpan, resource: PerformanceResourceTiming) {
  const ignoreZeros = resource.startTime !== 0;

  addSpanNetworkEvent(span, PerformanceTimingNames.FETCH_START, resource, ignoreZeros);
  addSpanNetworkEvent(span, PerformanceTimingNames.DOMAIN_LOOKUP_START, resource, ignoreZeros);
  addSpanNetworkEvent(span, PerformanceTimingNames.DOMAIN_LOOKUP_END, resource, ignoreZeros);
  addSpanNetworkEvent(span, PerformanceTimingNames.CONNECT_START, resource, ignoreZeros);
  addSpanNetworkEvent(span, PerformanceTimingNames.SECURE_CONNECTION_START, resource, ignoreZeros);
  addSpanNetworkEvent(span, PerformanceTimingNames.CONNECT_END, resource, ignoreZeros);
  addSpanNetworkEvent(span, PerformanceTimingNames.REQUEST_START, resource, ignoreZeros);
  addSpanNetworkEvent(span, PerformanceTimingNames.RESPONSE_START, resource, ignoreZeros);
  addSpanNetworkEvent(span, PerformanceTimingNames.RESPONSE_END, resource, ignoreZeros);
}

function addSpanNetworkEvent(
  span: InProgressSpan,
  propertyName: string,
  resource: PerformanceResourceTiming,
  ignoreZeros: boolean = true
) {
  if (
    !hasKey(resource, propertyName) ||
    typeof resource[propertyName] !== "number" ||
    (ignoreZeros && resource[propertyName] === 0)
  ) {
    return;
  }

  addSpanEvent(span, propertyName, domHRTimestampToNanos(resource[propertyName]));
}

export function addResourceSize(span: InProgressSpan, resource: PerformanceResourceTiming) {
  const encodedLength = resource.encodedBodySize;
  if (encodedLength != undefined) {
    addAttribute(span.attributes, HTTP_RESPONSE_BODY_SIZE, encodedLength);
  }
}

export function endSpanOnError(span: InProgressSpan, error: Exception) {
  recordException(span, error);
  sendSpan(endSpan(span, errorToSpanStatus(error), undefined));
}

export function endSpanOnAbort(span: InProgressSpan) {
  addAttribute(span.attributes, WEB_REQUEST_CANCELLED, true);
  sendSpan(endSpan(span, undefined, undefined));
}

export function determinePropagatorTypes(url: string): PropagatorType[] {
  const matchingTypes: PropagatorType[] = [];
  const isUrlSameOrigin = isSameOrigin(url);

  // For same-origin requests, always include traceparent + all configured propagators
  if (isUrlSameOrigin) {
    // Always add traceparent for same-origin requests
    matchingTypes.push("traceparent");

    // Add all other configured propagator types for same-origin requests
    if (vars.propagators) {
      for (const propagator of vars.propagators) {
        if (propagator.type !== "traceparent" && !matchingTypes.includes(propagator.type)) {
          matchingTypes.push(propagator.type);
        }
      }
    }
    return matchingTypes;
  }

  // For cross-origin requests, use new propagators config if available
  if (vars.propagators) {
    for (const propagator of vars.propagators) {
      if (matchesAny(propagator.match, url)) {
        // Avoid duplicates
        if (!matchingTypes.includes(propagator.type)) {
          matchingTypes.push(propagator.type);
        }
      }
    }
    return matchingTypes;
  }

  return [];
}

export function addTraceContextHttpHeaders(
  fn: (name: string, value: string) => void,
  ctx: unknown,
  span: InProgressSpan,
  types: PropagatorType[]
) {
  for (const type of types) {
    if (type === "xray") {
      addXRayTraceContextHttpHeaders(fn, ctx, span);
    } else {
      addW3CTraceContextHttpHeaders(fn, ctx, span);
    }
  }
}
