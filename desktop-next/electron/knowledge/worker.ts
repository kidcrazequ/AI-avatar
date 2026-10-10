import { extractSource, type ExtractionInput } from './extract';

if (!process.send) throw new Error('Knowledge extraction requires an isolated IPC process');
const abandoned = () => process.exit(1);
process.once('disconnect', abandoned);
process.once('message', input => {
  void extractSource(input as ExtractionInput).then(
    manifest => ({ manifest }),
    cause => ({ error: cause instanceof Error ? cause.message : String(cause) }),
  ).then(result => process.send!(result, () => { process.off('disconnect', abandoned); process.disconnect!(); }));
});
