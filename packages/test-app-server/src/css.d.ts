/** Allow Webpack-resolved CSS imports in TypeScript. */
declare module "*.css" {
  const content: Record<string, string>
  export default content
}
