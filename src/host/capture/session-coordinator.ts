import type { ConfigChangeEvent } from '../config/types.ts';
import { silentLogger, type Logger } from '../logger.ts';
import { settlesWithin } from '../settles-within.ts';
import type { CapturedFrame, CaptureSession, OpenCaptureSession, TargetWindowIdentity } from './types.ts';

/**
 * How long a target change will wait for an {@link CaptureSessionCoordinatorOptions.onSessionChange}
 * listener before tearing the stream down anyway.
 *
 * The listener exists so a recorder can flush its final chunk while the tracks
 * it is reading are still alive. That is worth waiting for -- it's the
 * difference between a clean last segment and one truncated mid-chunk -- but
 * only briefly: a wedged renderer must not be able to freeze target switching,
 * and a truncated segment is still a playable segment (see
 * `recording/segment-writer.ts`), so the cost of giving up here is small.
 */
const SESSION_LISTENER_TIMEOUT_MS = 3_000;

export interface CaptureSessionCoordinatorOptions {
  /** Opens a live session for one target. `src/main/capture-session.ts` supplies the real WGC-backed implementation. */
  readonly openSession: OpenCaptureSession;
  /** The target already resolved at startup (#28's `resolveTargetWindowOnStartup`), or `null` if none is configured yet. */
  readonly initialTarget: TargetWindowIdentity | null;
  /** #28's `ConfigStore.onChange` — the one signal this coordinator reacts to. */
  readonly onChange: (listener: (event: ConfigChangeEvent) => void) => () => void;
  /**
   * Notified whenever the live capture stream changes: `null` immediately
   * *before* a session is closed, and the new target immediately *after* one is
   * opened (#45).
   *
   * The before/after asymmetry is the whole point. #45's recorder sits on top
   * of this coordinator's stream, and if it only learned about a target change
   * after the tracks were already stopped, its final chunk would be flushed
   * against a dead stream — a truncated last segment on every window switch.
   * Being told first lets it stop cleanly while the stream is still alive.
   * Awaited (bounded by {@link SESSION_LISTENER_TIMEOUT_MS}) rather than
   * fire-and-forget, since "flushed cleanly" is precisely what can't be
   * guaranteed without waiting for it.
   *
   * Left unset, nothing is notified and this coordinator behaves exactly as it
   * did before #45 — the same "safe default that just does less" shape as every
   * other optional dependency in `src/host`.
   */
  readonly onSessionChange?: (target: TargetWindowIdentity | null) => void | Promise<void>;
  readonly logger?: Logger;
}

export interface CaptureSessionCoordinator {
  /** The target the coordinator is currently pursuing — set immediately, even while the open/close for it is still in flight. */
  currentTarget(): TargetWindowIdentity | null;
  /** Requests a frame from whatever session is currently open. `null` if none is open (no target, or mid-transition to one). */
  captureFrame(): Promise<CapturedFrame | null>;
  /** Resolves once the most recently requested target change has finished opening or closing. Mainly for tests and orderly shutdown. */
  settled(): Promise<void>;
  /** Tears down whatever session is open and stops reacting to further config changes. */
  stop(): Promise<void>;
}

/**
 * Keeps exactly one capture session open for the currently configured target
 * window: one opened at startup if a target is already resolved, and exactly
 * one teardown-then-reopen each time the target changes — per the spec's
 * "Capture session lifecycle" decision. The session is never closed and
 * reopened per solve; that would flicker the OS yellow capture-indicator
 * border, which is supposed to stay lit exactly while a session is open and
 * silent about individual solves.
 *
 * A pure state machine over an injected `openSession` function and a
 * `ConfigStore.onChange`-shaped subscription, so it's fully testable with
 * fakes — no real Electron, no real WGC pipeline. That pipeline itself stays
 * manual/E2E-verified; see `src/main/capture-session.ts`.
 *
 * Target changes are serialized through a generation counter rather than a
 * lock, so a change that arrives while the previous one is still opening
 * supersedes it cleanly: the stale open, once it resolves, is immediately
 * closed again instead of being left running alongside the newer one. At
 * most one session is ever open, and a change that arrives before the
 * previous open has even started skips that open entirely rather than
 * opening-then-immediately-closing it.
 */
export function startCaptureSessionCoordinator(
  options: CaptureSessionCoordinatorOptions,
): CaptureSessionCoordinator {
  const logger = options.logger ?? silentLogger;
  let generation = 0;
  let currentTarget: TargetWindowIdentity | null = null;
  let transition: Promise<CaptureSession | null> = Promise.resolve(null);
  let stopped = false;

  function applyTarget(target: TargetWindowIdentity | null): void {
    generation += 1;
    const myGeneration = generation;
    const previousTransition = transition;
    currentTarget = target;

    transition = (async () => {
      const previousSession = await previousTransition.catch(() => null);
      if (previousSession) {
        // Told *before* the close, so anything reading this stream can wind
        // down against live tracks rather than dead ones. See `onSessionChange`.
        await notifySessionChange(null);
        await previousSession.close().catch((error: unknown) => {
          logger.error(`capture: failed to close the previous session: ${describeError(error)}`);
        });
      }

      if (stopped || target === null || myGeneration !== generation) {
        if (target === null && !stopped) await notifySessionChange(null);
        return null;
      }

      let session: CaptureSession;
      try {
        session = await options.openSession(target);
      } catch (error) {
        logger.error(
          `capture: failed to open a session for ${target.processName} / "${target.title}": ${describeError(error)}`,
        );
        return null;
      }

      if (stopped || myGeneration !== generation) {
        await session.close().catch(() => {});
        return null;
      }
      // Told *after* the open, so a listener that reacts by starting to read
      // the stream finds one actually there.
      await notifySessionChange(target);
      return session;
    })();
  }

  /**
   * Runs the listener, bounded and never allowed to throw. A listener that
   * fails or hangs is its own subsystem's problem; it must not be able to wedge
   * or abort a target change, which is load-bearing for solving.
   */
  async function notifySessionChange(target: TargetWindowIdentity | null): Promise<void> {
    if (options.onSessionChange === undefined) return;
    let work: Promise<void>;
    try {
      work = Promise.resolve(options.onSessionChange(target));
    } catch (error) {
      logger.error(`capture: a session-change listener threw: ${describeError(error)}`);
      return;
    }
    const settled = await settlesWithin(work, SESSION_LISTENER_TIMEOUT_MS);
    if (!settled) {
      logger.warn(
        `capture: a session-change listener did not finish within ${SESSION_LISTENER_TIMEOUT_MS}ms; continuing without it.`,
      );
    }
  }

  applyTarget(options.initialTarget);
  const unsubscribe = options.onChange((event: ConfigChangeEvent) => applyTarget(event.target));

  return {
    currentTarget: () => currentTarget,

    async captureFrame(): Promise<CapturedFrame | null> {
      const session = await transition;
      return session ? session.captureFrame() : null;
    },

    async settled(): Promise<void> {
      await transition;
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      generation += 1;
      const session = await transition;
      if (session) {
        await session.close().catch((error: unknown) => {
          logger.error(`capture: failed to close session on shutdown: ${describeError(error)}`);
        });
      }
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
