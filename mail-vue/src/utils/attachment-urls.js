import http from '@/axios/index.js'
import DOMPurify from 'dompurify'

// Capability URLs live only in memory, never in the mail store or drafts.
const cache = new Map()
let cacheOwner = null
const MAX_AGE = 2 * 60 * 1000 // refresh comfortably before the five-minute server expiry
const URL_ATTRS = ['src', 'href', 'poster', 'background', 'xlink:href', 'data-mce-src', 'data-mce-href']

export function attachmentKey(value) {
    if (!value || typeof value !== 'string') return null
    let path = value.trim().replace(/^\{\{domain\}\}\/?/, '/')
    try {
        path = decodeURIComponent(new URL(path, window.location.origin + '/').pathname)
    } catch { return null }
    path = path.replace(/^\/(?:api\/)?oss\//, '/').replace(/^\//, '')
    if (!path.startsWith('attachments/')) return null
    if (!/^attachments\/[A-Za-z0-9._-]+$/.test(path)) return null
    return path
}

export async function attachmentUrls(keys) {
    const owner = localStorage.getItem('token')
    if (owner !== cacheOwner) {
        cache.clear()
        cacheOwner = owner
    }
    if (!owner) throw new Error('Attachment authentication required')
    const unique = [...new Set(keys)]
    if (unique.some(key => attachmentKey(key) !== key)) throw new Error('Invalid attachment key')
    const missing = unique.filter(key => !cache.has(key) || cache.get(key).expires <= Date.now())
    for (let i = 0; i < missing.length; i += 50) {
        const batch = missing.slice(i, i + 50)
        const data = await http.post('/attachment/urls', {keys: batch}, {noMsg: true})
        if (localStorage.getItem('token') !== owner) throw new Error('Attachment session changed')
        for (const key of batch) {
            const value = data?.urls?.[key]
            const url = value && new URL(value, window.location.origin)
            // Never accept a CDN fallback or expose the login JWT in an image URL.
            if (!url || url.origin !== window.location.origin || attachmentKey(url.href) !== key ||
                !url.searchParams.get('token') || url.searchParams.get('token') === owner) {
                throw new Error('Invalid signed attachment response')
            }
            cache.set(key, {url: url.href, expires: Date.now() + MAX_AGE})
        }
    }
    return Object.fromEntries(unique.map(key => [key, cache.get(key).url]))
}

export async function attachmentUrl(key) {
    const normalized = attachmentKey(key)
    if (!normalized) throw new Error('Invalid attachment key')
    return (await attachmentUrls([normalized]))[normalized]
}

function transformHtml(html, replacement) {
    if (!html) return ''
    const doc = new DOMParser().parseFromString(html || '', 'text/html')
    const css = value => value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => {
        const key = attachmentKey(url)
        return key ? `url("${replacement(key)}")` : match
    })
    for (const el of doc.querySelectorAll('*')) {
        for (const attr of URL_ATTRS) {
            const value = el.getAttribute(attr)
            const key = attachmentKey(value)
            if (key) el.setAttribute(attr, replacement(key))
        }
        // Do not leave alternate, unsigned image candidates in the browser.
        if (/attachments(?:\/|%2f)/i.test(el.getAttribute('srcset') || '')) el.removeAttribute('srcset')
        if (el.hasAttribute('style')) el.setAttribute('style', css(el.getAttribute('style')))
        if (el.tagName === 'STYLE') el.textContent = css(el.textContent)
    }
    return doc.documentElement.outerHTML
}

export function restoreAttachmentKeys(html) {
    return transformHtml(html, key => key)
}

export async function formatAttachmentHtml(html) {
    if (!html) return ''
    const safe = DOMPurify.sanitize(html, {WHOLE_DOCUMENT: true, ADD_ATTR: ['target']})
    const keys = new Set()
    transformHtml(safe, key => { keys.add(key); return '' })
    // Failure is closed: callers must not render the original unsigned HTML.
    const urls = keys.size ? await attachmentUrls([...keys]) : {}
    return DOMPurify.sanitize(transformHtml(safe, key => urls[key]), {
        WHOLE_DOCUMENT: true, ADD_ATTR: ['target']
    })
}
