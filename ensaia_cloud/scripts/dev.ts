import server from '../api/server.js';
import {createServer} from 'vite';
server.listen(8787,'127.0.0.1');
const vite=await createServer();await vite.listen();vite.printUrls();
