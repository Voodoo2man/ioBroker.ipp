import { parentPort, workerData } from 'node:worker_threads';
import * as ipp from '@sealsystems/ipp';

try {
    parentPort?.postMessage({ response: ipp.parse(Buffer.from(workerData)) });
} catch {
    parentPort?.postMessage({ error: true });
}
