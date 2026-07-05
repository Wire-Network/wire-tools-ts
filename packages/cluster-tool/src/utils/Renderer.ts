/**
 * Produces a complete artifact (file content) as a string.
 *
 * Implemented by the config renderers (`config.ini`, `logging.json`,
 * `genesis.json`) and extended by `ReportRenderer` (the CSV/Markdown/HTML
 * report writers). A `Renderer` is constructed with whatever it needs to
 * render and exposes a single nullary {@link Renderer.render} — output depends
 * only on the constructed state, never on call arguments.
 */
export interface Renderer {
  /** Render the complete artifact as a string. */
  render(): string
}
