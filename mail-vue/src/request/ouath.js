import http from '@/axios/index.js';

export function oauthStart(provider, redirectUri) {
    return http.post('/oauth/start', {provider, redirectUri})
}

export function oauthLinuxDoLogin(code, redirectUri, state) {
    return http.post('/oauth/linuxDo/login', {code, redirectUri, state})
}

export function oauthGithubLogin(code, redirectUri, state) {
    return http.post('/oauth/github/login', {code, redirectUri, state})
}

export function oauthGoogleLogin(code, redirectUri, state) {
    return http.post('/oauth/google/login', {code, redirectUri, state})
}

export function oauthBindUser(form) {
    return http.put('/oauth/bindUser', form)
}
