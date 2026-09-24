import {test,expect} from 'bun:test';
import {providers} from '../src/providers.ts';
import {Config} from '../src/contracts.ts';

test('shared Jev transport bounds response bytes and HTTP deadline on loopback fixtures',async()=>{
 const old=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='synthetic-not-a-secret';
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  if(new URL(req.url).pathname==='/slow'){await Bun.sleep(250);return Response.json({fixture:true});}
  if(new URL(req.url).pathname==='/large')return Response.json({text:'x'.repeat(3000)});
  return Response.json({fixture:true});
 }});
 const adapter={identity:()=>({fixture:true}),async curate(){throw Error('unexpected curator');}};
 const client=(path:string)=>providers(Config.parse({jevUrl:`http://127.0.0.1:${server.port}/${path}`,timeoutMs:100,maxOutputBytes:1024}),adapter);
 try{
  expect(await client('small').jev({model:'test',state:{},questions:{}})).toEqual({fixture:true});
  await expect(client('large').jev({model:'test',state:{},questions:{}})).rejects.toThrow('output limit');
  await expect(client('slow').jev({model:'test',state:{},questions:{}})).rejects.toThrow();
 }finally{server.stop(true);if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old;}
});
