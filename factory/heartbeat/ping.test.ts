/**
 * The shape of the URL one pass reports to (#325). The pass's own behaviour --
 * one request, the right status on the end, nothing sent on a dry run, nothing
 * lost to a switch that never answers -- is pinned at the sender's subprocess
 * seam in `send.test.ts`, against a local server standing in for
 * healthchecks.io. What is left here is the one thing that seam cannot show a
 * maintainer: which of the URLs they might paste in are read as the same check.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { passUrl } from "./ping.ts";

test("the pass's exit status is the last path segment, which is how healthchecks.io reads it", () => {
  assert.equal(passUrl("https://hc-ping.com/a-check-uuid", 0), "https://hc-ping.com/a-check-uuid/0");
  assert.equal(passUrl("https://hc-ping.com/a-check-uuid", 1), "https://hc-ping.com/a-check-uuid/1");
});

test("a URL copied out of the dashboard with a trailing slash reaches the same check", () => {
  // healthchecks.io shows the ping URL with no slash and a browser adds one, so
  // both shapes are pasted into a host's config. `/a-check-uuid//0` is not the
  // same check, and the failure it produces is a check that never goes green
  // with nothing in the host's log to say why.
  assert.equal(passUrl("https://hc-ping.com/a-check-uuid/", 0), "https://hc-ping.com/a-check-uuid/0");
  assert.equal(passUrl("https://hc-ping.com/a-check-uuid//", 1), "https://hc-ping.com/a-check-uuid/1");
});

test("a host with nothing configured reports nowhere", () => {
  // Unset, and blank or whitespace with it: a variable a host declared and
  // never filled in is a host with no switch, not one asking for a request to
  // be made to whatever the empty string resolves against.
  for (const configured of [undefined, "", "   ", "\n"]) assert.equal(passUrl(configured, 0), undefined);
});
