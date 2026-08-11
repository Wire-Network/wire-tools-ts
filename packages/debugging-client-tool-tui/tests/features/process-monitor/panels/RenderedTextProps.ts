/**
 * The props of a rendered ink `<Text>` element, as the log-viewer line-renderer
 * tests observe them through `element.props`.
 *
 * ink ships types only through an `exports` map, which the tests'
 * `moduleResolution: node` cannot read, so ink's own `TextProps` is not
 * importable here.
 */
export interface RenderedTextProps {
  /** ink's text-wrapping mode — the line renderers pin `"truncate-end"`. */
  wrap?: string
}
