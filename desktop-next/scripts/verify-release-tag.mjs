import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const tag = process.env.SOUL_RELEASE_TAG ?? '';
const pkg = JSON.parse(fs.readFileSync('package.json'));
if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${pkg.version}`) throw new Error('Stable tag and package version must match');
if (execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim() !== execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()) throw new Error('Build must use exact tagged source');
if (process.arch !== process.argv[2]) throw new Error('Native host architecture does not match target');
console.log('Exact stable tag and native host validated');
