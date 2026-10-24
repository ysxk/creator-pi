/**
 * Which user message just arrived (D696).
 *
 * A message the user has just sent rises into the transcript from the
 * composer below. Only a row whose message is younger than a moment when it
 * mounts qualifies, so opening a session or scrolling history never animates
 * old turns.
 *
 * One send is one arrival. Its row may mount again while it rises: a native
 * session swaps the optimistic row for the persisted one (a new id and the
 * SDK's own timestamp), and a new task moves its first message from the draft
 * into the created session. Such a row continues the rise already under way
 * instead of starting over, so the result is the elapsed time to resume it at.
 */
const ARRIVAL_WINDOW_MS = 1200;
let arrivedAt: number | undefined;

/** Milliseconds into the arrival's rise, or null when the row does not rise. */
export function claimArrival(
  message: { role: string; createdAt?: string },
  now = Date.now(),
): number | null {
  if (message.role !== "user" || !message.createdAt) return null;
  const age = now - Date.parse(message.createdAt);
  if (!(age >= 0 && age < ARRIVAL_WINDOW_MS)) return null;
  if (arrivedAt !== undefined && now - arrivedAt >= 0 && now - arrivedAt < ARRIVAL_WINDOW_MS) {
    return now - arrivedAt;
  }
  arrivedAt = now;
  return 0;
}
