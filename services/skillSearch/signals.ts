/**
 * Signals for local skill discovery.
 *
 * A DiscoverySignal describes what triggered a discovery pass ("why are we
 * looking right now?") — e.g. the first user turn, a new user message between
 * turns, or a sub-agent spawn. Only `type` and an optional `payload` are needed
 * by consumers; the concrete policy that decides *which* skills to surface
 * lives in prefetch.ts on top of the local index in localSearch.ts.
 */

export interface DiscoverySignal {
  /** Short stable discriminator, e.g. 'user_input' | 'assistant_turn'. */
  type: string
  /** Opaque extra context attached to the signal (optional). */
  payload?: unknown
}


/** Legacy bare identifier export kept for historical value-imports. */
export type DiscoverySignalValue = DiscoverySignal