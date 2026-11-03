import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/injected', { recursive: true });
cpSync('src/injected/recorder.js', 'dist/injected/recorder.js');
