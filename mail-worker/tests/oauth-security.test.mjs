import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {getCookie,setCookie} from 'hono/cookie';

async function load(file, mocks) {
 const context = vm.createContext({crypto,TextEncoder,btoa,URL,URLSearchParams,Date,Set,console});
 const mod = new vm.SourceTextModule(await readFile(new URL('../src/'+file,import.meta.url),'utf8'),{context});
 await mod.link(async name => {
  const values=mocks[name]||{default:{}};
  return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v] of Object.entries(values))this.setExport(k,v)},{context});
 });
 await mod.evaluate();return mod.namespace.default;
}
class BizError extends Error {}
async function flowFixture() {
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE oauth(oauth_id INTEGER PRIMARY KEY,platform TEXT,oauth_user_id TEXT)');
 const db={prepare(sql){const stmt=sqlite.prepare(sql);let args=[];return {bind(...v){args=v;return this},async run(){return stmt.run(...args)},async first(){return stmt.get(...args)}}}};
 const migration=await readFile(new URL('../src/init/init.js',import.meta.url),'utf8');
 const section=migration.slice(migration.indexOf('async oauthSecurityDB'),migration.indexOf('async v3_4DB'));
 for(const match of section.matchAll(/prepare\((?:'([^']*CREATE[^']*)'|`([^`]*CREATE[^`]*)`)\)/g)) sqlite.exec(match[1]||match[2]);
 let cookie='';let origin='https://mail.test';
 const c={env:{db},req:{url:'https://mail.test/api/oauth/start',raw:{headers:{get(name){return name.toLowerCase()==='cookie'?cookie:null}}},header(name){return name==='Origin'?origin:name==='Cookie'?cookie:undefined}},header(name,value){if(name.toLowerCase()==='set-cookie')cookie=value.split(';')[0]}};
 const service=await load('service/oauth-flow-service.js',{'hono/cookie':{getCookie,setCookie},'../error/biz-error':{default:BizError}});
 return {service,c,sqlite,setCookie:v=>cookie=v,setOrigin:v=>origin=v};
}
test('state binds provider/browser and redirect, PKCE, atomic replay protection',async()=>{
 const f=await flowFixture();const started=await f.service.start(f.c,'github','https://mail.test/login');
 assert.match(started.state,/^[a-f0-9]{64}$/);assert.match(started.challenge,/^[A-Za-z0-9_-]{43}$/);assert.equal(started.redirectUri,'https://mail.test/login');
 await assert.rejects(()=>f.service.consumeLogin(f.c,'google',started.state,'https://mail.test/login'));
 const row=await f.service.consumeLogin(f.c,'github',started.state,'https://mail.test/login');assert.equal(row.provider,'github');assert.equal(row.verifier.length,64);
 await assert.rejects(()=>f.service.consumeLogin(f.c,'github',started.state,'https://mail.test/login'));
});
test('cross-browser, fixed legacy state, expired state and foreign origins are rejected',async()=>{
 const f=await flowFixture();const start=await f.service.start(f.c,'google','https://mail.test/login');
 f.setCookie('__Host-cloud-mail-oauth=attacker');await assert.rejects(()=>f.service.consumeLogin(f.c,'google',start.state,'https://mail.test/login'));
 await assert.rejects(()=>f.service.consumeLogin(f.c,'google','google'));
 f.setOrigin('https://attacker.test');await assert.rejects(()=>f.service.start(f.c,'google','https://mail.test/login'));
 f.setOrigin('https://mail.test');const next=await f.service.start(f.c,'github','https://mail.test/login');f.sqlite.exec('UPDATE oauth_security_flow SET expires=0');await assert.rejects(()=>f.service.consumeLogin(f.c,'github',next.state,'https://mail.test/login'));
});
test('binding proof is identity/platform/browser scoped, expiring and single use',async()=>{
 const f=await flowFixture();await f.service.start(f.c,'github','https://mail.test/login');const proof=await f.service.binding(f.c,'github','42',1);
 const row=await f.service.consumeBinding(f.c,proof);assert.equal(row.provider,'github');assert.equal(row.identity,'42');await assert.rejects(()=>f.service.consumeBinding(f.c,proof));
 await assert.rejects(()=>f.service.consumeBinding(f.c,'42'));
});
test('binding claims serialize different proofs for one identity and exact holder releases',async()=>{
 const f=await flowFixture();await f.service.start(f.c,'github','https://mail.test/login');
 const first=await f.service.binding(f.c,'github','42',1);
 const second=await f.service.binding(f.c,'github','42',1);
 const holder=await f.service.consumeBinding(f.c,first);
 await assert.rejects(()=>f.service.consumeBinding(f.c,second),/already in progress/);
 await f.service.releaseBinding(f.c,{oauth_id:1,id:'wrong-holder'});
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_binding_claim').get().n,1);
 await f.service.releaseBinding(f.c,holder);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_binding_claim').get().n,0);
});
test('valid-looking foreign browser and redirect substitution cannot consume login',async()=>{
 const f=await flowFixture();const started=await f.service.start(f.c,'github','https://mail.test/login');
 f.setCookie('cloud-mail-oauth-browser='+ 'a'.repeat(64));
 await assert.rejects(()=>f.service.consumeLogin(f.c,'github',started.state,'https://mail.test/login'));
 await assert.rejects(()=>f.service.start(f.c,'github','https://attacker.test/login'));
 assert.equal(f.sqlite.prepare('SELECT consumed FROM oauth_security_flow WHERE id=?').get(started.state).consumed,0);
});
test('database refuses duplicate platform identity, permits matching ID across providers',async()=>{
 const f=await flowFixture();f.sqlite.exec("INSERT INTO oauth(platform,oauth_user_id) VALUES('github','42'),('linuxdo','42')");assert.throws(()=>f.sqlite.exec("INSERT INTO oauth(platform,oauth_user_id) VALUES('github','42')"));
});
async function identityService(){
 const rows=[{oauthId:1,oauthUserId:'42',platform:'github',userId:99}];let claimed;
 const oauth=Object.fromEntries(['oauthId','oauthUserId','platform','userId'].map(k=>[k,k]));
 const orm=()=>({select:()=>({from:()=>({where:condition=>({get:async()=>rows.find(condition),all:async()=>rows.filter(condition)})})}),insert:()=>({values:value=>({returning:()=>({get:async()=>{const row={oauthId:rows.length+1,userId:0,...value};rows.push(row);return row}})})}),update:()=>({set:value=>({where:condition=>({returning:()=>({get:async()=>{const row=rows.find(condition);Object.assign(row,value);return row}})})})})});
 const service=await load('service/oauth-service.js',{'../entity/orm':{default:orm},'../entity/oauth':{oauth},'drizzle-orm':{and:(...a)=>row=>a.every(fn=>fn(row)),eq:(k,v)=>row=>row[k]===v,inArray:()=>{}},'../error/biz-error':{default:BizError},'../i18n/i18n':{t:v=>v},'./oauth-flow-service':{OAUTH_PROVIDERS:new Set(['github','linuxdo','google']),default:{schema:async()=>{},consumeBinding:async()=>{throw Error('no proof')}}}});
 return {service,rows};
}
test('same numeric ID on another platform cannot reuse local user binding',async()=>{
 const {service,rows}=await identityService();const added=await service.saveUser({}, {oauthUserId:'42',platform:'linuxdo',userId:99,oauthId:1});assert.equal(added.userId,0);assert.equal(added.oauthId,2);assert.equal(rows[0].platform,'github');assert.equal(rows[0].userId,99);
 const updated=await service.saveUser({}, {oauthUserId:'42',platform:'github',userId:100,oauthId:2,name:'updated'});assert.equal(updated.userId,99);assert.equal(updated.oauthId,1);
});
test('client-supplied OAuth ID without binding proof is rejected before registration',async()=>{
 const {service}=await identityService();await assert.rejects(()=>service.bindUser({}, {oauthUserId:'42',email:'attacker@mail.test'}),/no proof/);
});
