#!/usr/bin/env node
// mamekit CLI entry. Node >= 23.6 runs the TypeScript source directly
// (native type stripping), so there is no build step for the CLI itself.
await import(new URL('../src/cli.ts', import.meta.url));
