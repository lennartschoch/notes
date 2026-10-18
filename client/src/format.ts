// The words that turn stored times into something a person reads.

export function day(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown";
  return at.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function usedAgo(iso: string | null): string {
  if (!iso) return "never";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "unknown";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// The order matters: a Chrome user agent claims to be Safari too, and a real Safari
// spells its own version out under `Version/`.
const BROWSERS = [
  { name: "Edge", pattern: /Edg\/(\d+)/ },
  { name: "Opera", pattern: /OPR\/(\d+)/ },
  { name: "Firefox", pattern: /Firefox\/(\d+)/ },
  { name: "Chrome", pattern: /Chrome\/(\d+)/ },
  { name: "Safari", pattern: /Version\/(\d+)/ },
  { name: "Safari", pattern: /Safari\/(\d+)/ },
];

// A platform in brackets that says nothing on its own, so the half beside it is
// asked instead: "(Macintosh; Intel Mac OS X 10_15_7)" is about the macOS, and
// "(X11; Linux x86_64)" is about the Linux.
const PLACEHOLDER = /^(macintosh|x11|linux|windows)$/i;

// A browser identifies itself with a string written for machines. Enough of it to
// tell one device from another is all a list of sign-ins needs, and what it cannot
// place is shown exactly as it arrived — a blank row in a list of sign-ins is the
// worst thing such a list could be.
export function deviceName(userAgent: string): string {
  const bracketed =
    /\((?<platform>[^)]+)\)/.exec(userAgent)?.groups?.platform ?? "";
  const parts = bracketed
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const first = parts[0] ?? "";
  const platform =
    parts.length > 1 && PLACEHOLDER.test(first) ? parts[1]! : first || "";
  const browser = BROWSERS.find((candidate) =>
    candidate.pattern.test(userAgent),
  );
  const version = browser ? browser.pattern.exec(userAgent)?.[1] : undefined;
  if (!browser || !version) return userAgent || "an unknown device";
  return platform.length > 0
    ? `${browser.name} ${version} on ${platform}`
    : `${browser.name} ${version}`;
}
