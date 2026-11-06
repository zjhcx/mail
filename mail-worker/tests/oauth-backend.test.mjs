import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
async function load(file,mocks={}){
 const context=vm.createContext({crypto,TextEncoder,btoa,Date,URL,URLSearchParams,console});
 const module=new vm.SourceTextModule(await readFile(new URL('../src/'+file,import.meta.url),'utf8'),{context});
 await module.link(async name=>{const values=mocks[name]||{default:{}};return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});});await module.evaluate();return module.namespace;
}
class BizError extends Error{}
async function fixture(){
 const db=new DatabaseSync(':memory:');
 const migration=await readFile(new URL('../src/init/init.js',import.meta.url),'utf8');const section=migration.slice(migration.indexOf('async oauthSecurityDB'),migration.indexOf('async v3_4DB'));
 db.exec('CREATE TABLE oauth(oauth_id INTEGER PRIMARY KEY,platform TEXT,oauth_user_id TEXT)');
 for(const m of section.matchAll(/prepare\((?:'([^']*CREATE[^']*)'|`([^`]*CREATE[^`]*)`)\)/g))db.exec(m[1]||m[2]);
 const binding={prepare(sql){let args=[];return{bind(...values){args=values;return this;},async run(){return db.prepare(sql).run(...args);},async first(){return db.prepare(sql).get(...args)||null;}};}};
 let cookie;let options;const service=(await load('service/oauth-flow-service.js',{'hono/cookie':{getCookie:()=>cookie,setCookie:(_c,_n,v,o)=>{cookie=v;options=o;}},'../error/biz-error':{default:BizError}})).default;
 const c={env:{db:binding},req:{url:'https://mail.test/api/oauth/start',header:()=> 'https://mail.test'}};
 return{service,c,db,get cookie(){return cookie;},set cookie(v){cookie=v;},get options(){return options;}};
}
test('OAuth browser flow validates redirect, provider, random state, cookie, origin and atomically consumes',async()=>{
 const f=await fixture();const flow=await f.service.start(f.c,'github','https://mail.test/login');
 assert.match(flow.state,/^[a-f0-9]{64}$/);assert.match(flow.challenge,/^[A-Za-z0-9_-]{43}$/);assert.equal(f.options.path,'/api/oauth');assert.equal(f.options.httpOnly,true);assert.equal(f.options.sameSite,'Lax');assert.equal(f.options.secure,true);
 const cookie=f.cookie;f.cookie='f'.repeat(64);await assert.rejects(()=>f.service.consumeLogin(f.c,'github',flow.state,flow.redirectUri));f.cookie=cookie;
 await assert.rejects(()=>f.service.consumeLogin(f.c,'google',flow.state,flow.redirectUri));await assert.rejects(()=>f.service.consumeLogin(f.c,'github',flow.state,'https://evil.test/login'));
 await assert.rejects(()=>f.service.consumeLogin({...f.c,req:{...f.c.req,header:()=> 'https://evil.test'}},'github',flow.state,flow.redirectUri));
 assert.equal((await f.service.consumeLogin(f.c,'github',flow.state,flow.redirectUri)).consumed,1);await assert.rejects(()=>f.service.consumeLogin(f.c,'github',flow.state,flow.redirectUri));
});
test('two valid binding proofs cannot concurrently claim the same identity and all proofs are single use',async()=>{
 const f=await fixture();await f.service.start(f.c,'github','https://mail.test/login');
 const a=await f.service.binding(f.c,'github','42',1),b=await f.service.binding(f.c,'github','42',1);
 const claim=await f.service.consumeBinding(f.c,a);assert.equal(claim.oauth_id,1);await assert.rejects(()=>f.service.consumeBinding(f.c,a));await assert.rejects(()=>f.service.consumeBinding(f.c,b));
 await f.service.releaseBinding(f.c,claim);const next=await f.service.binding(f.c,'github','42',1);assert.ok(await f.service.consumeBinding(f.c,next));
});
test('expired and uninitialized flows fail closed, identity index rejects duplicates but permits platform separation',async()=>{
 const f=await fixture();f.db.exec("INSERT INTO oauth(platform,oauth_user_id) VALUES('github','42'),('linuxdo','42')");assert.throws(()=>f.db.exec("INSERT INTO oauth(platform,oauth_user_id) VALUES('github','42')"));
 const flow=await f.service.start(f.c,'github','https://mail.test/login');f.db.exec('UPDATE oauth_security_flow SET expires=0');await assert.rejects(()=>f.service.consumeLogin(f.c,'github',flow.state,flow.redirectUri));
 f.db.exec('DROP TABLE oauth_security_flow');await assert.rejects(()=>f.service.start(f.c,'github','https://mail.test/login'));
});
test('scheduled cleanup preserves pending proofs and binding claims, then removes idle identities',async()=>{
 const f=await fixture();
 f.db.exec("ALTER TABLE oauth ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0; INSERT INTO oauth(oauth_id,platform,oauth_user_id,user_id) VALUES(1,'github','1',0),(2,'github','2',0),(3,'github','3',0),(4,'github','4',9)");
 await f.service.start(f.c,'github','https://mail.test/login');
 const pending=await f.service.binding(f.c,'github','1',1);
 const claimed=await f.service.binding(f.c,'github','2',2);
 await f.service.consumeBinding(f.c,claimed);
 const cleanup=(await load('service/oauth-service.js',{'../entity/oauth':{oauth:{}},'drizzle-orm':{and(){},eq(){},inArray(){}},'../i18n/i18n':{t:v=>v},'./oauth-flow-service':{default:{},OAUTH_PROVIDERS:new Set(['github'])}})).default;
 await cleanup.clearNoBindOathUser(f.c);
 assert.deepEqual(f.db.prepare('SELECT oauth_id FROM oauth ORDER BY oauth_id').all().map(row=>row.oauth_id),[1,2,4]);
 f.db.prepare('UPDATE oauth_security_flow SET expires=0 WHERE id=?').run(pending);
 await cleanup.clearNoBindOathUser(f.c);
 assert.deepEqual(f.db.prepare('SELECT oauth_id FROM oauth ORDER BY oauth_id').all().map(row=>row.oauth_id),[2,4]);
});
async function identities(rows=[]){
 let saved,registered,logged=0;const columns=Object.fromEntries(['oauthId','oauthUserId','platform','userId'].map(k=>[k,k]));
 const orm=()=>({select:()=>({from:()=>({where:p=>({all:async()=>rows.filter(p)})})}),insert:()=>({values:v=>{saved=v;return{returning:()=>({get:async()=>({...v,oauthId:99,userId:0})})};}}),update:()=>({set:v=>{saved=v;return{where:p=>({returning:()=>({get:async()=>{const row=rows.find(p);if(row)Object.assign(row,v);return row;}})})};}})});
 const module=await load('service/oauth-service.js',{'../entity/orm':{default:orm},'../entity/oauth':{oauth:columns},'drizzle-orm':{eq:(k,v)=>r=>r[k]===v,and:(...p)=>r=>p.every(fn=>fn(r)),inArray:()=>{}},'../error/biz-error':{default:BizError},'../i18n/i18n':{t:v=>v},'./oauth-flow-service':{OAUTH_PROVIDERS:new Set(['github','google','linuxdo']),default:{consumeBinding:async()=>({id:'flow',provider:'github',identity:'42',oauth_id:1}),releaseBinding:async()=>{}}},'./setting-service':{default:{query:async()=>({githubSwitch:0})}},'../utils/crypto-utils':{default:{genRandomPwd:()=> 'secure-random-password'}},'./login-service':{default:{register:async(...v)=>{registered=v;},login:async()=>{logged++;return 'jwt';}}},'./user-service':{default:{selectByEmailIncludeDel:async()=>undefined,selectByEmail:async()=>({userId:7,email:'new@mail.test'})}}});
 return{service:module.default,identity:module.providerIdentity,get saved(){return saved;},get registered(){return registered;},get logged(){return logged;}};
}
test('platform+ID is authoritative, malformed IDs reject, provider profile cannot overwrite local binding',async()=>{
 const f=await identities([{oauthId:1,oauthUserId:'42',platform:'github',userId:8},{oauthId:2,oauthUserId:'42',platform:'linuxdo',userId:9}]);
 assert.equal((await f.service.getById({},'42','github')).userId,8);assert.equal((await f.service.getById({},'42','linuxdo')).userId,9);
 for(const id of [null,undefined,'undefined','null',0,-1,1.5,{},Number.MAX_SAFE_INTEGER+1])assert.throws(()=>f.identity('github',id));
 await f.service.saveUser({}, {platform:'google',oauthUserId:'42',userId:999,oauthId:999,name:'profile'});assert.equal(f.saved.userId,undefined);assert.equal(f.saved.oauthId,undefined);
 const dup=await identities([{platform:'github',oauthUserId:'42'},{platform:'github',oauthUserId:'42'}]);await assert.rejects(()=>dup.service.getById({},'42','github'));
});
test('binding passes CAPTCHA/invite to ordinary registration, ignores supplied identity and binds exact row',async()=>{
 const f=await identities([{oauthId:1,platform:'github',oauthUserId:'42',userId:0}]);
 const result=await f.service.bindUser({}, {email:'new@mail.test',bindToken:'proof',code:'invite',token:'captcha',oauthUserId:'attacker'});
 assert.equal(f.registered.length,2);assert.equal(f.registered[1].token,'captcha');assert.equal(f.registered[1].code,'invite');assert.equal(result.userInfo.userId,7);assert.equal(f.logged,1);
});
