import { test } from "node:test";
import assert from "node:assert/strict";
import { clockTime, day, deviceName, usedAgo } from "./format.js";

// The words the account and key lists are made of. They are shown to a person, so
// they are worth holding to: a session list nobody can read is a session list that
// will not get used.

test("a device is named as a person would name it", () => {
  assert.equal(
    deviceName(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    ),
    "Safari 18 on Intel Mac OS X 10_15_7",
  );
  assert.equal(
    deviceName(
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
    ),
    "Firefox 130 on Linux x86_64",
  );
  // A phone says it is a phone, not a bracket full of build numbers.
  assert.equal(
    deviceName(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    ),
    "Safari 17 on iPhone",
  );
  // Edge and Opera are spelled as people spell them.
  assert.equal(
    deviceName(
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Edg/130.0 Safari/537.36",
    ),
    "Edge 130 on Windows NT 10.0",
  );
  // Something this code has never seen is shown as it arrived, rather than as
  // nothing at all: a blank row in a list of sign-ins is the worst outcome.
  assert.equal(deviceName("TotallyUnknown/9"), "TotallyUnknown/9");
  assert.equal(deviceName(""), "an unknown device");
});

test("times are said the way they are read", () => {
  const now = new Date().toISOString();
  const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const hoursAgo = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
  const daysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
  assert.equal(usedAgo(null), "never");
  assert.equal(usedAgo(now), "just now");
  assert.equal(usedAgo(minutesAgo), "5 min ago");
  assert.equal(usedAgo(hoursAgo), "5 hours ago");
  assert.equal(usedAgo(daysAgo), "3 days ago");
  assert.equal(usedAgo("nonsense"), "unknown");
  assert.equal(day("nonsense"), "unknown");
  assert.match(day(now), /\d/);
  assert.match(clockTime(now), /\d/);
  assert.equal(clockTime("nonsense"), "");
});
