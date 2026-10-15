import base from './playwright.config.ts';
import { defineConfig } from '@playwright/test';
export default defineConfig({ ...base, testMatch: 'readme-screenshot.spec.ts', outputDir: '../../test-results/readme' });
