import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.dirname(root);
process.chdir(root);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const resourceRoot = path.join(root, 'build/resources');
fs.rmSync(resourceRoot, { recursive: true, force: true });
fs.mkdirSync(resourceRoot, { recursive: true });
// Only source-controlled pack content: runtime memories, caches and private _raw sources are not build inputs.
const names = execFileSync('git', ['ls-files', '-z', 'expert-packs', 'shared', 'templates'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(name => name && path.basename(name) !== '.gitkeep').sort();
const files = names.map(name => {
  const bytes = fs.readFileSync(path.join(repo, name));
  const target = path.join(resourceRoot, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { path: name, bytes: bytes.length, sha256: hash(bytes) };
});
const experts = fs.readdirSync(path.join(resourceRoot, 'expert-packs')).map(id => {
  const pack = JSON.parse(fs.readFileSync(path.join(resourceRoot, 'expert-packs', id, 'expert-pack.json'), 'utf8'));
  for (const required of ['soul.md', 'AGENTS.md', 'knowledge/README.md', 'skills/skill-index.yaml']) {
    if (!fs.existsSync(path.join(resourceRoot, 'expert-packs', id, required))) throw new Error(`Incomplete expert pack: ${id}/${required}`);
  }
  return { id, name: pack.name, description: pack.description, domain: pack.domain, knowledgeFiles: names.filter(name => name.startsWith(`expert-packs/${id}/knowledge/`) && name.endsWith('.md')).length };
});
if (experts.length !== 10) throw new Error(`Expected 10 packs; found ${experts.length}`);
const dictionaries = ['jieba.dict.utf8', 'hmm_model.utf8', 'user.dict.utf8', 'idf.utf8', 'stop_words.utf8'].map(name => {
  const bytes = fs.readFileSync(path.join(root, 'node_modules/nodejieba/submodules/cppjieba/dict', name));
  return { name, bytes: bytes.length, sha256: hash(bytes) };
});
const manifest = { sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), lockSha256: hash(fs.readFileSync('package-lock.json')), files, experts, dictionaries };
fs.writeFileSync(path.join(resourceRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
await bundle({ entryPoints: ['electron/main.ts', 'electron/preload.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, external: ['electron', 'better-sqlite3', 'nodejieba', '@vscode/ripgrep', './retriever.cjs', './model.cjs'] });
const models = await bundle({ stdin: { contents: `export { OpenAICompatProvider } from '../desktop-app/src/services/llm-providers/openai-compat.ts'; export { ClaudeProvider } from '../desktop-app/src/services/llm-providers/claude.ts';`, resolveDir: root, sourcefile: 'soul-model-adapter.ts' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist-electron/model.cjs', alias: { '@soul/core/browser': path.join(repo, 'packages/core/src/intent-normalizer.ts') }, nodePaths: [path.join(root, 'node_modules')], metafile: true });
const core = await bundle({ entryPoints: ['../packages/core/src/knowledge-retriever.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist-electron/retriever.cjs', external: ['nodejieba'], metafile: true });
const coreInputs = Object.keys(core.metafile.inputs).map(name => ({ path: path.relative(repo, path.resolve(root, name)).replaceAll(path.sep, '/'), sha256: hash(fs.readFileSync(name)) }));
const modelInputs = Object.keys(models.metafile.inputs).filter(name => !name.includes('node_modules') && fs.existsSync(name)).map(name => ({ path: path.relative(repo, path.resolve(root, name)).replaceAll(path.sep, '/'), sha256: hash(fs.readFileSync(name)) }));
fs.writeFileSync(path.join(resourceRoot, 'build-inputs.json'), JSON.stringify({ ...manifest, files: undefined, experts: undefined, coreInputs, modelInputs }, null, 2));
await viteBuild({ root, base: './', build: { outDir: 'dist', emptyOutDir: true } });
console.log(`Resource manifest: ${files.length} files, ${experts.length} experts, ${files.reduce((sum, file) => sum + file.bytes, 0)} bytes`);
