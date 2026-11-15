/** Common English words that say nothing about a subject (shared by the lexical embedder and the launchpad cross-Source rule). */
export const STOPWORDS: ReadonlySet<string> = new Set(
  "the and for are but not you all can had her was one our out has have this that with from they will would there their what about which when your said than them been were into more other some could after over also how why who its new says say amid as at by in is it of on or to an a be he she we us".split(" "),
);
