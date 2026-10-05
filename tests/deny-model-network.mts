// Offline-model tripwire, not a security sandbox. PostgreSQL sockets remain available.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
function denied(): never { throw new Error('Tests may not call HTTP/model providers'); }
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
globalThis.fetch = denied;
syncBuiltinESMExports();
