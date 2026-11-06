import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {rememberOAuth, consumeOAuthCallback, registrationNeedsVerification, OAUTH_STORAGE_KEY} from './src/utils/oauth-flow.js'

const origin='https://mail.example.test', redirect=origin+'/login', state='a'.repeat(64), now=1234567890000
function fixture(provider='github') {
 const values=new Map(), storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}
 const hosts={github:'https://github.com/login/oauth/authorize',linuxdo:'https://connect.linux.do/oauth2/authorize',google:'https://accounts.google.com/o/oauth2/v2/auth'}
 const url=new URL(hosts[provider]);url.searchParams.set('state',state);url.searchParams.set('redirect_uri',redirect);url.searchParams.set('code_challenge_method','S256');url.searchParams.set('code_challenge','challenge')
 return {storage,values,response:{state,authorizationUrl:url.href},provider}
}
function start(f){return rememberOAuth(f.storage,f.provider,redirect,f.response,origin,now)}
test('authorization is server supplied and constrained to provider origin and state',()=>{
 for(const provider of ['github','google','linuxdo']){const f=fixture(provider);assert.equal(start(f),f.response.authorizationUrl);const saved=JSON.parse(f.storage.getItem(OAUTH_STORAGE_KEY));assert.deepEqual(saved,{provider,state,redirectUri:redirect,createdAt:now})}
})
test('foreign, wrong-provider, credentials, missing PKCE and mismatched state responses rejected',()=>{
 for(const mutate of [u=>u.hostname='attacker.test',u=>u.hostname='accounts.google.com',u=>u.username='user',u=>u.searchParams.delete('code_challenge'),u=>u.searchParams.append('state',state),u=>u.searchParams.set('redirect_uri','https://attacker.test/login')]){const f=fixture();const u=new URL(f.response.authorizationUrl);mutate(u);f.response.authorizationUrl=u.href;assert.throws(()=>start(f));assert.equal(f.storage.getItem(OAUTH_STORAGE_KEY),null)}
})
test('valid callback uses stored provider and consumes record exactly once',()=>{
 const f=fixture();start(f);assert.deepEqual(consumeOAuthCallback(f.storage,'?code=abc&state='+state,origin,now+1000),{provider:'github',state,redirectUri:redirect,code:'abc'});assert.equal(f.storage.getItem(OAUTH_STORAGE_KEY),null);assert.throws(()=>consumeOAuthCallback(f.storage,'?code=abc&state='+state,origin,now+1001))
})
test('malformed callbacks are consumed and never produce a provider/code request',()=>{
 for(const query of ['?code=x&state=github','?code=x&state='+state+'&state='+state,'?code=x&code=y&state='+state,'?code=&state='+state,'?state='+state,'?error=denied&state='+state,'?code=x']){const f=fixture();start(f);assert.throws(()=>consumeOAuthCallback(f.storage,query,origin,now));assert.equal(f.storage.getItem(OAUTH_STORAGE_KEY),null)}
})
test('stale, future, cross-origin and corrupt session records rejected',()=>{
 for(const mutate of [p=>p.createdAt=now-600000,p=>p.createdAt=now+1,p=>p.provider='attacker',p=>p.redirectUri='https://attacker.test/login',p=>p.state='b'.repeat(64),p=>p.createdAt='now']){const f=fixture();start(f);const p=JSON.parse(f.storage.getItem(OAUTH_STORAGE_KEY));mutate(p);f.storage.setItem(OAUTH_STORAGE_KEY,JSON.stringify(p));assert.throws(()=>consumeOAuthCallback(f.storage,'?code=x&state='+state,origin,now));assert.equal(f.storage.getItem(OAUTH_STORAGE_KEY),null)}
 const f=fixture();f.storage.setItem(OAUTH_STORAGE_KEY,'{broken');assert.throws(()=>consumeOAuthCallback(f.storage,'?code=x&state='+state,origin,now))
})
test('ordinary page view does not consume outstanding login',()=>{const f=fixture();start(f);assert.equal(consumeOAuthCallback(f.storage,'',origin,now),null);assert.ok(f.storage.getItem(OAUTH_STORAGE_KEY))})
test('verification policy same for registration and binding including count mode',()=>{assert.equal(registrationNeedsVerification({registerVerify:0}),true);assert.equal(registrationNeedsVerification({registerVerify:1}),false);assert.equal(registrationNeedsVerification({registerVerify:2,regVerifyOpen:false}),false);assert.equal(registrationNeedsVerification({registerVerify:2,regVerifyOpen:true}),true)})
test('request API forwards redirectUri/state and binding proof but no client identity',async()=>{
 const source=await readFile(new URL('./src/request/ouath.js',import.meta.url),'utf8');assert.doesNotMatch(source,/oauthUserId/);assert.match(source,/\{provider, redirectUri\}/);assert.equal((source.match(/\{code, redirectUri, state\}/g)||[]).length,3)
 const page=await readFile(new URL('./src/views/login/index.vue',import.meta.url),'utf8');assert.doesNotMatch(page,/oauthUserId|bindingToken|data\.url|state=\$\{provider\}/);assert.match(page,/consumeOAuthCallback\(sessionStorage/);assert.match(page,/bindToken: bindForm\.bindToken/);assert.match(page,/const form = \{email, bindToken: bindForm\.bindToken, code: bindForm\.code, token: verifyToken\}/)
})
