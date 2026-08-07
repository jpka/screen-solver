/**
 * The "deliberate pause vs unexpected loss" intent flag the spec calls for
 * (ticket #32; parent spec's failure taxonomy: "Three-way split on an
 * app-tracked intent flag: deliberate pause → ignored; unexpected loss → one
 * silent re-resolution, then fallback to the picker; renderer crash →
 * auto-restart, escalating on repeat").
 *
 * This module covers the first two branches of that split -- `loop.ts`'s
 * pre-flight guard consults {@link TargetIntentTracker.current} the moment it
 * finds the configured target has vanished, to decide which of the two it's
 * looking at. Renderer-crash escalation is a separate, unrelated concern
 * (`crash-restart-policy.ts`) -- a crashed hidden renderer isn't a target
 * loss at all, the target window itself is still there.
 *
 * Nothing calls {@link TargetIntentTracker.pause}/`resume` yet: no client
 * exists to ask for a pause (that's #33/#34's job, per #32's own scope note),
 * so in production this always reads `'active'` today -- which keeps
 * behavior unchanged (every vanished target is treated as an unexpected
 * loss) until a caller actually wires a pause action to it. Exported and
 * injectable now so that wiring, whenever it lands, is a one-line addition
 * rather than a new seam.
 */
export type TargetIntent = 'active' | 'paused';

export interface TargetIntentTracker {
  current(): TargetIntent;
  /** Marks the target as deliberately paused -- a vanished target while paused is ignored, not treated as an unexpected loss. */
  pause(): void;
  /** Clears a pause -- a vanished target after this is treated as an unexpected loss again. */
  resume(): void;
}

export function createTargetIntentTracker(): TargetIntentTracker {
  let intent: TargetIntent = 'active';
  return {
    current: () => intent,
    pause() {
      intent = 'paused';
    },
    resume() {
      intent = 'active';
    },
  };
}
