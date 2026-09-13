/**
 * The env vars a workflow hands a script. Was in the vendored
 * `agent-workflows/shared/common.ts` until #313 dissolved it; his function,
 * unchanged, in a home of its own.
 *
 * A missing one is the workflow's bug, not the ticket's, so it exits before
 * anything else runs rather than letting `undefined` reach a prompt.
 */
export const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
};
