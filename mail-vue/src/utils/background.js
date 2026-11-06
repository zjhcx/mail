/** Resolve a configured background using the same URL rules as cvtR2Url. */
export function getBackgroundStyle(background, r2Domain) {
  if (!background) return {}

  let url = background
  if (!background.startsWith('https://') && !background.startsWith('http://')) {
    if (!r2Domain) {
      url = '/' + String(background).replace(/^\//, '')
    } else if (!r2Domain.startsWith('http')) {
      url = 'https://' + r2Domain + '/' + background
    } else {
      const domain = r2Domain.endsWith('/') ? r2Domain.slice(0, -1) : r2Domain
      url = domain + '/' + background
    }
  }

  return {
    backgroundImage: `url(${JSON.stringify(url)})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  }
}
