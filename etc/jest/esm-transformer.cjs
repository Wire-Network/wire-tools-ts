/**
 * Minimal ESM → CJS transformer for jest.
 * Converts `import`/`export` syntax to `require`/`module.exports`.
 * Used for ESM-only dependencies like @wireio/opp-solidity-models.
 */
module.exports = {
  process(sourceText) {
    const code = sourceText
      .replace(/export \* from ["'](.+?)["'];?/g, 'Object.assign(module.exports, require("$1"));')
      .replace(
        /export \{([^}]+)\} from ["'](.+?)["'];?/g,
        (_, names, path) => {
          const items = names.split(",").map(n => n.trim())
          return items
            .map(n => `module.exports.${n} = require("${path}").${n};`)
            .join("\n")
        }
      )
      .replace(
        /import \{([^}]+)\} from ["'](.+?)["'];?/g,
        (_, names, path) => {
          const items = names.split(",").map(n => n.trim())
          return `const { ${items.join(", ")} } = require("${path}");`
        }
      )
      .replace(
        /import (\w+) from ["'](.+?)["'];?/g,
        'const $1 = require("$2");'
      )
      .replace(/export default /g, "module.exports = ")
      .replace(
        /export (var|let|const) (\w+);/g,
        '$1 $2;\nObject.defineProperty(exports, "$2", { get() { return $2; }, enumerable: true });'
      )
      .replace(/export (var|let|const) (\w+)(\s*=)/g, '$1 $2$3')
      .replace(/export (function|class) (\w+)/g, '$1 $2')
    return { code }
  },
}
