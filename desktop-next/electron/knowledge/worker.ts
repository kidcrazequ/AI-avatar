import { parentPort, workerData } from 'node:worker_threads';
import { extractSource, type ExtractionInput } from './extract';

if (!parentPort) throw new Error('Knowledge extraction requires a background worker');
extractSource(workerData as ExtractionInput).then(
  manifest => parentPort!.postMessage({ manifest }),
  cause => parentPort!.postMessage({ error: cause instanceof Error ? cause.message : String(cause) }),
).finally(() => parentPort!.close());
