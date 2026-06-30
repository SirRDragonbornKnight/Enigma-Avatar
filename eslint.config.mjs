// Flat ESLint config for the avatar mod. The codebase is intentionally split:
//   - Electron main-process / preload / Node helpers = CommonJS (require/module.exports)
//   - renderer engine files (avatar.js, spring.js, ...) = ES modules loaded by Chromium
//   - tests = ES modules on Node's test runner
// so each group gets the right sourceType + globals. Formatting is owned by Prettier
// (eslint-config-prettier last turns off every stylistic rule), so ESLint only reports
// real problems (undefined names, unused vars, likely bugs).
import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

// Files loaded by the Electron MAIN process (CommonJS), not the browser renderer.
// The shell lives in shell/; the model library is a CJS module under src/model/.
const CJS_FILES = ["shell/main.cjs", "shell/preload.cjs", "shell/foreground.cjs", "src/model/library.cjs"];

export default [
  {
    ignores: ["node_modules/**", "models/**", "outputs/**", "assets/**", "vendor/**", "**/*.min.js"],
  },
  js.configs.recommended,
  {
    // Patterns this codebase uses on purpose — keep them from drowning the real signal.
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }], // fire-and-forget catches are deliberate
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }], // {action, ...rest} key-strip idiom is intentional
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipTemplates: true, skipRegExps: true, skipComments: true },
      ], // unicode in mojibake-repair regexes is intentional
    },
  },
  {
    files: CJS_FILES,
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
  },
  {
    // Standalone Node CLI tools (dev-only): ESM, Node globals (process, Buffer, console, ...).
    files: ["tools/**", "**/*.mjs"],
    languageOptions: { sourceType: "module", globals: { ...globals.node } },
  },
  {
    // Everything else under the mod is a browser ES module (the renderer engines + UI).
    files: ["**/*.js"],
    ignores: [...CJS_FILES, "tools/**", "tests/**"],
    languageOptions: { sourceType: "module", globals: { ...globals.browser } },
  },
  {
    files: ["tests/**"],
    languageOptions: { sourceType: "module", globals: { ...globals.node, ...globals.browser } },
  },
  prettier,
];
