export default [
  { ignores:['node_modules/**','scripts/fixtures/host-044-index.mjs'] },
  {
    files:['lib/**/*.{js,cjs}','scripts/**/*.mjs','eslint.config.mjs'],
    languageOptions:{ecmaVersion:2022,globals:Object.fromEntries([
      'console','process','Buffer','URL','URLSearchParams','setTimeout','clearTimeout',
      'queueMicrotask','setImmediate','clearImmediate','AbortController','fetch','window','document',
      'navigator','MutationObserver','globalThis','TextEncoder',
    ].map(name=>[name,'readonly']))},
    rules:{
      'no-undef':'error',
      'no-unused-vars':['error',{args:'none',caughtErrors:'none',varsIgnorePattern:'^_'}],
      'no-unreachable':'error',
    },
  },
  {files:['lib/**/*.cjs'],languageOptions:{sourceType:'commonjs',globals:{__filename:'readonly'}}},
  {
    files:['eslint.config.mjs','scripts/critical-behavior.mjs','scripts/fixtures/client-harness.mjs','scripts/fixtures/source-text-checks.mjs'],
    rules:{indent:['error',2,{SwitchCase:1}]},
  },
]

