// Same suite, but with the "healed" (weakened) cart test.
import { defineConfig } from '@playwright/test';
import { shopConfig } from './playwright.config.ts';

export default defineConfig({ ...shopConfig, testDir: './tests-healed' });
