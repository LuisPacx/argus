/** One raw item observed from a Source, normalized to the shape every Source shares (GLOSSARY: Signal). */
export interface Signal {
  /** Stable across polls: the same item always gets the same id, so storing it twice is a no-op. Starts with the Source id. */
  id: string;
  sourceId: string;
  /** The Source's label at observation time (the feed name). */
  sourceLabel: string;
  title: string;
  summary: string;
  /** An http(s) URL, or empty when the item had none (or an unsafe one). Safe to render as a link. */
  url: string;
  /** ISO time the item was published; the epoch when the Source gave none. */
  publishedAt: string;
}

/** A place Signals are observed from (ported from helios). Every Source plugs in through this. */
export interface Source {
  readonly id: string;
  readonly label: string;
  /** Observes the Source now and returns its current items. Throws when the Source cannot be read. */
  poll(): Promise<Signal[]>;
}
