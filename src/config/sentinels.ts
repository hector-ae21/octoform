/**
 * Runtime sentinel values that need a stable identity, not just a type.
 *
 * These live outside `src/types/` on purpose: a `Symbol` has to be constructed
 * somewhere, and a pure type declaration module cannot hold that construction.
 */

/**
 * The answer could not be read at all: an endpoint this plan does not expose,
 * or a field GitHub omitted. Distinct from `null`, which is a real value for
 * a description or a homepage and means "set to nothing". Conflating the two
 * makes the planner offer to fill in a field it cannot even see.
 */
export const UNREADABLE = Symbol('unreadable');
