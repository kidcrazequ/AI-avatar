import { parentPort, workerData } from 'node:worker_threads';
import { LookupEngine } from './lookup-engine';
const engine = new LookupEngine(workerData.root);
parentPort!.on('message', ({ sources, request }) => {
  try { parentPort!.postMessage({ result: engine.execute(sources, request) }); }
  catch (cause) { parentPort!.postMessage({ error: cause instanceof Error ? cause.message : String(cause) }); }
});
