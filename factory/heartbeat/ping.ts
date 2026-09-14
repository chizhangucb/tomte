/**
 * The dead-man's switch the heartbeat reports to (#325), so any host can be
 * watched through the one command it already runs.
 *
 * A host is a machine this repo does not own: a laptop that sleeps, a cloud
 * cron nobody publishes a timing guarantee for. Nothing inside the factory can
 * tell a host that stopped from an estate with nothing to do, because both look
 * like silence. A switch inverts that: the pass reports to it every time, and
 * the report not arriving is what raises the alarm, after the check's own
 * period and grace.
 *
 * The ping lives here rather than in each host's script so every host gets it
 * from the sender's one command and it is tested once, at the sender's
 * subprocess seam.
 *
 * **Reporting the exit status, not just "alive".** healthchecks.io reads the
 * path segment after the check's URL as the run's exit status, so a pass with a
 * failed target alerts at once instead of waiting for a pass that never comes.
 * That is the whole protocol: no body, no headers, no account of what failed,
 * which the host's own log already holds.
 *
 * **The ping is worth less than the pass.** A switch that is unreachable, slow
 * or answering 500 is a line on stderr and nothing else: the same exit status,
 * the same outcome lines, and a short timeout so a monitoring outage cannot
 * hold a pass open. The failure this must not have is the one where watching
 * the heartbeat is what stops it.
 *
 * Builtins only -- `fetch` is global from Node 18 -- and explicit `.ts`, so
 * `send.ts` reaches it on bare `node --experimental-strip-types`.
 */
import { errorMessage } from "../lib/errors.ts";

/**
 * Where the host puts its check's ping URL. Unset is a host with no switch,
 * which is every host until somebody makes a check, so the sender may not
 * require it.
 */
export const PING_URL_ENV = "FACTORY_HEARTBEAT_PING_URL";

/**
 * How long the ping may take before the pass gives up on it.
 *
 * Five seconds, which is short against the interval and long against a request
 * that carries nothing. The number that matters is the ratio: a pass sweeps
 * every target in seconds, so a ping allowed to hang would be most of the pass,
 * and on a host that runs one pass at a time it would eat the next one too.
 */
export const PING_TIMEOUT_MS = 5_000;

/**
 * The URL one pass reports to: the check's URL with the pass's exit status on
 * the end, which is how healthchecks.io is told a run succeeded or failed. A
 * trailing slash on the configured URL is dropped rather than doubled, because
 * a URL copied out of a dashboard carries one about half the time and
 * `/uuid//1` is not the same check.
 *
 * Nothing when nothing is configured, blank included: a variable set to the
 * empty string is a host that has not filled it in, not one that wants a ping
 * to the sender's own working directory.
 */
const passUrl = (configured: string | undefined, exitStatus: number): string | undefined => {
  const base = configured?.trim().replace(/\/+$/, "");
  return base ? `${base}/${exitStatus}` : undefined;
};

/**
 * Where a failed ping is said to have gone, with the check's own path left off.
 * The path is the check's secret -- anyone holding it can mark the check up --
 * and a host's log is read, copied into an issue and pasted into a chat, so the
 * line names the host it could not reach and the variable to look in. Anything
 * that will not parse as a URL is named by the variable alone, which is the
 * only true thing left to say about it.
 */
const switchOrigin = (url: string): string => {
  try {
    return `${new URL(url).origin} (${PING_URL_ENV})`;
  } catch {
    return PING_URL_ENV;
  }
};

/** The one line a failed ping is worth, whichever way it failed. */
const couldNotTell = (url: string, cause: string): string => `could not tell the dead-man's switch at ${switchOrigin(url)}: ${cause}`;

/**
 * Why the request failed, in the words an operator can act on. `fetch` renders
 * every transport failure as the same "fetch failed" and hangs the real reason
 * off `cause`, so a refused connection, an unknown host and a bad certificate
 * all read alike without it -- and this line is the only report a failed ping
 * ever makes.
 */
const why = (error: unknown): string => {
  const message = errorMessage(error);
  const cause = error instanceof Error && error.cause !== undefined ? errorMessage(error.cause) : "";
  return cause && !message.includes(cause) ? `${message}: ${cause}` : message;
};

/**
 * Tell the switch how the pass went, if the host configured one. Answers with
 * the line the caller should put on stderr, or nothing when there was nothing
 * to say: it never throws and never decides the pass's exit status, so the
 * caller has no failure of this to handle beyond printing it.
 *
 * No seam for the request and none for the clock: the sender's own tests run
 * the real command against a local HTTP server, which is where the ticket put
 * them, and a parameter no caller passes is one more thing to keep true than a
 * host ever exercises.
 */
export const reportPass = async (configured: string | undefined, exitStatus: number): Promise<string | undefined> => {
  const url = passUrl(configured, exitStatus);
  if (!url) return undefined;
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    // The body is read and dropped: healthchecks.io answers a two-byte "OK",
    // and a body left unread holds the socket open past the pass that opened it.
    await response.arrayBuffer();
    // A 404 is the commonest of these and the one worth reading: it is the
    // check the URL names having been deleted, which is a switch nobody is
    // watching rather than one that is merely unreachable.
    return response.ok ? undefined : couldNotTell(url, `HTTP ${response.status}`);
  } catch (error) {
    return couldNotTell(url, why(error));
  }
};
