import { register } from 'node:module';

register('./server-only-resolver.mjs', import.meta.url);
