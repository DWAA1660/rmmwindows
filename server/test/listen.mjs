import { createServer } from 'node:http';
// Windows reserves portions of the high-port range. Retry only bind conflicts;
// keep test ports above browser/undici's forbidden well-known ports.
export async function listen(app) {
  const server = createServer(app);
  for (let attempt=0;attempt<30;attempt++) {
    try {
      await new Promise((resolve,reject)=>{
        const error = failure=>{server.off('listening',ready);reject(failure);};
        const ready = ()=>{server.off('error',error);resolve();};
        server.once('error',error);server.once('listening',ready);
        server.listen(51000+Math.floor(Math.random()*13000),'127.0.0.1');
      });
      return server;
    } catch(error) { if(!['EACCES','EADDRINUSE'].includes(error.code)||attempt===29) throw error; }
  }
}
