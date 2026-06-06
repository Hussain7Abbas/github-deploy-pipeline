#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';

const result = spawnSync('node', ['dist/cli.js'], { stdio: 'inherit' });

if (result.status !== 0) process.exit(result.status ?? 1);

const latestTag = execSync('git describe --tags --abbrev=0').toString().trim();

if (latestTag.includes('-rc.')) {
  console.log('\n📦 Staging release detected — publishing beta to npm...');
  execSync('make publish-beta', { stdio: 'inherit' });
} else {
  console.log('\n🚀 Production release detected — publishing to npm...');
  execSync('make publish-dry', { stdio: 'inherit' });
  execSync('make publish', { stdio: 'inherit' });
}
