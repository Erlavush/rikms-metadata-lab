const quotedAbsolutePath = /(["'])(?:\/[^"'\r\n]+|[A-Za-z]:[\\/][^"'\r\n]+)\1/g;
const fileUrl = /\bfile:\/\/\/?[^\s"']+/gi;

/** Removes private filesystem locations while keeping the actionable error. */
export function redactPrivatePaths(message: string): string {
  return message
    .replace(quotedAbsolutePath, (_match, quote: string) => `${quote}[private path]${quote}`)
    .replace(fileUrl, "[private path]")
    .slice(0, 4_000);
}

export function publicErrorMessage(error: unknown): string {
  return redactPrivatePaths(error instanceof Error ? error.message : "Unexpected server error.");
}

export function redactEventDetails(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^(?:\/|[A-Za-z]:[\\/])/.test(value)) return "[private path]";
    return redactPrivatePaths(value);
  }
  if (Array.isArray(value)) return value.map(redactEventDetails);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactEventDetails(entry)]));
  }
  return value;
}
