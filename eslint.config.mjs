import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "obsidian-plugin/node_modules/**",
      "bench/generated/**",
      "bench/reports/**",
    ],
  },
  {
    files: ["scripts/**/*.mjs", "obsidian-plugin/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
    rules: {
      "no-redeclare": "error",
      "no-undef": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
    },
  },
];
