#!/usr/bin/env node
import { cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, '..', 'src', 'ui');
const dest = join(__dirname, '..', 'dist', 'ui');

cpSync(src, dest, { recursive: true });
