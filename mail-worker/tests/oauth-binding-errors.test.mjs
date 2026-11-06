import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('existing target email rejects and releases claim before attempting registration', async () => {
 let released=0, registered=0;
 const context=vm.createContext({console});
 const mocks={
  '../error/biz-error':{default:class extends Error{}},
  '../entity/oauth':{oauth:{}},
  'drizzle-orm':{and(){},eq(){},inArray(){}},
  '../i18n/i18n':{t:v=>v},
  './oauth-flow-service':{OAUTH_PROVIDERS:new Set(['github']),default:{consumeBinding:async()=>({provider:'github',identity:'42',oauth_id:1}),releaseBinding:async()=>{released++;}}},
  './setting-service':{default:{query:async()=>({githubSwitch:0})}},
  './user-service':{default:{selectByEmailIncludeDel:async()=>({userId:99})}},
  './login-service':{default:{register:async()=>{registered++;}}}
 };
 const module=new vm.SourceTextModule(await readFile(new URL('../src/service/oauth-service.js',import.meta.url),'utf8'),{context});
 await module.link(async name=>{const values=mocks[name]||{default:{}};return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});});
 await module.evaluate();
 const service=module.namespace.default;
 service.getById=async()=>({oauthId:1,userId:0});
 await assert.rejects(()=>service.bindUser({}, {email:'existing@example.test',bindToken:'proof'}),/already exists/);
 assert.equal(released,1);
 assert.equal(registered,0);
});
