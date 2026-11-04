import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/injected', { recursive: true });
cpSync('src/injected/recorder.js', 'dist/injected/recorder.js');
cpSync('src/injected/panel.js', 'dist/injected/panel.js');
cpSync('src/injected/audit.js', 'dist/injected/audit.js');
