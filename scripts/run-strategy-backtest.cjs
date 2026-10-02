const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Transpile this one CLI and its local TypeScript imports without tsx's Windows userInfo() lookup.
require.extensions['.ts'] = (loadedModule, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  });
  loadedModule._compile(compiled.outputText, filename);
};

const entry = path.join(__dirname, 'backtest-strategy-agents.ts');
const source = fs.readFileSync(entry, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: entry,
});
const runner = new Module(entry, module);
runner.filename = entry;
runner.paths = Module._nodeModulePaths(path.dirname(entry));
runner._compile(compiled.outputText, entry);
