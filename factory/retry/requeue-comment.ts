/**
 * The requeue comment, printed for a workflow step that has no failure
 * handler to run (#148): `agent-review.yml`'s failure step, reached when the
 * reviewer never got an account because every one of them was rate limited.
 * The text is `renderRequeueComment`'s, so a review run requeued there says
 * what the retry handler says when it requeues a PR itself, and neither can
 * drift from the other.
 *
 * Env: RUN_URL. The comment goes to stdout; the step posts it.
 */
import { required } from "../lib/env";
import { RATE_LIMITED_REASON, renderRequeueComment } from "./decide";

process.stdout.write(
  renderRequeueComment({ reason: RATE_LIMITED_REASON, runUrl: required("RUN_URL"), onPr: true }),
);
