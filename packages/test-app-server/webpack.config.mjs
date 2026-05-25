import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import HtmlWebpackPlugin from "html-webpack-plugin"
import webpack from "webpack"
import { createRequire } from "node:module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Locate a pnpm-installed package's directory by walking up from `startDir`,
// scanning each `node_modules/.pnpm/` for `<name>@*` entries. Needed because
// `require.resolve` won't find packages whose `exports` field doesn't expose
// the subpath we want, or that aren't direct deps of this package.
// function pnpmPackageDir(name, startDir) {
//   const pnpmName = name.replace('/', '+');
//   let dir = startDir;
//   while (dir !== path.parse(dir).root) {
//     const pnpmDir = path.join(dir, 'node_modules', '.pnpm');
//     if (fs.existsSync(pnpmDir)) {
//       const match = fs.readdirSync(pnpmDir).find(n => n.startsWith(`${pnpmName}@`));
//       if (match) return path.join(pnpmDir, match, 'node_modules', name);
//     }
//     dir = path.dirname(dir);
//   }
//   throw new Error(`Could not locate pnpm-installed ${name} from ${startDir}`);
// }

// Load .env — check package dir first, then monorepo root
const envCandidates = [
  path.join(__dirname, ".env"),
  path.join(__dirname, "../../.env")
]
const envPath = envCandidates.find(p => fs.existsSync(p))
const envVars = {}
if (envPath) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/)
    if (match) envVars[match[1]] = match[2]
  }
}

export default {
  devtool: "source-map",
  entry: "./src/index.tsx",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "bundle.[contenthash].js",
    clean: true,
    publicPath: "/"
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"],
    alias: {
      // @3fv/prelude-ts's "browser" exports condition points at dist/mjs/, but
      // that build is broken: files mix ESM `import` with bare top-level
      // `require("hamt_plus")` calls, which webpack leaves as a runtime
      // reference and the browser then throws on. Redirect the whole package
      // (including subpath imports) to dist/cjs/, which is internally
      // consistent CJS that webpack handles correctly.
      // '@3fv/prelude-ts': path.join(pnpmPackageDir('@3fv/prelude-ts', __dirname), 'dist/cjs'),
    },
    fallback: {
      stream: require.resolve("stream-browserify"),
      crypto: false,
      vm: false
    }
  },
  module: {
    rules: [
      {
        test: /\.m?js$/,
        resolve: { fullySpecified: false }
      },
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"]
      }
    ]
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: "./src/index.html"
    }),
    new webpack.DefinePlugin({
      "process.env.AUTHEX_TEST_PRIVATE_KEY": JSON.stringify(
        envVars.AUTHEX_TEST_PRIVATE_KEY || ""
      )
    })
  ],
  devServer: {
    port: 4000,
    hot: true,
    historyApiFallback: true,
    allowedHosts: "all",
    headers: {
      "Access-Control-Allow-Origin": "*"
    }
  }
}
