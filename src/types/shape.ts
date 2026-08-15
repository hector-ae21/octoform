/** Types describing the authored configuration shape declared in `config/shape.ts`. */

/** How a field combines when one layer is folded onto the layer beneath it. */
export type MergeSemantics =
  /** The more specific layer's value wins outright. */
  | 'scalar'
  /** Keys combine; a key present in both layers has its value merged. */
  | 'merge-by-key'
  /** The more specific layer's collection replaces the inherited one whole. */
  | 'replace'
  /** Entries from both layers, in order, with duplicates removed. */
  | 'union'
  /** Entries from both layers, most specific first, where order decides. */
  | 'ordered-append'
  /** Belongs to the file that declares it and is never inherited. */
  | 'not-layered';

/** What kind of value a field holds. */
export type ValueShape =
  | { readonly kind: 'scalar' }
  | { readonly kind: 'any' }
  | { readonly kind: 'scalar-list' }
  | { readonly kind: 'object'; readonly of: () => ObjectShape }
  | { readonly kind: 'object-list'; readonly of: () => ObjectShape }
  | { readonly kind: 'map'; readonly of: () => ValueShape };

/** One declared field of one object. */
export interface Field {
  readonly shape: ValueShape;
  readonly merge: MergeSemantics;
}

/** A named object with a closed set of keys. */
export interface ObjectShape {
  readonly name: string;
  readonly fields: Readonly<Record<string, Field>>;
}

/** One published statement of how a field combines across layers. */
export interface SemanticsEntry {
  /** The named object the field belongs to, such as `PolicySet`. */
  shape: string;
  field: string;
  merge: MergeSemantics;
}
